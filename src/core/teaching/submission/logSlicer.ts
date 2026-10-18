/**
 * =============================================================================
 *  logSlicer — 上传前的日志裁剪（P2-1）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【为什么要在客户端裁剪而不是整份上传】
 *   `.cline-logs/student_interactions.log` 会随使用一直增长（一个学期能到几十 MB），
 *   教学端只关心「本次任务的行为」。整份上传会让提交慢、服务端内存压力大，
 *   也无法解释「为什么报告里只有 200 行」。
 *
 * 【裁剪规则】
 *   ① 日志里能找到本次 task_id → 保留全量，但超过 2 MB 时只留 头 200 行 + 尾 1800 行
 *   ② 找不到 task_id（BN-06）→ 保留 `run_result` 事件 + 最近 200 行，`slice_missing=true`
 *   ③ 一个有效事件都没有（BN-04）→ 原样上传（让教学端统计 bad_lines 并提示解析失败）
 *
 * 纯函数，不碰 fs / vscode，便于单测。
 * =============================================================================
 */

/** 单个日志允许上传的字节上限（服务端单文件上限 6 MB，这里留足余量） */
export const MAX_LOG_UPLOAD_BYTES = 2 * 1024 * 1024
/** 超限时保留的头部行数（任务开始时的上下文） */
export const LOG_HEAD_LINES = 200
/** 超限时保留的尾部行数（最近的行为最有用） */
export const LOG_TAIL_LINES = 1800
/** 找不到 task_id 时保留的尾部行数 */
export const SLICE_MISSING_TAIL_LINES = 200

export interface SliceLogOptions {
	/** 本次 Cline 任务 id；给了才会尝试精确切片 */
	taskId?: string | null
	maxBytes?: number
}

export interface SlicedLog {
	/** 上传用的文本（可能是原文本的子集） */
	text: string
	/** 原日志总行数（含坏行），报告页显示「共 N 行」 */
	originalLineCount: number
	/** 切片后行数 */
	lineCount: number
	truncated: boolean
	/** 日志里没有本次 task_id */
	sliceMissing: boolean
	/** 有效 JSON 事件数 / 坏行数 */
	validLines: number
	badLines: number
}

function splitLines(text: string): string[] {
	if (!text) return []
	const normalized = text.replace(/\r\n/g, "\n")
	const lines = normalized.split("\n")
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
	return lines
}

/** 空行既不是事件也不是坏行：统计与报告一律忽略（日志里常有补齐用的空行） */
function isBlankLine(line: string): boolean {
	return line.trim() === ""
}

/** 单行是否是可解析的事件对象（用于统计坏行） */
function isParseable(line: string): boolean {
	const trimmed = line.trim()
	if (!trimmed) return false
	try {
		const parsed = JSON.parse(trimmed) as unknown
		return !!parsed && typeof parsed === "object"
	} catch {
		return false
	}
}

/** 是否包含指定 task id（事件里字段名有 taskId / task_id 两种历史写法） */
function lineHasTaskId(line: string, taskId: string): boolean {
	if (!line.includes(taskId)) return false
	return line.includes("taskId") || line.includes("task_id")
}

/** 是否是「运行结果」类事件（BN-06 要求优先保留） */
function lineIsRunResult(line: string): boolean {
	return line.includes("run_result") || line.includes("runResult")
}

/**
 * 裁剪日志。**保证返回的 text 一定 ≤ maxBytes**（按行切，不会把 JSON 截成半行）。
 */
export function sliceLogForUpload(text: string, options: SliceLogOptions = {}): SlicedLog {
	const maxBytes = options.maxBytes ?? MAX_LOG_UPLOAD_BYTES
	const taskId = options.taskId?.trim() || null
	const allLines = splitLines(text)
	const meaningful = allLines.filter((line) => !isBlankLine(line))

	let validLines = 0
	for (const line of meaningful) if (isParseable(line)) validLines++
	const badLines = meaningful.length - validLines

	const hasTaskId = taskId ? allLines.some((line) => lineHasTaskId(line, taskId)) : false
	const sliceMissing = !!taskId && !hasTaskId

	let selected: string[]
	let truncated = false

	if (sliceMissing) {
		// 找不到任务：保留所有 run_result + 最近的若干行，至少让老师看到报错
		const runResults = allLines.filter((line) => lineIsRunResult(line) && isParseable(line))
		const tail = allLines.slice(-SLICE_MISSING_TAIL_LINES)
		const merged = [...runResults, ...tail.filter((line) => !runResults.includes(line))]
		selected = merged
		truncated = merged.length < allLines.length
	} else {
		selected = allLines
	}

	// 字节上限：先掐头去尾，再逐行从头部削，直到满足 maxBytes
	const assembled = (lines: string[]): string => (lines.length > 0 ? `${lines.join("\n")}\n` : "")
	let out = assembled(selected)
	if (Buffer.byteLength(out, "utf8") > maxBytes) {
		truncated = true
		const head = selected.slice(0, LOG_HEAD_LINES)
		const tail = selected.slice(-LOG_TAIL_LINES)
		selected = head.length + tail.length >= selected.length ? selected : [...head, ...tail]
		out = assembled(selected)
		while (Buffer.byteLength(out, "utf8") > maxBytes && selected.length > 1) {
			// 每次丢掉中间靠前的一行，直到塞得下；保尾部（最近行为优先）
			const dropIndex = Math.max(0, Math.floor(selected.length / 3))
			selected = [...selected.slice(0, dropIndex), ...selected.slice(dropIndex + 1)]
			out = assembled(selected)
		}
		if (Buffer.byteLength(out, "utf8") > maxBytes) {
			// 极端情况：单行就超限，直接硬切（宁可丢内容也不能让提交被 413 拒掉）
			out = out.slice(0, maxBytes)
		}
	}

	return {
		text: out,
		originalLineCount: meaningful.length,
		lineCount: splitLines(out).filter((line) => !isBlankLine(line)).length,
		truncated,
		sliceMissing,
		validLines,
		badLines,
	}
}

/** 只统计有效/坏行，不裁剪（报告页与出题信号用） */
export function countLogLines(text: string): { total: number; valid: number; bad: number } {
	const lines = splitLines(text).filter((line) => !isBlankLine(line))
	let valid = 0
	for (const line of lines) if (isParseable(line)) valid++
	return { total: lines.length, valid, bad: lines.length - valid }
}
