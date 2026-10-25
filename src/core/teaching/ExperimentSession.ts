/**
 * 活动实验会话（Task1）
 *
 * 「开始实验之后，插件怎么知道现在仍然在实验模式」不能只靠 Task 内存或 cwd：
 *   - 聊天任务的 cwd 恒为工作区根（controller/index.ts 用 getPrimaryRoot 创建 Task）；
 *   - 学生点「返回对话」会新建任务、重启 VS Code 会丢内存状态。
 * 所以把绑定落在**工作区级文件** `<workspaceRoot>/.cline-logs/active-experiment.json`：
 * 任何任务、任何重启后读它都能恢复实验模式；`.cline-logs` 已被 .gitignore。
 *
 * 设计原则：
 *   - 读失败/JSON 损坏/字段类型不对 → 返回 null（等价没有活动会话，降级 free，不抛）；
 *   - 写入走「临时文件 + rename」原子替换，避免半截文件让模式判定抖动；
 *   - assignmentId 统一 sanitizeSegment，路径里不允许出现 `..`/分隔符；
 *   - 纯 fs，不依赖 vscode，可单测。
 */
import fs from "node:fs"
import path from "node:path"
import { EXPERIMENT_ROOT, sanitizeSegment } from "./ExperimentWorkspace"

/** 会话文件的相对路径（相对工作区根） */
export const ACTIVE_EXPERIMENT_FILE = path.join(".cline-logs", "active-experiment.json")

/** 会话文件内容 */
export interface ExperimentSession {
	/** 任务 id（已 sanitize） */
	assignmentId: string
	/** 任务标题，仅用于 UI 展示 */
	assignmentTitle?: string
	/** 语言（python/java/…），用于再次进入时保持模板一致 */
	language?: string
	/** 模板文件名（main.py/Main.java/…） */
	template?: string
	/** 开始时间（ISO 字符串） */
	startedAt: string
	status: "active"
}

/** 推给 webview 的会话视图（无会话时只有 active:false） */
export interface ExperimentSessionView {
	active: boolean
	assignmentId?: string
	assignmentTitle?: string
	language?: string
	template?: string
	startedAt?: string
	/** 该会话的日志/代码根目录（绝对路径） */
	logRoot?: string
}

export interface StartExperimentSessionInput {
	workspaceRoot: string
	assignmentId: string
	assignmentTitle?: string
	language?: string
	template?: string
	/** 便于测试注入固定时间 */
	now?: Date
}

/** 会话文件绝对路径；无工作区返回空串（调用方据此降级 free） */
export function activeExperimentPath(workspaceRoot: string | null | undefined): string {
	if (!workspaceRoot || !workspaceRoot.trim()) return ""
	return path.join(workspaceRoot, ACTIVE_EXPERIMENT_FILE)
}

function optionalString(value: unknown): string | undefined | null {
	if (value === undefined) return undefined
	if (typeof value !== "string") return null
	const trimmed = value.trim()
	return trimmed ? trimmed : undefined
}

/**
 * 读活动会话。
 *
 * 任何异常都降级为 null：会话文件坏掉时宁可当自由模式，也不能阻断聊天/提交。
 */
export function readActiveExperiment(workspaceRoot: string | null | undefined): ExperimentSession | null {
	const file = activeExperimentPath(workspaceRoot)
	if (!file) return null
	let raw: string
	try {
		if (!fs.existsSync(file)) return null
		raw = fs.readFileSync(file, "utf8")
	} catch {
		return null
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return null
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
	const body = parsed as Record<string, unknown>

	if (typeof body.assignmentId !== "string" || !body.assignmentId.trim()) return null
	const assignmentId = sanitizeSegment(body.assignmentId.trim())
	if (!assignmentId) return null
	if (body.status !== "active") return null
	if (typeof body.startedAt !== "string" || !body.startedAt.trim()) return null

	const assignmentTitle = optionalString(body.assignmentTitle)
	const language = optionalString(body.language)
	const template = optionalString(body.template)
	if (assignmentTitle === null || language === null || template === null) return null

	return {
		assignmentId,
		assignmentTitle,
		language,
		template,
		startedAt: body.startedAt.trim(),
		status: "active",
	}
}

/**
 * 开始实验：写会话文件（覆盖旧的）。
 *
 * 返回写入后的会话；任何写入失败会抛出，由调用方转换成用户可见错误。
 */
export function startExperimentSession(input: StartExperimentSessionInput): ExperimentSession {
	const file = activeExperimentPath(input.workspaceRoot)
	if (!file) {
		throw new Error("没有可用的工作区目录，无法开始实验")
	}
	const session: ExperimentSession = {
		assignmentId: sanitizeSegment((input.assignmentId ?? "").trim()),
		assignmentTitle: input.assignmentTitle?.trim() || undefined,
		language: input.language?.trim() || undefined,
		template: input.template?.trim() || undefined,
		startedAt: (input.now ?? new Date()).toISOString(),
		status: "active",
	}

	fs.mkdirSync(path.dirname(file), { recursive: true })
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
	const payload = `${JSON.stringify(session, null, 2)}\n`
	try {
		fs.writeFileSync(tmp, payload, "utf8")
		fs.renameSync(tmp, file)
	} catch (e) {
		// rename 在个别文件系统/杀软占用上可能失败；退化为直接写，避免开始实验整个失败。
		try {
			if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
			fs.writeFileSync(file, payload, "utf8")
		} catch {
			throw e
		}
	}
	return session
}

/**
 * 结束实验：只删会话文件，实验目录与日志全部保留。
 *
 * @returns 之前确实存在活动会话并已删除→true；本来就没有→false
 */
export function endExperimentSession(workspaceRoot: string | null | undefined): boolean {
	const file = activeExperimentPath(workspaceRoot)
	if (!file) return false
	try {
		if (!fs.existsSync(file)) return false
		fs.rmSync(file, { force: true })
		return true
	} catch {
		return false
	}
}

/**
 * 提交读侧根目录：活动会话属于该任务时读实验目录，否则读工作区根。
 *
 * 写入侧已经分别把行为日志、运行痕迹写进实验目录；提交必须用同一个函数选根，
 * 否则会出现「写实验目录、读工作区根」的分叉（Task3 修复的正是这个问题的写入半边）。
 */
export function resolveExperimentSourceRoot(
	workspaceRoot: string,
	assignmentId: string,
	sessionReader: (root: string) => ExperimentSession | null = readActiveExperiment,
): string {
	try {
		const session = sessionReader(workspaceRoot)
		if (session && session.assignmentId === assignmentId) {
			return experimentLogRoot(workspaceRoot, assignmentId)
		}
	} catch {
		// 读会话失败一律按工作区根，提交不因会话文件损坏而中断
	}
	return workspaceRoot
}

/** 活动会话的日志/代码根：`<root>/experiments/<sanitized-id>` */
export function experimentLogRoot(workspaceRoot: string, assignmentId: string): string {
	return path.join(workspaceRoot, EXPERIMENT_ROOT, sanitizeSegment(assignmentId))
}

/** 会话 → webview 视图；无会话返回 `{active:false}` */
export function toExperimentSessionView(
	workspaceRoot: string,
	session: ExperimentSession | null,
): ExperimentSessionView {
	if (!session) return { active: false }
	return {
		active: true,
		assignmentId: session.assignmentId,
		assignmentTitle: session.assignmentTitle,
		language: session.language,
		template: session.template,
		startedAt: session.startedAt,
		logRoot: experimentLogRoot(workspaceRoot, session.assignmentId),
	}
}
