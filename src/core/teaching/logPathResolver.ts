/**
 * =============================================================================
 *  logPathResolver — 学生行为日志路径解析（纯逻辑，无 vscode 依赖）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【为什么单独抽一个文件】
 * 需求 1：过去 `scripts/analyze-student-log.ts` 把默认日志路径写死为
 * `D:\cline-test\.cline-logs\student_interactions.log`，导致「换个工作区就分析不了」。
 * 现在默认路径必须跟随「当前工作区 / 当前目录」，而扩展侧（提交时需要读日志）
 * 与终端脚本（分析时需要读日志）必须用**同一条解析规则**，否则会出现
 * 「扩展上传的日志」和「终端分析的日志」不是同一个文件。
 *
 * 本文件不 import vscode / 不访问网络，所以：
 *   - `scripts/analyze-student-log.ts` 可直接 import（Node 类型擦除下用 `.ts` 后缀）
 *   - 单元测试可纯粹在临时目录里跑，不需要 VS Code 宿主
 *
 * 【解析链（优先级从高到低）】
 *   1. `arg`            显式传入的日志路径（位置参数 / `--log`）—— 传了就只认它
 *   2. `env`            `CLINE_STUDENT_LOG` 环境变量
 *   3. `workspace-arg`  终端脚本的 `--workspace <dir>`
 *   4. `workspace-root` VS Code 第一个工作区根目录（扩展侧）
 *   5. `cwd`            当前工作目录（终端脚本，即「在工作区里直接跑」）
 *   6. `cwd-ancestor`   上述默认路径不存在时，向上最多 4 级找 `.cline-logs/`
 *
 * 注意：**没有**任何写死的绝对路径兜底。找不到就是找不到，由调用方决定
 * 是报错（CLI）还是降级为空日志（扩展提交）。
 * =============================================================================
 */

import * as fs from "fs"
import * as path from "path"

/** 行为日志所在子目录（与 Cline 内部日志、看板格式保持一致） */
export const STUDENT_LOG_DIR = ".cline-logs"
/** 行为日志文件名（看板 backend 的默认读取对象） */
export const STUDENT_LOG_FILE = "student_interactions.log"
/** 相对路径：`.cline-logs/student_interactions.log` */
export const STUDENT_LOG_RELATIVE = `${STUDENT_LOG_DIR}/${STUDENT_LOG_FILE}`
/** 环境变量名：终端脚本可用它显式指定日志文件 */
export const STUDENT_LOG_ENV = "CLINE_STUDENT_LOG"

/**
 * 路径来源。用于向用户解释「这次读的是哪份日志」，
 * 也方便测试断言解析链是否按预期命中了某一级。
 */
export type LogPathSource = "arg" | "env" | "workspace-arg" | "workspace-root" | "cwd" | "cwd-ancestor"

export interface LogPathResolveInput {
	/** 显式日志路径（位置参数或 --log），相对路径按 cwd 展开 */
	logPathArg?: string | null
	/** 终端脚本的 --workspace：一个目录，自动拼 .cline-logs/student_interactions.log */
	workspaceArg?: string | null
	/** 环境变量值；传 undefined 时由调用方决定是否读取 process.env */
	envPath?: string | null
	/** VS Code 工作区根目录（扩展侧传入 workspaceFolders[0].uri.fsPath） */
	workspaceRoot?: string | null
	/** 基准目录，默认 process.cwd() */
	cwd?: string | null
	/** 向上回溯的最大层数，默认 4；测试可传 0 关闭回溯 */
	walkUpDepth?: number
}

export interface LogPathResolution {
	/** 解析出的日志文件绝对路径 */
	path: string
	/** 命中了解析链的哪一级 */
	source: LogPathSource
	/** 依次尝试过的候选路径（去重、保序），用于报错时给用户看 */
	candidates: string[]
	/** true = 走的是默认路径（没有显式指定），此时允许向上回溯 */
	isDefault: boolean
	/** 该路径此刻是否存在（是文件） */
	exists: boolean
}

/** 在给定目录下拼出默认日志文件路径 */
export function defaultStudentLogPath(baseDir: string): string {
	return path.join(baseDir, STUDENT_LOG_DIR, STUDENT_LOG_FILE)
}

/**
 * 归一化一个用户传入的「日志目标」：
 * - 相对路径 → 按 cwd 展开
 * - 传的是已存在的目录 → 自动补 `.cline-logs/student_interactions.log`
 * - 传的是以分隔符结尾的路径 → 同样视为目录
 */
export function expandLogTarget(input: string, cwd: string): string {
	const trimmed = input.trim()
	const abs = path.resolve(cwd, trimmed)
	const looksLikeDir = /[\\/]$/.test(trimmed)

	let isDir = looksLikeDir
	if (!isDir) {
		try {
			isDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory()
		} catch {
			isDir = false
		}
	}

	return isDir ? defaultStudentLogPath(abs) : abs
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile()
	} catch {
		return false
	}
}

function uniqPaths(paths: string[]): string[] {
	const seen = new Set<string>()
	const out: string[] = []
	for (const p of paths) {
		const key = process.platform === "win32" ? p.toLowerCase() : p
		if (seen.has(key)) continue
		seen.add(key)
		out.push(p)
	}
	return out
}

/**
 * 从 startDir 起向上逐级查找 `.cline-logs/student_interactions.log`。
 * 终端里常常在 `<workspace>/src/foo` 里跑命令，向上回溯能命中工作区根日志。
 */
export function findStudentLogByWalkingUp(startDir: string, maxDepth = 4): string | null {
	let current = path.resolve(startDir)
	const root = path.parse(current).root
	for (let depth = 0; depth <= maxDepth; depth++) {
		const candidate = defaultStudentLogPath(current)
		if (isFile(candidate)) return candidate
		const parent = path.dirname(current)
		if (parent === current || current === root) break
		current = parent
	}
	return null
}

/**
 * 按解析链算出日志路径。不会抛异常；找不到文件时 `exists: false`。
 *
 * 仅当**没有显式指定**路径（isDefault）且默认路径不存在时，才向上回溯；
 * 显式传了 `--log` 却不存在时绝不偷偷换成别的文件（避免分析错对象）。
 */
export function resolveLogPath(input: LogPathResolveInput): LogPathResolution {
	const cwd = path.resolve(input.cwd ?? process.cwd())

	// 1) 显式参数
	if (input.logPathArg && input.logPathArg.trim()) {
		const p = expandLogTarget(input.logPathArg, cwd)
		return { path: p, source: "arg", candidates: [p], isDefault: false, exists: isFile(p) }
	}

	const candidates: string[] = []

	// 2) 环境变量
	if (input.envPath && input.envPath.trim()) {
		const p = expandLogTarget(input.envPath, cwd)
		return { path: p, source: "env", candidates: [p], isDefault: false, exists: isFile(p) }
	}

	// 3) --workspace <dir>
	if (input.workspaceArg && input.workspaceArg.trim()) {
		const dir = path.resolve(cwd, input.workspaceArg.trim())
		const p = defaultStudentLogPath(dir)
		return { path: p, source: "workspace-arg", candidates: [p], isDefault: true, exists: isFile(p) }
	}

	// 4) VS Code 工作区根（扩展侧传入，属于「权威信号」：只认这个工作区，
	//    找不到就是找不到，绝不回退到别的工作区，避免上传错学生的日志）
	if (input.workspaceRoot) {
		const p = defaultStudentLogPath(path.resolve(input.workspaceRoot))
		return { path: p, source: "workspace-root", candidates: [p], isDefault: true, exists: isFile(p) }
	}

	// 5) cwd
	const cwdPath = defaultStudentLogPath(cwd)
	candidates.push(cwdPath)
	if (isFile(cwdPath)) {
		return { path: cwdPath, source: "cwd", candidates: uniqPaths(candidates), isDefault: true, exists: true }
	}

	// 6) 向上回溯（工作区根在上层目录时）
	const maxDepth = input.walkUpDepth ?? 4
	const walked = maxDepth > 0 ? findStudentLogByWalkingUp(cwd, maxDepth) : null
	if (walked) {
		candidates.push(walked)
		return { path: walked, source: "cwd-ancestor", candidates: uniqPaths(candidates), isDefault: true, exists: true }
	}

	// 全都找不到：把「最贴近意图」的默认路径作为结论返回，exists=false
	return { path: cwdPath, source: "cwd", candidates: uniqPaths(candidates), isDefault: true, exists: false }
}

/** 人类可读的来源说明，打印/日志用 */
export function describeLogSource(source: LogPathSource): string {
	switch (source) {
		case "arg":
			return "命令行参数"
		case "env":
			return `环境变量 ${STUDENT_LOG_ENV}`
		case "workspace-arg":
			return "--workspace 参数"
		case "workspace-root":
			return "VS Code 工作区"
		case "cwd":
			return "当前工作目录"
		case "cwd-ancestor":
			return "当前目录的上级工作区"
	}
}
