/**
 * 行为加权指标规范（P2-1 / P2-4）—— 三端口径的**唯一权威实现**。
 *
 * 权威契约：`docs/design/metrics-spec.md`（Cline 插件 / teaching-server / backend 三份实现逐字一致，
 * 由 `contract-check.mjs` 第 13 组机械校验）。
 *
 * 约束：
 * - **纯函数、零外部依赖**：不得 import fs / Logger / vscode / 环境变量，否则 Web 端与后端无法镜像；
 * - **不抛异常**：`events` 允许 `undefined` / 非数组（按空数组处理），旧日志缺字段按契约回退；
 * - 所有除法结果统一走 `round6`，保证 JS 浮点 `toString()` 三端完全相等。
 */

/** 指标 schema 版本；三端日志 / 接口必须带同名字段同名值 */
export const METRICS_SCHEMA = "behavior-weighted/v1" as const

/** 六类行为（顺序即契约顺序；持久化与分析都依赖它） */
export const BEHAVIOR_TYPES = ["concept", "design", "error_help", "self_code", "ai_code", "other"] as const

/** 六类行为之一（`BEHAVIOR_TYPES` 的联合类型） */
export type BehaviorType = (typeof BEHAVIOR_TYPES)[number]

/** 行为判定来源：规则引擎 / 模型兜底（设计 §5.1：规则为主、`teaching.behaviorClassifyLLM` 兜底） */
export type BehaviorSource = "rule" | "llm"

/**
 * 代码形态（R1 伪代码判定的输出）：
 * - `full`：整函数 / 整文件落盘（`detectFullImplementation` 通过）；
 * - `pseudo_complete`：完整控制流 + 关键步骤 + 输入输出、无占位符 → `ai_code`；
 * - `pseudo_partial`：只给方向骨架 / 含 TODO·省略·自行补充 → `design`；
 * - `snippet`：不足 5 行、无完整语义 → `design`。
 */
export type CodeKind = "full" | "pseudo_complete" | "pseudo_partial" | "snippet"

/** 六类权重（契约 §2）；`other` 不计分，故故意不在表中 */
export const BEHAVIOR_WEIGHTS = {
	concept: 0.25,
	design: 0.75,
	error_help: 1.0,
	self_code: 0,
	ai_code: 1.2,
} as const

/** `depIndex = ΣW / (DEPENDENCY_DIVISOR × N)` */
export const DEPENDENCY_DIVISOR = 1.2

/** 单事件行为权重上限（BN-40 夹取上界） */
export const MAX_BEHAVIOR_WEIGHT = 1.2

/** 采纳后观察自主编码的窗口轮数 */
export const ADOPTION_WINDOW_TURNS = 5

/** 引导后观察行为变化的窗口轮数（供 P2-4 / 展示层使用；契约公式本身不含窗口） */
export const GUIDANCE_WINDOW_TURNS = 3

/** 报错后观察错误是否解决的窗口轮数 */
export const ERROR_WINDOW_TURNS = 5

/** 旧事件回退：旧 `queryType` → 行为类型（契约 §3 第 4 优先级；PLAN 测试 15） */
export const QUERY_TYPE_FALLBACK: Readonly<Record<string, BehaviorType>> = {
	concept: "concept",
	design: "design",
	error_help: "error_help",
	coding: "design",
	other: "other",
}

/** 六类行为的计数分布（`other` 单独保留，但不参与 N / ΣW） */
export type BehaviorMix = Record<BehaviorType, number>

/** `computeDependenceMetrics` 的返回结构（三端字段同名同序） */
export interface DependenceMetrics {
	/** AI 依赖度指数 ∈ [0,1]；N=0 → null */
	depIndex: number | null
	/** 行为加权均值 ∈ [0,1.2]；N=0 → null */
	weightedMean: number | null
	/** 自主编码占比 = self_code / (self_code + ai_code)；分母 0 → null */
	selfCodingRatio: number | null
	/** 采纳深化率 = 采纳后窗口内出现自主编码的 adopted 占比；无 adopted → null */
	adoptionDeepening: number | null
	/** 引导效果 = 1 - ai_code / demands；无索要 → null */
	guidanceEffect: number | null
	/** 报错解决率 = 报错后窗口内 `exit_code=0` 的 run_trace 占比；无 error_help → null */
	errorResolutionRate: number | null
	/** 六类行为计数 */
	behaviorMix: BehaviorMix
	/** 指标 schema 版本 */
	metricsSchema: string
}

/**
 * 极简事件视图：同时兼容 `student_interactions.log`（新旧字段）与提交层桥接进来的
 * `run_traces.jsonl` 事件。刻意保留索引签名，避免旧日志的未知字段导致类型报错。
 */
export interface MetricsEvent {
	/** ISO 8601 时间戳；缺失不丢事件（BN-39），且**不参与**窗口判定 */
	ts?: string
	taskId?: string
	eventType?: string
	role?: string
	/** 旧事件回退字段（P6/T8） */
	queryType?: string
	/** 【P2-1】显式行为类型（新字段永远优先，BN-41） */
	behaviorType?: string
	/** 【P2-1】显式行为权重（有限数时夹取使用，BN-40） */
	behaviorWeight?: number
	/** 【P2-1】行为信号串；包含 `full_impl_demand` 的事件计入 demands */
	behaviorSignals?: string
	/** 【P2-1】助手回合代码形态 */
	codeKind?: string
	/** 代码编辑归属（code_edit 事件） */
	editor?: string
	/** 助手是否给出可直接运行的完整实现 */
	hasFullImpl?: boolean
	/** 采纳推断状态（adoption_infer 事件） */
	adoptionStatus?: string
	/** 干预规则 id（旧字段 `complete_impl_demand` 不计 demands，契约只认 `full_impl_demand`） */
	interventionRuleId?: string
	/** 轮次索引；双方都有有限数时窗口按 turnIndex 差判定 */
	turnIndex?: number
	/** run_trace 的退出码（number 或 string 都接受） */
	exit_code?: number | string
	/** 旧日志 / 其他链路可能带上的未知字段 */
	[key: string]: unknown
}

/** 空计数表 */
function emptyBehaviorMix(): BehaviorMix {
	return { concept: 0, design: 0, error_help: 0, self_code: 0, ai_code: 0, other: 0 }
}

function isEventRecord(value: unknown): value is MetricsEvent {
	return typeof value === "object" && value !== null
}

/**
 * 规范化输入：非数组 → 空数组；数组中的 null / 非对象条目忽略；
 * **缺失 `ts` 的事件不丢弃**（BN-39）。
 */
function toEventList(events: unknown): MetricsEvent[] {
	if (!Array.isArray(events)) {
		return []
	}
	const list: MetricsEvent[] = []
	for (const item of events) {
		if (isEventRecord(item)) {
			list.push(item)
		}
	}
	return list
}

function isBehaviorType(value: unknown): value is BehaviorType {
	return typeof value === "string" && (BEHAVIOR_TYPES as readonly string[]).includes(value)
}

/**
 * 契约 §3：解析单个事件的行为类型（优先级从高到低，见契约原文）。
 */
export function resolveBehaviorType(event: MetricsEvent | null | undefined): BehaviorType {
	if (!isEventRecord(event)) {
		return "other"
	}
	// 1. 新字段永远优先（BN-41）
	if (isBehaviorType(event.behaviorType)) {
		return event.behaviorType
	}
	// 2. 代码编辑归属
	if (event.eventType === "code_edit") {
		return event.editor === "ai" ? "ai_code" : "self_code"
	}
	// 3. 保存文件即自主编码
	if (event.eventType === "file_save") {
		return "self_code"
	}
	// 4. 旧事件回退：queryType 映射（PLAN 测试 15）
	if (typeof event.queryType === "string" && Object.prototype.hasOwnProperty.call(QUERY_TYPE_FALLBACK, event.queryType)) {
		return QUERY_TYPE_FALLBACK[event.queryType]
	}
	// 5. 助手给出完整实现
	if (event.role === "assistant" && event.hasFullImpl === true) {
		return "ai_code"
	}
	// 6. 其余不计分
	return "other"
}

/**
 * 契约 §3：单事件权重。`other` 恒为 0；显式 `behaviorWeight` 为有限数时夹取到
 * `[0, MAX_BEHAVIOR_WEIGHT]`，越界时告警（BN-40）；否则按类型查表。
 */
export function eventWeight(event: MetricsEvent | null | undefined): number {
	const type = resolveBehaviorType(event)
	if (type === "other") {
		return 0
	}
	const configured = isEventRecord(event) ? event.behaviorWeight : undefined
	if (typeof configured === "number" && Number.isFinite(configured)) {
		const clamped = Math.min(MAX_BEHAVIOR_WEIGHT, Math.max(0, configured))
		if (clamped !== configured) {
			console.warn("[metricsSpec] behaviorWeight 越界，已夹取", {
				behaviorType: type,
				behaviorWeight: configured,
				clamped,
			})
		}
		return clamped
	}
	return BEHAVIOR_WEIGHTS[type]
}

/** 契约 §2：`round6(x) = Math.round(x * 1e6) / 1e6`（三端同式，不要改写） */
export function round6(n: number): number {
	return Math.round(n * 1e6) / 1e6
}

/** 契约 §5：六类行为计数 */
export function behaviorMix(events?: readonly MetricsEvent[] | null): BehaviorMix {
	const mix = emptyBehaviorMix()
	for (const event of toEventList(events)) {
		mix[resolveBehaviorType(event)] += 1
	}
	return mix
}

/** 参与计分的条数 N（不含 `other`） */
function scoredCount(mix: BehaviorMix): number {
	return mix.concept + mix.design + mix.error_help + mix.self_code + mix.ai_code
}

/** ΣW */
function sumEventWeights(events: readonly MetricsEvent[]): number {
	let total = 0
	for (const event of events) {
		total += eventWeight(event)
	}
	return total
}

/** 契约 §5：参与计分的条数（`behaviorMix` 中除 `other` 外的计数之和） */
export function dependencyCount(events?: readonly MetricsEvent[] | null): number {
	return scoredCount(behaviorMix(events))
}

/** 契约 §2：AI 依赖度指数；N=0 → null */
export function depIndex(events?: readonly MetricsEvent[] | null): number | null {
	const list = toEventList(events)
	const n = scoredCount(behaviorMix(list))
	if (n === 0) {
		return null
	}
	return round6(sumEventWeights(list) / (DEPENDENCY_DIVISOR * n))
}

/** 契约 §2：行为加权均值；N=0 → null */
export function weightedMean(events?: readonly MetricsEvent[] | null): number | null {
	const list = toEventList(events)
	const n = scoredCount(behaviorMix(list))
	if (n === 0) {
		return null
	}
	return round6(sumEventWeights(list) / n)
}

/** 契约 §2：自主编码占比；分母 0 → null */
export function selfCodingRatio(events?: readonly MetricsEvent[] | null): number | null {
	const mix = behaviorMix(events)
	const denominator = mix.self_code + mix.ai_code
	if (denominator === 0) {
		return null
	}
	return round6(mix.self_code / denominator)
}

/**
 * 契约 §4：两条事件之间的窗口距离。
 * `turnIndex` 双方都为有限数时用 `turnIndex` 差，否则用数组下标差。
 */
function windowDistance(list: readonly MetricsEvent[], fromIndex: number, toIndex: number): number {
	const fromTurn = list[fromIndex]?.turnIndex
	const toTurn = list[toIndex]?.turnIndex
	if (typeof fromTurn === "number" && Number.isFinite(fromTurn) && typeof toTurn === "number" && Number.isFinite(toTurn)) {
		return toTurn - fromTurn
	}
	return toIndex - fromIndex
}

/**
 * 契约 §4：`toIndex` 是否位于 `fromIndex` 之后、且距离不超过 `windowTurns`。
 * 事件流按数组顺序判定先后；`turnIndex` 倒退视为不在窗口内。
 */
function isWithinForwardWindow(
	list: readonly MetricsEvent[],
	fromIndex: number,
	toIndex: number,
	windowTurns: number,
): boolean {
	if (toIndex <= fromIndex) {
		return false
	}
	const distance = windowDistance(list, fromIndex, toIndex)
	return distance >= 0 && distance <= windowTurns
}

function isAdoptionEvent(event: MetricsEvent): boolean {
	return event.eventType === "adoption_infer" && event.adoptionStatus === "adopted"
}

/** 契约 §4：adopted 之后窗口内是否出现 `self_code` 类型事件 */
function hasSelfCodeWithin(list: readonly MetricsEvent[], fromIndex: number, windowTurns: number): boolean {
	for (let index = fromIndex + 1; index < list.length; index += 1) {
		if (!isWithinForwardWindow(list, fromIndex, index, windowTurns)) {
			continue
		}
		if (resolveBehaviorType(list[index]) === "self_code") {
			return true
		}
	}
	return false
}

/** 契约 §2 / §4：采纳深化率；无 adopted → null */
export function adoptionDeepening(events?: readonly MetricsEvent[] | null): number | null {
	const list = toEventList(events)
	let adoptedCount = 0
	let deepenedCount = 0
	for (let index = 0; index < list.length; index += 1) {
		if (!isAdoptionEvent(list[index])) {
			continue
		}
		adoptedCount += 1
		if (hasSelfCodeWithin(list, index, ADOPTION_WINDOW_TURNS)) {
			deepenedCount += 1
		}
	}
	if (adoptedCount === 0) {
		return null
	}
	return round6(deepenedCount / adoptedCount)
}

/** 契约 §4：`behaviorSignals` 含 `full_impl_demand`，或 `interventionRuleId` 为 `full_impl_demand` */
function isDemandEvent(event: MetricsEvent): boolean {
	if (typeof event.behaviorSignals === "string" && event.behaviorSignals.includes("full_impl_demand")) {
		return true
	}
	return event.interventionRuleId === "full_impl_demand"
}

/** demands 计数（guidanceEffect 的分母） */
function countDemandEvents(list: readonly MetricsEvent[]): number {
	let count = 0
	for (const event of list) {
		if (isDemandEvent(event)) {
			count += 1
		}
	}
	return count
}

/** 契约 §2：引导效果 = 1 - ai_code / demands；demands=0 → null */
export function guidanceEffect(events?: readonly MetricsEvent[] | null): number | null {
	const list = toEventList(events)
	const demands = countDemandEvents(list)
	if (demands === 0) {
		return null
	}
	const mix = behaviorMix(list)
	return round6(1 - mix.ai_code / demands)
}

/** 契约 §4：报错事件之后窗口内是否出现 `exit_code = 0` 的 run_trace */
function hasResolvedRunTraceWithin(list: readonly MetricsEvent[], fromIndex: number, windowTurns: number): boolean {
	for (let index = fromIndex + 1; index < list.length; index += 1) {
		if (!isWithinForwardWindow(list, fromIndex, index, windowTurns)) {
			continue
		}
		const event = list[index]
		if (event.eventType === "run_trace" && Number(event.exit_code) === 0) {
			return true
		}
	}
	return false
}

/** 契约 §2 / §4：报错解决率；无 error_help → null */
export function errorResolutionRate(events?: readonly MetricsEvent[] | null): number | null {
	const list = toEventList(events)
	const errorIndexes: number[] = []
	for (let index = 0; index < list.length; index += 1) {
		if (resolveBehaviorType(list[index]) === "error_help") {
			errorIndexes.push(index)
		}
	}
	if (errorIndexes.length === 0) {
		return null
	}
	let resolvedCount = 0
	for (const errorIndex of errorIndexes) {
		if (hasResolvedRunTraceWithin(list, errorIndex, ERROR_WINDOW_TURNS)) {
			resolvedCount += 1
		}
	}
	return round6(resolvedCount / errorIndexes.length)
}

/**
 * 契约 §5：一次性计算全部依赖度指标。
 *
 * 只对事件流做一次 `eventWeight` 求和（`console.warn` 每事件最多一次），其余指标从同一份
 * 计数派生，保证同一事件流上单函数计算结果与组合计算一致。
 */
export function computeDependenceMetrics(
	events?: readonly MetricsEvent[] | null,
): DependenceMetrics {
	const list = toEventList(events)
	const mix = behaviorMix(list)
	const n = scoredCount(mix)
	const totalWeight = sumEventWeights(list)
	const codingDenominator = mix.self_code + mix.ai_code
	const demands = countDemandEvents(list)
	return {
		depIndex: n === 0 ? null : round6(totalWeight / (DEPENDENCY_DIVISOR * n)),
		weightedMean: n === 0 ? null : round6(totalWeight / n),
		selfCodingRatio: codingDenominator === 0 ? null : round6(mix.self_code / codingDenominator),
		adoptionDeepening: adoptionDeepening(list),
		guidanceEffect: demands === 0 ? null : round6(1 - mix.ai_code / demands),
		errorResolutionRate: errorResolutionRate(list),
		behaviorMix: mix,
		metricsSchema: METRICS_SCHEMA,
	}
}
