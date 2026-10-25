import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"

import { Logger } from "@/shared/services/Logger"
import { type ExperimentSession, experimentLogRoot, readActiveExperiment } from "../ExperimentSession"

/**
 * 运行痕迹采集（P1-2）
 *
 * 学生在写代码时会反复「跑一下看看」，这些失败与输出是出题最好的素材：
 * 报错名、行号、他们怎么试错的——但**只靠行为日志拿不到**（日志记的是 AI 对话，不是终端）。
 *
 * 实现要点：
 *   ① 用 shell integration 的 onDidStart/onDidEnd 事件拿 `commandLine` 与 `exitCode`
 *   ② `execution.read()` 是异步流，必须在 start 时就开始读，否则 end 时已经流干（官方示例同样如此）
 *   ③ 只记**尾部**输出（默认 1200 字），并剥掉 ANSI 转义，避免把整屏进度条写进 jsonl
 *   ④ shell integration 不可用（旧 VS Code / Cursor / 用户关了）时整体降级：不写文件、不报错，
 *      提交侧 readRunTraces 自然读到空数组（RT-2）
 *   ⑤ 文件写在 `<工作区>/.cline-logs/run_traces.jsonl`，与 SubmissionPackager.readRunTraces 对齐
 */

export const RUN_TRACE_DIR = ".cline-logs"
export const RUN_TRACE_FILE = "run_traces.jsonl"

const MAX_TAIL_CHARS = 1200
const MAX_BUFFER_CHARS = 20000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const KEEP_LINES_ON_TRIM = 300

/** 与 SubmissionPackager 读到的字段保持一致 */
export interface RunTraceRecord {
	ts: string
	command: string
	exit_code: number | null
	stdout_tail: string
	shell?: string
	cwd?: string
}

interface ExecutionLike {
	commandLine?: { value?: string }
	cwd?: vscode.Uri
	read?: () => AsyncIterable<string>
}

interface ShellExecutionEventLike {
	execution?: ExecutionLike
	terminal?: vscode.Terminal
}

interface ShellEndEventLike extends ShellExecutionEventLike {
	exitCode?: number | null
}

interface ShellIntegrationWindow {
	onDidStartTerminalShellExecution?: (listener: (e: ShellExecutionEventLike) => unknown) => vscode.Disposable
	onDidEndTerminalShellExecution?: (listener: (e: ShellEndEventLike) => unknown) => vscode.Disposable
}

interface PendingExecution {
	command: string
	cwd?: string
	chunks: string[]
	startedAt: number
	exitCode: number | null
}

/** 去掉颜色/光标控制序列；顺带把 \r 归一到 \n，防止进度条把一行刷成几千字符 */
export function stripAnsi(text: string): string {
	return text
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b\][^\u0007]*\u0007/g, "")
		.replace(/\r\n?/g, "\n")
}

/** 取尾部若干字符（按行对齐，避免截断半个字符） */
export function tailOf(text: string, maxChars = MAX_TAIL_CHARS): string {
	const clean = stripAnsi(text)
	if (clean.length <= maxChars) return clean.trim()
	const cut = clean.slice(clean.length - maxChars)
	const firstNewline = cut.indexOf("\n")
	return (firstNewline >= 0 ? cut.slice(firstNewline + 1) : cut).trim()
}

/** 定位这条命令属于哪个工作区（优先 cwd 命中，其次命令里的路径，最后单工作区兜底） */
export function pickWorkspaceRoot(cwd: string | undefined, folders: readonly vscode.WorkspaceFolder[]): string | null {
	if (folders.length === 0) return null
	if (cwd) {
		const normalized = cwd.replace(/\\/g, "/").toLowerCase()
		const hit = folders.find((f) => {
			const root = f.uri.fsPath.replace(/\\/g, "/").toLowerCase()
			return normalized === root || normalized.startsWith(`${root}/`)
		})
		if (hit) return hit.uri.fsPath
	}
	return folders.length === 1 ? folders[0].uri.fsPath : null
}

/**
 * 运行痕迹应该写到哪个目录（Task3）。
 *
 * 有活动实验会话时写 `experiments/<id>/`，否则写工作区根。放在写入时判断而不是
 * 启动时缓存：学生可能先在自由模式跑命令，点「开始实验」之后才跑实验代码，此时
 * 采集器不需要重启也能改道。
 */
export function resolveRunTraceRoot(
	workspaceRoot: string,
	sessionReader: (root: string) => ExperimentSession | null = readActiveExperiment,
): string {
	if (!workspaceRoot) return workspaceRoot
	try {
		const session = sessionReader(workspaceRoot)
		return session ? experimentLogRoot(workspaceRoot, session.assignmentId) : workspaceRoot
	} catch {
		// 会话文件读挂 → 退回工作区根：运行痕迹是辅助信号，不能阻断终端使用
		return workspaceRoot
	}
}

export class RunTraceCollector implements vscode.Disposable {	private disposables: vscode.Disposable[] = []
	private pending = new Map<ExecutionLike, PendingExecution>()
	private available = false
	private started = false

	/** shell integration 是否可用（不可用时提交侧拿不到运行痕迹，但不影响提交） */
	get isAvailable(): boolean {
		return this.available
	}

	start(): void {
		if (this.started) return
		this.started = true

		const win = vscode.window as unknown as ShellIntegrationWindow
		if (typeof win.onDidStartTerminalShellExecution !== "function") {
			Logger.log("[RunTraceCollector] 当前 VS Code 不支持 shell integration，运行痕迹采集关闭")
			return
		}
		if (typeof win.onDidEndTerminalShellExecution !== "function") {
			// 没有 end 事件就拿不到 exitCode，只记 stdout 意义不大，索性整体关闭（RT-2）
			Logger.log("[RunTraceCollector] 缺少 onDidEndTerminalShellExecution，运行痕迹采集关闭")
			return
		}

		try {
			const startDisposable = win.onDidStartTerminalShellExecution((event) => this.handleStart(event))
			const endDisposable = win.onDidEndTerminalShellExecution((event) => this.handleEnd(event))
			if (startDisposable) this.disposables.push(startDisposable)
			if (endDisposable) this.disposables.push(endDisposable)
			this.available = true
		} catch (error) {
			Logger.warn("[RunTraceCollector] 注册 shell integration 监听失败", error as Error)
			this.available = false
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			try {
				disposable.dispose()
			} catch {
				// 忽略
			}
		}
		this.disposables = []
		this.pending.clear()
		this.available = false
		this.started = false
	}

	private handleStart(event: ShellExecutionEventLike): void {
		const execution = event?.execution
		if (!execution) return

		const entry: PendingExecution = {
			command: execution.commandLine?.value?.trim() ?? "",
			cwd: execution.cwd?.fsPath,
			chunks: [],
			startedAt: Date.now(),
			exitCode: null,
		}
		;(this.pending as Map<ExecutionLike, PendingExecution>).set(execution, entry)

		// 必须在 start 阶段就开始消费流：等到 end 再 read() 通常已经拿不到内容
		void this.consume(execution, entry)
	}

	private async consume(execution: ExecutionLike, entry: PendingExecution): Promise<void> {
		if (typeof execution.read !== "function") return
		try {
			for await (const chunk of execution.read()) {
				entry.chunks.push(chunk)
				// 长输出只保留尾部，避免一次 apt/pip 安装把内存与文件都撑爆
				const size = entry.chunks.reduce((sum, c) => sum + c.length, 0)
				if (size > MAX_BUFFER_CHARS) {
					const joined = entry.chunks.join("").slice(-MAX_BUFFER_CHARS)
					entry.chunks = [joined]
				}
			}
		} catch (error) {
			Logger.log(`[RunTraceCollector] 读取终端输出失败: ${(error as Error).message}`)
		}
	}

	private handleEnd(event: ShellEndEventLike): void {
		const execution = event?.execution
		if (!execution) return
		const entry = (this.pending as Map<ExecutionLike, PendingExecution>).get(execution)
		if (!entry) return
		;(this.pending as Map<ExecutionLike, PendingExecution>).delete(execution)

		const record: RunTraceRecord = {
			ts: new Date().toISOString(),
			command: entry.command,
			exit_code: typeof event.exitCode === "number" ? event.exitCode : null,
			stdout_tail: tailOf(entry.chunks.join("")),
			cwd: entry.cwd,
		}

		// 学习曲线：纯粹看目录/清屏这类「成功且没有任何输出」的命令不值得记（也避免刷爆文件）
		if (record.command.length < 2) return
		if (record.stdout_tail.length === 0 && record.exit_code === 0) return

		const root = pickWorkspaceRoot(entry.cwd, vscode.workspace.workspaceFolders ?? [])
		if (!root) return
		this.append(resolveRunTraceRoot(root), record)
	}

	private append(workspaceRoot: string, record: RunTraceRecord): void {
		const dir = path.join(workspaceRoot, RUN_TRACE_DIR)
		const file = path.join(dir, RUN_TRACE_FILE)
		try {
			fs.mkdirSync(dir, { recursive: true })
			fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8")
			this.trimIfTooLarge(file)
		} catch (error) {
			Logger.warn("[RunTraceCollector] 写入运行痕迹失败", error as Error)
		}
	}

	/** 文件超过 2MB 时只留最后 300 行：痕迹是辅助信号，不需要留全史 */
	private trimIfTooLarge(file: string): void {
		try {
			const stat = fs.statSync(file)
			if (stat.size <= MAX_FILE_BYTES) return
			const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean)
			fs.writeFileSync(file, `${lines.slice(-KEEP_LINES_ON_TRIM).join("\n")}\n`, "utf8")
		} catch {
			// 裁剪失败不影响下次追加
		}
	}
}
