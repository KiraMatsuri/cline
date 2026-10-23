/**
 * 六类行为分类器（P2-1）—— 规则为主，模型兜底（`teaching.behaviorClassifyLLM`，默认 false）。
 *
 * 设计 §5.1：
 * - 学生消息只归一个**主类**，优先级 `error_help > design > concept > other`；
 *   `self_code` / `ai_code` 是**非消息类事件**（code_edit / file_save / 助手完整实现），由事件字段解析，
 *   不参与学生消息分类，因此本模块不为它们产出学生消息结果。
 * - 助手回合：同轮既讲解又给完整实现 → `ai_code`；方向性伪代码 → `design`；短片段 / 纯讲解 → `design`。
 * - `behaviorSignals` 是逗号分隔的命中关键词/信号串（≤120 字，便于审计；三端/日志只当字符串用）。
 *
 * 约束：纯函数、无副作用（不 import fs / vscode / TeachingSessionMode —— 后者会拉进 fs 依赖）；
 * 只 import 现有纯判定器（`demandDetect` / `inabilityDetect` / `fullImplementationDetect` / `TaskClassifier`）。
 */

import { parseFencedCodeBlocks } from "@/shared/markdown/codeBlocks"
import { isCompleteImplDemand } from "@/core/task/student-analytics/demandDetect"
import { detectFullImplementation } from "@/core/task/student-analytics/fullImplementationDetect"
import { isInabilityStatement } from "@/core/task/student-analytics/inabilityDetect"
import { taskClassifier } from "@/core/task/student-analytics/TaskClassifier"
import type { TaskCategory } from "@/core/task/student-analytics/types"
import { BEHAVIOR_WEIGHTS } from "./metricsSpec"
import type { BehaviorType, CodeKind } from "./metricsSpec"

/** `behaviorSignals` 上限（设计 §5.1：≤120 字） */
export const BEHAVIOR_SIGNALS_MAX_LENGTH = 120

/**
 * 完整实现索要的放行阶梯（【P1-6】自由模式 3 次 / 实验模式 4 次）。
 * 与 `TeachingSessionMode.DEMAND_LADDER` 保持一致；此处复制为**本地常量**，避免把 fs 依赖拉进纯模块。
 */
export const BEHAVIOR_DEMAND_LADDER = { free: 3, experiment: 4 } as const

/** 判定伪代码的最小有效行数（低于此且无签名/控制流 → snippet） */
const MIN_PSEUDO_CODE_LINES = 5

/** 判定「粘贴了栈」的最小连续栈行数（设计 §5.1 error_help 信号③） */
const MIN_STACK_LINES = 3

/** 关键词扫描上限：10 万字符的输入不能拖慢分类（BN-31）；栈检测仍针对全文 */
const MAX_PATTERN_SCAN_CHARS = 8000

/** TaskClassifier 扫描上限（规则匹配相对更重） */
const MAX_CLASSIFIER_SCAN_CHARS = 4000

const CODE_KINDS: readonly CodeKind[] = ["full", "pseudo_complete", "pseudo_partial", "snippet"]

/** 函数签名：`def x(` / `function x(` / `public static`（计划 P2-1 判定表） */
const FUNCTION_SIGNATURE_PATTERN =
	/(?:\bdef\s+[A-Za-z_]\w*\s*\(|\bfunction\s+[A-Za-z_$][\w$]*\s*\(|\bpublic\s+static\b)/

/** 占位符 / 未完成标记：命中即 veto 为 `pseudo_partial`（BN-33 要记录理由） */
const PLACEHOLDER_PATTERN = /(?:TODO|FIXME|XXX|省略|自行补充|自行完成|自己补|待补|补全|…|\.\.\.(?![A-Za-z_$]))/i

const OUTPUT_PATTERN = /(?:返回|\breturn\b|\bprint\b|输出)/i

/** 拉丁控制流关键字 */
const CONTROL_FLOW_LATIN_PATTERN = /\b(?:for|while|if)\b/gi
/** 中文控制流关键字 */
const CONTROL_FLOW_CJK_PATTERN = /遍历|循环|判断/g

/** 任务要点词（与任务描述「与任务要点匹配词命中 ≥3」对应；按**去重命中数**计分） */
const TASK_KEYWORDS: readonly string[] = [
	"输入",
	"输出",
	"返回",
	"排序",
	"查找",
	"遍历",
	"循环",
	"判断",
	"数组",
	"列表",
	"字符串",
	"函数",
	"变量",
	"条件",
	"递归",
	"栈",
	"队列",
	"节点",
	"链表",
	"指针",
	"交换",
	"比较",
	"array",
	"list",
	"string",
	"function",
	"return",
	"input",
	"output",
]

/** 无围栏时判断文本是否真的像代码（防止把英文讲解里的 for/if/return 误判成伪代码） */
const UNFENCED_CODE_LINE_PATTERN =
	/^\s*(?:def|class|function|public|private|protected|if|for|while|return|print|import|from|#include|const|let|var|int|float|double|void|char|bool|std::|console\.|System\.)/m

interface SignalPattern {
	readonly pattern: RegExp
	/** 覆盖审计 token（缺省用命中原文） */
	readonly label?: string
}

/**
 * error_help 文本信号（设计 §5.1）：Traceback / Error / Exception / 报错 / 异常 / undefined /
 * null pointer / 段错误 / 编译错误；另加常见「运行失败」口语。
 * 信号①（最近 10 分钟 run_trace 失败）由调用方通过 `hasRecentError` 传入。
 */
const ERROR_SIGNAL_PATTERNS: readonly SignalPattern[] = [
	{ pattern: /traceback/i, label: "Traceback" },
	{ pattern: /error/i, label: "Error" },
	{ pattern: /exception/i, label: "Exception" },
	{ pattern: /报错/, label: "报错" },
	{ pattern: /异常/, label: "异常" },
	{ pattern: /\bundefined\b/i, label: "undefined" },
	{ pattern: /null\s*pointer|空指针|nullpointer/i, label: "null pointer" },
	{ pattern: /段错误|segmentation\s*fault/i, label: "段错误" },
	{ pattern: /编译(?:错误|失败|不过)/, label: "编译错误" },
	{ pattern: /崩溃|\bcrash(?:es|ed)?\b/i, label: "崩溃" },
	{ pattern: /运行失败|执行失败|跑不起来|不工作|没用啊/i, label: "运行失败" },
]

/** design 信号（设计 §5.1）：思路 / 怎么实现 / 如何设计 / 步骤 / 方案 / 从哪里开始 / 用什么结构 */
const DESIGN_SIGNAL_PATTERNS: readonly SignalPattern[] = [
	{ pattern: /思路/, label: "思路" },
	{ pattern: /怎么实现|如何实现|怎么去实现|如何去做|怎么完成|如何完成/, label: "怎么实现" },
	{ pattern: /怎么设计|如何设计|设计方案|设计思路/, label: "怎么设计" },
	{ pattern: /步骤/, label: "步骤" },
	{ pattern: /方案/, label: "方案" },
	{ pattern: /从哪里开始|从哪开始|怎么开头|如何开头/, label: "从哪里开始" },
	{ pattern: /用什么结构|用什么数据结构|用哪种结构/, label: "用什么结构" },
	{ pattern: /伪代码|\bpseudo ?code\b/i, label: "伪代码" },
	{ pattern: /框架/, label: "框架" },
	{ pattern: /\bhow (?:should|do|can) (?:i|we)\b[^.!?\n]{0,40}\b(?:design|implement|structure|start)\b/i, label: "how-to" },
]

/** concept 信号（设计 §5.1）：什么是 / 是什么 / 区别 / 语法 / 怎么用 / 数据结构有什么 / 为什么 */
const CONCEPT_SIGNAL_PATTERNS: readonly SignalPattern[] = [
	{ pattern: /什么是|是什么|啥是|是啥/, label: "什么是" },
	{ pattern: /有什么区别|有区别|区别是|区别|不同点|差异|对比/, label: "区别" },
	{ pattern: /语法/, label: "语法" },
	{ pattern: /怎么用|如何使用|如何用|用法/, label: "怎么用" },
	{ pattern: /为什么|为何|原理/, label: "为什么" },
	{ pattern: /数据结构.{0,10}(?:有|包含|包括)/, label: "数据结构" },
	{ pattern: /\bwhat (?:is|are)\b/i, label: "what is" },
	{ pattern: /\bwhy\b/i, label: "why" },
]

/** 编码类任务分类（TaskClassifier 回退 → design） */
const CODING_TASK_CATEGORIES: ReadonlySet<TaskCategory> = new Set<TaskCategory>([
	"code_generation",
	"refactoring",
	"testing",
	"language_request",
])

/** 概念类任务分类（TaskClassifier 回退 → concept） */
const CONCEPT_TASK_CATEGORIES: ReadonlySet<TaskCategory> = new Set<TaskCategory>(["explanation", "algorithm"])

/** 寒暄/闲聊词（整句归一化后匹配） */
const GREETING_WORDS: readonly string[] = [
	"你好",
	"您好",
	"hi",
	"hello",
	"hey",
	"嗨",
	"哈喽",
	"谢谢",
	"多谢",
	"感谢",
	"thanks",
	"thankyou",
	"thx",
	"好的",
	"ok",
	"okay",
	"嗯嗯",
	"明白",
	"收到",
	"再见",
	"拜拜",
	"在吗",
]

/** 单条学生消息的分类结果 */
export interface BehaviorClassification {
	readonly type: BehaviorType
	readonly weight: number
	/** 逗号分隔的命中信号（≤120 字；无信号时 `no_signal`） */
	readonly signals: string
}

/** 助手回合分类结果（多一个 `codeKind`，供集成直接写日志） */
export interface AssistantTurnBehavior extends BehaviorClassification {
	readonly codeKind: CodeKind
}

export interface StudentMessageInput {
	/** 学生原文（缺省按空串处理，绝不抛错） */
	text?: string | null
	/** 内容分析器的 `hasCode`（行内代码/代码特征） */
	hasCode?: boolean
	/** 会话模式：`free` 3 次放行 / `experiment` 4 次放行（【P1-6】） */
	mode?: "free" | "experiment"
	/** 【P1-6】当前学生请求的完整实现索要计数（含本次） */
	demandCount?: number
	/**
	 * 设计 §5.1 error_help 信号①：最近 10 分钟内有 `exit_code != 0` 的 run_trace。
	 * 该数据不在学生原文里，由集成点（任务层）查询后传入；缺省不臆造。
	 */
	hasRecentError?: boolean
}

export interface AssistantTurnInput {
	/** 助手原文（缺省按空串处理） */
	text?: string | null
	/** 内容分析器的 `hasFullImpl`（缺省时本模块用 `detectFullImplementation` 自行判定） */
	hasFullImpl?: boolean
	/** 助手本轮使用的工具（`write_to_file` 视为整文件落盘） */
	toolsUsed?: readonly string[] | null
	/** 调用方已算好的代码形态（优先使用，避免重复检测） */
	codeKind?: CodeKind
}

/** 代码形态检测的明细（`detectCodeKind` 只返回 kind；助手轮把 reasons 写进 signals） */
interface CodeKindAnalysis {
	readonly kind: CodeKind
	readonly reasons: readonly string[]
}

function normalizeText(value: unknown): string {
	return typeof value === "string" ? value : ""
}

function isCodeKind(value: unknown): value is CodeKind {
	return typeof value === "string" && (CODE_KINDS as readonly string[]).includes(value)
}

function sanitizeSignalToken(token: string): string {
	return token.replace(/[\s,，]+/g, " ").trim().slice(0, 40)
}

/**
 * 拼装 `behaviorSignals`：token 去重、逗号连接、总长 ≤120 字。
 * 超长时丢弃尾部 token（不把 token 从中间截断）；单个 token 超长时才硬截。
 */
export function formatBehaviorSignals(parts: readonly string[]): string {
	const tokens: string[] = []
	for (const part of parts) {
		const token = sanitizeSignalToken(part)
		if (token.length > 0 && !tokens.includes(token)) {
			tokens.push(token)
		}
	}
	let result = ""
	for (const token of tokens) {
		const next = result.length === 0 ? token : `${result},${token}`
		if (next.length > BEHAVIOR_SIGNALS_MAX_LENGTH && result.length > 0) {
			break
		}
		result = next
	}
	if (result.length > BEHAVIOR_SIGNALS_MAX_LENGTH) {
		result = result.slice(0, BEHAVIOR_SIGNALS_MAX_LENGTH)
	}
	return result.length > 0 ? result : "no_signal"
}

function buildClassification(type: BehaviorType, signals: readonly string[]): BehaviorClassification {
	return {
		type,
		weight: type === "other" ? 0 : BEHAVIOR_WEIGHTS[type],
		signals: formatBehaviorSignals(signals),
	}
}

/** 按顺序收集命中信号的审计 token（每个 pattern 只取第一个命中） */
function collectSignalLabels(text: string, patterns: readonly SignalPattern[]): string[] {
	const labels: string[] = []
	for (const { pattern, label } of patterns) {
		const match = pattern.exec(text)
		if (match) {
			labels.push(label ?? match[0])
		}
	}
	return labels
}

/** 栈行判定：Python traceback / JVM `at pkg.Cls.m(File.java:12)` / C `#0 0x...` / Node `at fn (file:1:2)` */
const STACK_LINE_PATTERN =
	/(?:^\s*at\s+\S|File\s+"[^"]+",\s*line\s+\d+|^\s*Traceback|^\s*\.\.\.|^\s*[\w$.]+(?:Error|Exception):|^\s*#\d+\s+0x|^\s*0x[0-9a-f]+\s+in)/i

function countStackLines(text: string): number {
	let count = 0
	for (const line of text.split("\n")) {
		if (STACK_LINE_PATTERN.test(line)) {
			count += 1
		}
	}
	return count
}

/** 有序步骤标记数：`步骤 1..n` / 行首 `1.` `2)` `一、` 等 */
function countStepMarkers(text: string): number {
	const explicit = text.match(/(?:步骤|第)\s*[0-9一二三四五六七八九十]+/g)?.length ?? 0
	const numberedLines = text.match(/(?:^|\n)[ \t]*(?:\d{1,2}[.、)）]|[一二三四五六七八九十]{1,3}[、.])\s*\S/g)?.length ?? 0
	return Math.max(explicit, numberedLines)
}

/** 控制流命中数：拉丁 for/while/if + 中文 遍历/循环/判断 */
function countControlFlow(text: string): number {
	const latin = text.match(CONTROL_FLOW_LATIN_PATTERN)?.length ?? 0
	const cjk = text.match(CONTROL_FLOW_CJK_PATTERN)?.length ?? 0
	return latin + cjk
}

/** 任务要点词去重命中数 */
function countTaskKeywordHits(text: string): number {
	const lower = text.toLowerCase()
	let hits = 0
	for (const keyword of TASK_KEYWORDS) {
		if (lower.includes(keyword)) {
			hits += 1
		}
	}
	return hits
}

/** 无围栏时判断文本是否真的像代码（避免自然语言讲解被误判成伪代码） */
function looksLikeCode(text: string): boolean {
	if (parseFencedCodeBlocks(text).length > 0) {
		return true
	}
	const nonEmptyLines = text.split("\n").filter((line) => line.trim().length > 0)
	const indentedLines = nonEmptyLines.filter((line) => /^(?: {2,}|\t+)\S/.test(line)).length
	if (indentedLines >= 2) {
		return true
	}
	if ((text.match(/[{};]/g)?.length ?? 0) >= 2) {
		return true
	}
	if (UNFENCED_CODE_LINE_PATTERN.test(text)) {
		return true
	}
	if (/(?:=>|:=|<-)/.test(text)) {
		return true
	}
	// 中文伪代码常见形态：「步骤 1..n」已经足以视为结构化伪代码
	return countStepMarkers(text) >= 3
}

/** 取最长 fenced 块内容；无围栏时退化为全文 */
function extractCodeRegion(text: string): string {
	const blocks = parseFencedCodeBlocks(text)
	if (blocks.length === 0) {
		return text
	}
	let best = blocks[0]
	for (const block of blocks) {
		if (block.lineCount > best.lineCount) {
			best = block
		}
	}
	return best.inner
}

/**
 * 代码形态明细：
 * 0. 空文本 → snippet；
 * 1. `detectFullImplementation` 通过 → full（整函数/整文件落盘）；
 * 2. 占位符 veto → pseudo_partial（BN-33，reason 记录占位符种类）；
 * 3. 行数 <5 且无签名/无控制流 veto → snippet；
 * 4. 不像代码（自然语言讲解）→ snippet；
 * 5. 否则按计划判定表打分：签名 / 控制流≥2 / 输入输出 / 任务要点词≥3，≥3 分 → pseudo_complete，否则 pseudo_partial。
 */
function analyzeCodeKind(text: string): CodeKindAnalysis {
	const source = normalizeText(text)
	if (source.trim().length === 0) {
		return { kind: "snippet", reasons: ["empty"] }
	}

	const verdict = detectFullImplementation(source)
	if (verdict.detected) {
		return { kind: "full", reasons: ["full_impl_detected"] }
	}

	const region = extractCodeRegion(source)
	const placeholderMatch = region.match(PLACEHOLDER_PATTERN)
	if (placeholderMatch) {
		return { kind: "pseudo_partial", reasons: [`placeholder:${placeholderMatch[0]}`] }
	}

	const lineCount = region.split("\n").filter((line) => line.trim().length > 0).length
	const hasSignature = FUNCTION_SIGNATURE_PATTERN.test(region) || countStepMarkers(source) >= 3
	const controlFlow = countControlFlow(region)
	if (lineCount < MIN_PSEUDO_CODE_LINES && !hasSignature && controlFlow === 0) {
		return { kind: "snippet", reasons: [`short:${lineCount}行`] }
	}
	if (!looksLikeCode(source)) {
		return { kind: "snippet", reasons: [`text:${lineCount}行`, "not_code"] }
	}

	let score = 0
	const reasons: string[] = []
	if (hasSignature) {
		score += 1
		reasons.push("signature")
	}
	if (controlFlow >= 2) {
		score += 1
		reasons.push(`controlFlow:${controlFlow}`)
	}
	if (OUTPUT_PATTERN.test(region)) {
		score += 1
		reasons.push("output")
	}
	const keywordHits = countTaskKeywordHits(region)
	if (keywordHits >= 3) {
		score += 1
		reasons.push(`taskKeywords:${keywordHits}`)
	}
	reasons.push(`score:${score}/3`)
	return { kind: score >= 3 ? "pseudo_complete" : "pseudo_partial", reasons }
}

/**
 * 代码形态检测（R1 伪代码判定）：
 * `"full" | "pseudo_complete" | "pseudo_partial" | "snippet"`。
 */
export function detectCodeKind(text?: string | null): CodeKind {
	return analyzeCodeKind(normalizeText(text)).kind
}

/**
 * 学生消息分类（优先级 `error_help > design > concept > other`）。
 *
 * 顺序刻意固定：error_help 先行，保证「同一条消息既报错又索要完整实现 → error_help」（PLAN 断言 10）；
 * design 次之（索要完整实现、自述写不出来、方向性提问）；concept 再次；其余归 other。
 */
export function classifyStudentMessage(input?: StudentMessageInput | null): BehaviorClassification {
	const text = normalizeText(input?.text)
	const scanText = text.length > MAX_PATTERN_SCAN_CHARS ? text.slice(0, MAX_PATTERN_SCAN_CHARS) : text
	const classifierText = text.length > MAX_CLASSIFIER_SCAN_CHARS ? text.slice(0, MAX_CLASSIFIER_SCAN_CHARS) : text
	const mode = input?.mode === "free" || input?.mode === "experiment" ? input.mode : undefined
	const demandCount =
		typeof input?.demandCount === "number" && Number.isFinite(input.demandCount) ? Math.max(0, input.demandCount) : 0

	// 1) error_help 最高优先级（文本信号 + 栈 + 最近一次失败运行）
	const errorSignals = collectSignalLabels(scanText, ERROR_SIGNAL_PATTERNS)
	const stackLines = countStackLines(text)
	if (stackLines >= MIN_STACK_LINES) {
		errorSignals.push(`stack:${stackLines}行`)
	}
	if (input?.hasRecentError === true) {
		errorSignals.push("recent_run_failed")
	}
	if (errorSignals.length > 0) {
		return buildClassification("error_help", errorSignals)
	}

	// 2) design：索要完整实现 / 自述写不出来 / 方向性提问
	const designSignals: string[] = []
	if (isCompleteImplDemand(scanText)) {
		designSignals.push("full_impl_demand")
		const ladder = mode === "experiment" ? BEHAVIOR_DEMAND_LADDER.experiment : BEHAVIOR_DEMAND_LADDER.free
		designSignals.push(demandCount >= ladder ? "demand_released" : "demand_pending")
	}
	if (isInabilityStatement(scanText)) {
		designSignals.push("inability")
	}
	designSignals.push(...collectSignalLabels(scanText, DESIGN_SIGNAL_PATTERNS))
	if (designSignals.length > 0) {
		return buildClassification("design", designSignals)
	}

	// 3) TaskClassifier 回退：编码类任务 → design
	const category = taskClassifier.classify(classifierText)
	if (CODING_TASK_CATEGORIES.has(category)) {
		return buildClassification("design", [`category:${category}`])
	}

	// 4) concept
	const conceptSignals = collectSignalLabels(scanText, CONCEPT_SIGNAL_PATTERNS)
	if (conceptSignals.length > 0) {
		return buildClassification("concept", conceptSignals)
	}
	if (CONCEPT_TASK_CATEGORIES.has(category)) {
		return buildClassification("concept", [`category:${category}`])
	}

	// 5) 带代码但没有求助/设计语义：按实现请求（design）处理
	if (input?.hasCode === true) {
		return buildClassification("design", ["hasCode"])
	}

	// 6) 问候 / 闲聊 / 其余
	if (isGreetingOrChat(scanText)) {
		return buildClassification("other", ["greeting"])
	}
	return buildClassification("other", ["no_signal"])
}

/** 整句寒暄/闲聊判定（保守：只认整句都是寒暄词，避免「你好，为什么报错」被误判） */
function isGreetingOrChat(text: string): boolean {
	const normalized = text
		.trim()
		.toLowerCase()
		.replace(/[\s!！。,.，~～?？:：、]/g, "")
	if (normalized.length === 0) {
		return true
	}
	return GREETING_WORDS.some((word) => normalized === word || (normalized.length <= 6 && normalized.includes(word)))
}

/**
 * 助手回合分类：`ai_code`（完整实现 / 完整伪代码）或 `design`（方向性伪代码 / 片段 / 纯讲解），
 * 寒暄闲聊归 `other`。返回的 `codeKind` 由调用方直接写入日志。
 */
export function classifyAssistantTurn(input?: AssistantTurnInput | null): AssistantTurnBehavior {
	const text = normalizeText(input?.text)
	const tools = Array.isArray(input?.toolsUsed) ? input.toolsUsed.filter((tool): tool is string => typeof tool === "string") : []
	const explicitCodeKind = isCodeKind(input?.codeKind) ? input.codeKind : undefined
	const hasFullImplFlag = typeof input?.hasFullImpl === "boolean" ? input.hasFullImpl : undefined
	const detectedFull = hasFullImplFlag ?? detectFullImplementation(text).detected

	const baseSignals: string[] = []
	if (hasFullImplFlag === true) {
		baseSignals.push("hasFullImpl")
	} else if (detectedFull) {
		baseSignals.push("full_impl_detected")
	}
	if (tools.length > 0) {
		baseSignals.push(`tools:${tools.join("+")}`)
	}

	let analysis: CodeKindAnalysis
	if (explicitCodeKind) {
		analysis = { kind: explicitCodeKind, reasons: ["codeKind:explicit"] }
	} else if (detectedFull || tools.includes("write_to_file")) {
		analysis = { kind: "full", reasons: [detectedFull ? "full_impl_detected" : "tool:write_to_file"] }
	} else {
		analysis = analyzeCodeKind(text)
	}

	const signals = [...baseSignals, `codeKind=${analysis.kind}`, ...analysis.reasons]
	if (analysis.kind === "full" || analysis.kind === "pseudo_complete") {
		return {
			type: "ai_code",
			weight: BEHAVIOR_WEIGHTS.ai_code,
			signals: formatBehaviorSignals(signals),
			codeKind: analysis.kind,
		}
	}
	if (text.trim().length === 0 && tools.length === 0) {
		return {
			type: "other",
			weight: 0,
			signals: formatBehaviorSignals(["empty", ...signals]),
			codeKind: analysis.kind,
		}
	}
	if (tools.length === 0 && isGreetingOrChat(text)) {
		return {
			type: "other",
			weight: 0,
			signals: formatBehaviorSignals(["greeting", ...signals]),
			codeKind: analysis.kind,
		}
	}
	return {
		type: "design",
		weight: BEHAVIOR_WEIGHTS.design,
		signals: formatBehaviorSignals(signals),
		codeKind: analysis.kind,
	}
}

/**
 * 【集成辅助】六类行为 → 旧 `queryType` 的映射（设计 §5.1）：
 * `concept→concept`、`design|error_help→coding`、`other→other`。
 *
 * 为什么要保留旧字段：教师端旧分析脚本仍读 `queryType`，日志字段「只增不改」；
 * `self_code` / `ai_code` 不是消息类事件，正常不会走到这里，兜底归 `coding`。
 */
export function toLegacyQueryType(behaviorType: BehaviorType): "concept" | "coding" | "other" {
	switch (behaviorType) {
		case "concept":
			return "concept"
		case "design":
		case "error_help":
		case "self_code":
		case "ai_code":
			return "coding"
		default:
			return "other"
	}
}
