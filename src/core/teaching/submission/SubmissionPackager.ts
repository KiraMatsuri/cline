/**
 * =============================================================================
 *  SubmissionPackager — 提交包收集与上传（扩展侧）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责边界】这个文件只做「本地收集 + 一次 multipart POST」，不含任何 UI。
 * 之所以单独拆出来，是因为它必须能在没有 VS Code 的情况下做单测：
 * 代码清单筛选、日志切片、run_traces 解析、meta 组装全是纯函数 + fs。
 *
 * 【为什么不再传 log_file_path 让服务器读】
 * 云端部署时服务器读不到学生磁盘上的路径（需求 1 的根本原因）。现在改为
 * 日志原文随包上传，路径只作为 `log.original_path` 的溯源信息。
 *
 * 设计文档：docs/design/teaching-submission-bundle-design.md §5
 * =============================================================================
 */

import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import {
	BUNDLE_LIMITS,
	BUNDLE_PART_FIELDS,
	BUNDLE_SCHEMA,
	type BundleAnswer,
	type BundleIngestResult,
	type BundleLogInfo,
	type BundleMeta,
	type BundleQuestion,
	type BundleRunTrace,
} from "./bundleTypes"

/** 文本源码扩展名白名单（与教学端 ALLOWED_CODE_EXTENSIONS 对齐的子集） */
const CODE_EXTENSIONS = new Set([
	".c",
	".cc",
	".cfg",
	".cpp",
	".cs",
	".css",
	".csv",
	".go",
	".h",
	".hpp",
	".htm",
	".html",
	".ini",
	".ipynb",
	".java",
	".js",
	".json",
	".jsx",
	".kt",
	".less",
	".lua",
	".m",
	".md",
	".php",
	".pl",
	".properties",
	".ps1",
	".py",
	".r",
	".rb",
	".rs",
	".scala",
	".scss",
	".sh",
	".sql",
	".svelte",
	".swift",
	".tex",
	".toml",
	".ts",
	".tsx",
	".txt",
	".vue",
	".xml",
	".yaml",
	".yml",
])

/** 永远跳过的目录（日志目录、依赖目录、构建产物、VCS） */
const SKIP_DIRS = new Set([
	".cline-logs",
	"node_modules",
	".git",
	".hg",
	".svn",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	"out",
	"target",
	".next",
	".nuxt",
	".turbo",
	".idea",
	".vscode",
	"coverage",
])

const MAX_WALK_ENTRIES = 5000
const MAX_WALK_DEPTH = 8
const RUN_TRACE_FILE = "run_traces.jsonl"

export interface CollectCodeOptions {
	workspaceRoot: string
	/** 当前活动编辑器的绝对路径：命中则排第一（学生正在写的那份一定是任务代码） */
	activeFilePath?: string | null
	maxFiles?: number
	maxBytesPerFile?: number
}

/** 收集到的代码文件（buffer 已在内存里，确认提交时直接放进 FormData） */
export interface CollectedCodeFile {
	relPath: string
	absPath: string
	buffer: Buffer
	sizeBytes: number
	lineCount: number
}

export interface CollectCodeResult {
	files: CollectedCodeFile[]
	omitted: { relPath: string; reason: string }[]
	scanned: number
}

/** 收集到的日志（可能不存在：BN-01/BN-02 目录无日志也要能提交） */
export interface CollectedLog {
	path: string | null
	buffer: Buffer | null
	lineCount: number
	info: BundleLogInfo | null
}

export function sha256Of(buffer: Buffer): string {
	return crypto.createHash("sha256").update(buffer).digest("hex")
}

export function countLines(buffer: Buffer): number {
	if (buffer.length === 0) return 0
	const text = buffer.toString("utf8")
	const newlines = text.split("\n").length - 1
	return text.endsWith("\n") ? newlines : newlines + 1
}

export function looksBinary(buffer: Buffer): boolean {
	const probe = buffer.subarray(0, Math.min(buffer.length, 8192))
	return probe.includes(0)
}

function isCodeFile(filePath: string): boolean {
	return CODE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

function toRelPath(workspaceRoot: string, absPath: string): string {
	const rel = path.relative(workspaceRoot, absPath)
	return rel.split(path.sep).join("/")
}

/**
 * 遍历工作区挑出任务代码文件。
 *
 * 排序规则：活动编辑器文件 > 其它文件按 mtime 降序（学生最后改的通常就是任务代码）。
 * 不做「按任务 id 找目录」——工作区结构与任务之间没有约定，猜目录反而会漏文件。
 */
export function collectCodeFiles(options: CollectCodeOptions): CollectCodeResult {
	const maxFiles = options.maxFiles ?? BUNDLE_LIMITS.maxCodeFiles
	const maxBytesPerFile = options.maxBytesPerFile ?? BUNDLE_LIMITS.maxCodeFileBytes
	const workspaceRoot = options.workspaceRoot
	const omitted: CollectCodeResult["omitted"] = []
	const candidates: { absPath: string; mtimeMs: number; size: number }[] = []
	let scanned = 0

	const walk = (dir: string, depth: number): void => {
		if (depth > MAX_WALK_DEPTH || scanned >= MAX_WALK_ENTRIES) return
		let entries: fs.Dirent[]
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (scanned >= MAX_WALK_ENTRIES) return
			scanned++
			const absPath = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
				walk(absPath, depth + 1)
				continue
			}
			if (!entry.isFile()) continue
			if (!isCodeFile(absPath)) continue
			try {
				const stat = fs.statSync(absPath)
				candidates.push({ absPath, mtimeMs: stat.mtimeMs, size: stat.size })
			} catch {
				// 权限/竞态：跳过即可，不值得中断整次提交
			}
		}
	}

	walk(workspaceRoot, 0)

	const active = options.activeFilePath ? path.resolve(options.activeFilePath) : null
	candidates.sort((a, b) => {
		if (active) {
			const aActive = path.resolve(a.absPath) === active
			const bActive = path.resolve(b.absPath) === active
			if (aActive !== bActive) return aActive ? -1 : 1
		}
		return b.mtimeMs - a.mtimeMs
	})

	const files: CollectedCodeFile[] = []
	for (const candidate of candidates) {
		if (files.length >= maxFiles) {
			omitted.push({ relPath: toRelPath(workspaceRoot, candidate.absPath), reason: "too_many_files" })
			continue
		}
		if (candidate.size === 0) {
			omitted.push({ relPath: toRelPath(workspaceRoot, candidate.absPath), reason: "empty" })
			continue
		}
		if (candidate.size > maxBytesPerFile) {
			omitted.push({ relPath: toRelPath(workspaceRoot, candidate.absPath), reason: "too_large" })
			continue
		}
		let buffer: Buffer
		try {
			buffer = fs.readFileSync(candidate.absPath)
		} catch {
			omitted.push({ relPath: toRelPath(workspaceRoot, candidate.absPath), reason: "unreadable" })
			continue
		}
		if (looksBinary(buffer)) {
			omitted.push({ relPath: toRelPath(workspaceRoot, candidate.absPath), reason: "binary" })
			continue
		}
		files.push({
			relPath: toRelPath(workspaceRoot, candidate.absPath),
			absPath: candidate.absPath,
			buffer,
			sizeBytes: buffer.length,
			lineCount: countLines(buffer),
		})
	}

	return { files, omitted, scanned }
}

/**
 * 读取工作区日志原文。路径由调用方解析好后传入（resolver 负责「不再写死」）。
 * 文件不存在时返回空结果而不是抛错：没有日志的学生同样要能提交（BN-01/BN-04）。
 */
export function collectLog(logPath: string | null | undefined): CollectedLog {
	if (!logPath) return { path: null, buffer: null, lineCount: 0, info: null }
	let buffer: Buffer
	try {
		buffer = fs.readFileSync(logPath)
	} catch {
		return { path: logPath, buffer: null, lineCount: 0, info: null }
	}
	return {
		path: logPath,
		buffer,
		lineCount: countLines(buffer),
		info: { original_path: logPath, line_count: countLines(buffer), sha256: sha256Of(buffer), truncated: false },
	}
}

/**
 * 读取运行痕迹。P0 只消费已经落盘的记录（`.cline-logs/run_traces.jsonl`），
 * P1 再由终端 shell integration 监听实时写入。缺失时返回空数组。
 */
export function readRunTraces(workspaceRoot: string, maxTraces = 100): BundleRunTrace[] {
	const tracePath = path.join(workspaceRoot, ".cline-logs", RUN_TRACE_FILE)
	let text: string
	try {
		text = fs.readFileSync(tracePath, "utf8")
	} catch {
		return []
	}
	const traces: BundleRunTrace[] = []
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			const parsed = JSON.parse(trimmed) as BundleRunTrace
			if (parsed && typeof parsed === "object") traces.push(parsed)
		} catch {
			// 坏行跳过：痕迹只是辅助信号，不值得让提交失败
		}
	}
	return traces.slice(-maxTraces)
}

/** 统计日志里 AI 事件与 code_edit 次数（用于出题信号，零网络） */
export function summarizeLogEvents(buffer: Buffer | null): { total: number; assistant: number; codeEdit: number } {
	if (!buffer || buffer.length === 0) return { total: 0, assistant: 0, codeEdit: 0 }
	let total = 0
	let assistant = 0
	let codeEdit = 0
	for (const line of buffer.toString("utf8").split("\n")) {
		const trimmed = line.trim()
		if (!trimmed) continue
		let event: Record<string, unknown>
		try {
			event = JSON.parse(trimmed) as Record<string, unknown>
		} catch {
			continue
		}
		total++
		if (event.role === "assistant" || event.category === "code_generation") assistant++
		if (event.eventType === "code_edit" || event.eventType === "codeEdit" || event.category === "refactoring") codeEdit++
	}
	return { total, assistant, codeEdit }
}

export interface BuildMetaOptions {
	assignmentId: string
	studentId: string
	studentName: string
	classId: string
	submittedAt?: string
	taskId?: string
	questions?: BundleQuestion[]
	answers?: BundleAnswer[]
	logInfo?: BundleLogInfo | null
	runTraces?: BundleRunTrace[]
	clientVersion?: string
	idempotencyKey?: string
	/** BN-16：提交时还没保存到磁盘的文件（内容取自编辑器缓冲区） */
	unsavedFiles?: string[]
}

/** 组装 meta：schema 与时间戳在这里补齐，调用方不用记契约细节 */
export function buildBundleMeta(options: BuildMetaOptions): BundleMeta {
	const meta: BundleMeta = {
		schema: BUNDLE_SCHEMA,
		assignment_id: options.assignmentId,
		student_id: options.studentId,
		student_name: options.studentName,
		class_id: options.classId,
		submitted_at: options.submittedAt ?? new Date().toISOString(),
	}
	if (options.taskId) meta.task_id = options.taskId
	if (options.questions && options.questions.length > 0) meta.questions = options.questions
	if (options.answers && options.answers.length > 0) meta.answers = options.answers
	if (options.logInfo) meta.log = options.logInfo
	if (options.runTraces && options.runTraces.length > 0) meta.run_traces = options.runTraces
	if (options.clientVersion) meta.client_version = options.clientVersion
	if (options.idempotencyKey) meta.idempotency_key = options.idempotencyKey
	if (options.unsavedFiles && options.unsavedFiles.length > 0) meta.unsaved_files = options.unsavedFiles
	return meta
}

export interface PostBundleOptions {
	apiBase: string
	meta: BundleMeta
	logBuffer?: Buffer | null
	logFileName?: string
	codeFiles: CollectedCodeFile[] | { relPath: string; buffer: Buffer }[]
	/** 便于测试注入；默认用全局 fetch */
	fetchImpl?: typeof fetch
}

export interface PostBundleResponse {
	status: number
	ok: boolean
	body: BundleIngestResult | { ok: false; code?: string; error?: string }
}

/**
 * 一次 multipart 上传：meta 文本 + log 文件 + N 个 code 文件 + code_path_i 相对路径。
 *
 * 注意 1：`FormData.append` 才能让同名分区重复出现（`set` 会覆盖前一个文件）。
 * 注意 2：Node 的 `FormData` 会自己生成 boundary，**不要**手动设 Content-Type，
 *        否则 boundary 丢失，服务端 multer 会解析失败。
 */
export async function postBundle(options: PostBundleOptions): Promise<PostBundleResponse> {
	const doFetch = options.fetchImpl ?? fetch
	const form = new FormData()
	form.append(BUNDLE_PART_FIELDS.meta, JSON.stringify(options.meta))

	if (options.logBuffer && options.logBuffer.length > 0) {
		const logName = options.logFileName ?? "student_interactions.log"
		form.append(BUNDLE_PART_FIELDS.log, new Blob([new Uint8Array(options.logBuffer)]), logName)
	}

	options.codeFiles.forEach((file, index) => {
		const name = path.basename(file.relPath)
		form.append(BUNDLE_PART_FIELDS.code, new Blob([new Uint8Array(file.buffer)]), name)
		form.append(`${BUNDLE_PART_FIELDS.codePathPrefix}${index}`, file.relPath)
	})

	const url = `${options.apiBase.replace(/\/+$/, "")}/api/v1/submissions/bundle`
	const response = await doFetch(url, { method: "POST", body: form })
	let body: PostBundleResponse["body"]
	try {
		body = (await response.json()) as PostBundleResponse["body"]
	} catch {
		body = { ok: false, code: "BAD_RESPONSE", error: `服务器返回了非 JSON 响应（HTTP ${response.status}）` }
	}
	return { status: response.status, ok: response.ok, body }
}
