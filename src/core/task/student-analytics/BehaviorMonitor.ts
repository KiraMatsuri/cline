/**
 * 实时行为监测器（轻量、非阻断）
 *
 * 目标：在插件运行期基于滚动窗口做行为模式检测，
 * 当检测到高依赖或单一行为趋势时，输出温和提醒。
 */

import { resolveBehaviorType, type MetricsEvent } from "@/core/teaching/behavior/metricsSpec"
import { normalizePathKey } from "@/shared/pathKeys"
import { Logger } from "@/shared/services/Logger"
import { type ConceptModeState, INITIAL_CONCEPT_MODE_STATE, nextConceptMode } from "./ConceptModeGate"
import { isCompleteImplDemand } from "./demandDetect"
import { isInabilityStatement } from "./inabilityDetect"
import { dependencyWeightForQueryType, type QueryType, toQueryType } from "./queryType"
import { FULL_IMPL_DEMAND_RELEASE_COUNT, getRulePolicy, SOFT_INTERVENTION_PRIORITY, type SoftInterventionRuleId } from "./rulePolicy"
import type { BehaviorAlert, BehaviorRuleId, DemandComplianceState, StudentInteractionLog, TaskCategory } from "./types"

export interface BehaviorMonitorOptions {
	enabled?: boolean
	/** 启用 debug 日志，输出每条 ingest 事件和规则检查结果 */
	debug?: boolean
	windowSize?: number
	cooldownMs?: number
	minTurnsForDependency?: number
	aiDependencyThreshold?: number
	noEditTurnStreakThreshold?: number
	consecutiveAssistantCodeThreshold?: number
	adoptionRateThreshold?: number
	selfModificationThreshold?: number
	minAdoptionSamples?: number
	/** 【P6/T7】依赖度加权和的命中阈值（默认 3 = 3 次编码类提问 或 6 次概念提问） */
	dependencyWeightedThreshold?: number
}

export const DEFAULT_OPTIONS: Readonly<Required<BehaviorMonitorOptions>> = Object.freeze({
	enabled: true,
	debug: false,
	windowSize: 20, // 覆盖 ~4 轮完整对话（每轮约 5 条事件）
	// 【方案 D 止血】15s → 120s。原值让同一条规则在几十秒内被反复计数，
	// 是"3 次提问就攒满升级阈值"的直接原因之一。
	cooldownMs: 120_000,
	// 【方案 D 止血】4 → 6。原值在"一次提问 = 7~11 个助手回合"的形态下太容易达到。
	// 【P6/T7】★ 本阈值已**退出 AI 依赖规则的判定**（该规则改为「学生请求加权和 ≥ dependencyWeightedThreshold」）：
	// 它算的是助手回合数，而概念问答的助手回合多是讲解，会把分母算歪 ⇒ 概念问题永远凑不满阈值。
	// 保留字段与默认值仅为向后兼容（配置透传 / 离线统计仍可能引用）。
	minTurnsForDependency: 6,
	// 【方案 D 止血】0.7 → 0.85。原阈值在 Cline 多工具循环下几乎必然被突破
	// （实测 3/4 个任务里用户 turn_message 数为 0，比例恒 100%）。
	// 【F9】在线规则已改为按绝对回合数判定，不再读取本阈值；保留字段与默认值仅为向后兼容
	// （离线统计等其它模块仍可能引用）。
	aiDependencyThreshold: 0.85,
	// 【方案 D 止血】5 → 8。该计数器对每个 turn_message 都 +1（助手回合也算），
	// 一次提问就能贡献 7~11，原值 5 等价于"问一句话就触发"。
	// 【P5-A】8 → 3 ★ 单位已改为「学生请求」（见 updateRealtimeStreaks）：
	// 8 现在意为"连续 8 次提问没动手"，与「及时干预」相悖；3 即"连续 3 次提问没动手 → 提醒"。
	// 【P6/T6】本规则**只提示、永不阻断**（阻断入口已收归 `ai_coding_rounds`）。
	noEditTurnStreakThreshold: 3,
	consecutiveAssistantCodeThreshold: 3,
	adoptionRateThreshold: 0.7,
	selfModificationThreshold: 0.25,
	minAdoptionSamples: 2,
	// 【P6/T7】依赖度按**询问类型加权**后，加权和的命中阈值 = 3。
	// 权重含义：概念问答 0.5 / 其余 1.0 ⇒ 3 次编码类提问 或 6 次概念提问命中（用户 2026-10-14 裁定）。
	dependencyWeightedThreshold: 3,
})

/** 【P6/T7】依赖度的滚动窗口（学生请求数） */
const DEPENDENCY_WINDOW_REQUESTS = 10

/** 【F5】可覆盖 `code_generation` 的"强信号"分类：都表示学生正在处理**新的具体代码** */
const STRONG_SIGNAL_CATEGORIES: ReadonlySet<TaskCategory> = new Set<TaskCategory>([
	"code_generation",
	"debugging",
	"refactoring",
	"testing",
])

/** 【P2-3】软提示判定阈值（设计 §5.2；单位 = 学生请求或事件次数） */
const DESIGN_STALL_THRESHOLD = 3
const CONCEPT_STREAK_THRESHOLD = 3
const AI_CODE_STREAK_THRESHOLD = 2
const SAME_ERROR_TWICE_THRESHOLD = 2
const ERROR_NO_PROGRESS_REQUESTS = 5

/** 【P2-2】同规则累计计数的告警阈值（旧阻断阈值退役后仅用于力度换算与可审计计数） */
const ESCALATION_COUNT_THRESHOLD = 3

/** 【P2-3】软提示候选（同一事件命中多条时按 `SOFT_INTERVENTION_PRIORITY` 只出一条，BN-37） */
interface SoftCandidate {
	ruleId: SoftInterventionRuleId
	message: string
	metricValue: number
	threshold: number
}

export class BehaviorMonitor {
	private readonly taskId: string
	private readonly options: Required<BehaviorMonitorOptions>
	private recentEvents: StudentInteractionLog[] = []
	private lastReminderAt: Partial<Record<BehaviorRuleId, number>> = {}
	/** 待消费的结构化风险警报队列 */
	private pendingAlerts: BehaviorAlert[] = []

	private assistantCodeStreak = 0
	/**
	 * 【P5-A】连续「**学生请求**」且期间没有代码编辑的计数（单位 = 学生回合，**不是**助手回合）。
	 * 实测（M4'）：一次提问会产生 6~12 个助手回合（每次工具调用一个回合），
	 * 按回合计数会让**一次长检索请求**就把阈值推满并连记 3 次违规 ⇒ 一次提问即被阻断。
	 * 单位改为「学生请求」后，一次请求最多推进 1 格。
	 */
	private turnsSinceLastEdit = 0
	/** 【P5-A】本学生请求内已计过违规的规则：保证同一请求内每条规则至多升级一次 */
	private bumpedRulesThisRequest = new Set<BehaviorRuleId>()
	/** 【P5-A】本任务内的学生请求数（含开题）；用于「一次提问内的多回合不算 AI 依赖」 */
	private studentRequestCount = 0
	/** 【P5/T16】当前请求是否在索要「完整实现」（`demandDetect.isCompleteImplDemand` 的结果） */
	private currentRequestIsDemand = false

	/** 【P6/T9】当前请求学生是否**明确表示自己写不出来**（`inabilityDetect.isInabilityStatement` 的结果） */
	private currentRequestIsInability = false
	/**
	 * 【P6/T9】服从流程状态：仅本轮有效 —— **两个终态**（`granted` / `denied`）都在请求边界复位为 `"none"`。
	 *
	 * 【P6/T9 fix F1】为何 `denied` 也是终态：见 `types.ts` 的 `DemandComplianceState`。
	 *
	 * ⚠️ 已知残留（【P6/T9 fix】登记，不阻塞）：若服从轮之后**没有**新的学生 ingest
	 * （模型直接 `attempt_completion` 结束任务、或学生关窗），`granted` 会留在实例上；
	 * 而 monitor 按 taskId 缓存（30 分钟 TTL，恢复会话会复用同一实例，见 `Task.monitorCache`）
	 * ⇒ 该窗口内恢复同一 taskId，首个 API 请求会在**没有新确认**的情况下继续注入服从约束
	 * （`buildDemandComplianceConstraint()`）。窗口 = 「30 分钟内恢复 且 期间无学生消息」；
	 * 彻底修法需在任务结束/挂起时显式 `reset()`。
	 */
	private demandComplianceState: DemandComplianceState = "none"

	/** 【P6/T7】最近 N 个学生请求的依赖度权重（滚动窗口） */
	private recentRequestWeights: number[] = []
	/**
	 * 【P8/T3（裁定 3-B）】本学生请求内由 AI 写过的文件（`file_save` / `code_edit` 且 `editor==="ai"`）。
	 * 与 `studentEditedFilesThisRequest` 做集合差，用来甄别「归属误判产生的伪学生编辑」。
	 */
	private aiWrittenFilesThisRequest = new Set<string>()
	/** 【P8/T3】本学生请求内出现过「人工编辑」的文件（`code_edit` 且 `editor!=="ai"`） */
	private studentEditedFilesThisRequest = new Set<string>()
	private currentRequestQueryType: QueryType = "other"
	private currentRequestDependencyWeight = 1

	/** 【方案 C-1】最近一次**学生**事件的意图分类（用于规则分流） */
	private currentTaskCategory: TaskCategory | undefined

	/** 【F3】概念问答模式的粘性状态（任务级；反复索要完整代码也不退出） */
	private conceptModeState: ConceptModeState = INITIAL_CONCEPT_MODE_STATE

	/** 同规则累计触发次数（用于可审计计数与力度换算） */
	private escalationCounter: Partial<Record<BehaviorRuleId, number>> = {}

	// ===== 【P2-3】六条软提示状态（只提示、永不阻断） =====

	/** 本学生请求内已产出提示的软规则（每条规则每请求至多 1 次） */
	private softFiredThisRequest = new Set<SoftInterventionRuleId>()
	/** 连续「设计/思路」类学生请求数（期间无 self_code） */
	private softDesignStreak = 0
	/** 连续「概念问答」类学生请求数（期间无 self_code） */
	private softConceptStreak = 0
	/** 连续出现 ai_code 的学生请求数（期间无 self_code） */
	private softAiCodeStreak = 0
	/** 本请求是否已计过 ai_code（同一请求内多个 ai_code 事件只推进一格） */
	private softAiCodeCountedThisRequest = false
	/** 上一学生请求内是否出现过 ai_code（请求边界结算 ai_code 连续性） */
	private softPrevRequestHadAiCode = false
	/** 完整实现索要次数（学生请求口径） */
	private softDemandCount = 0
	/** 相同报错签名出现次数（key = `exit_code|首行错误`） */
	private softErrorSignatureCounts = new Map<string, number>()
	/** error_help 之后经过的学生请求数（null = 当前没有未解决的报错求助） */
	private softErrorPendingRequests: number | null = null
	/** 最近一次软提示的规则（测试/日志审计用） */
	private softLastRuleId: SoftInterventionRuleId | null = null

	constructor(taskId: string, options?: BehaviorMonitorOptions) {
		this.taskId = taskId
		this.options = {
			...DEFAULT_OPTIONS,
			...options,
		}
	}

	public setEnabled(enabled: boolean): void {
		this.options.enabled = enabled
	}

	public ingest(event: StudentInteractionLog): void {
		if (!this.options.enabled) {
			return
		}

		if (event.taskId !== this.taskId) {
			return
		}

		this.recentEvents.push(event)
		if (this.recentEvents.length > this.options.windowSize) {
			this.recentEvents.shift()
		}

		if (this.options.debug) {
			Logger.info(
				`[BehaviorMonitor][debug] ingest event: type=${event.eventType}, role=${event.role}, hasCode=${event.hasCode}, window=${this.recentEvents.length}/${this.options.windowSize}`,
			)
		}

		// 【方案 C-1】只采纳"学生侧"事件的分类：首句提问是 task_start，后续追问是 turn_message。
		// 助手事件里也带 category，但那是"AI 输出被分成什么"，不能当学生意图用。
		// 【F3】该判定同时被下方概念护栏复用 —— 两者必须保持同一"学生侧意图"口径，故只算一次。
		const isStudentIntent = event.eventType === "task_start" || (event.eventType === "turn_message" && event.role === "user")
		if (isStudentIntent) {
			const prev = this.currentTaskCategory
			// 【F5】分类粘性：`code_generation` 一旦确立就"粘住" —— 后续的 algorithm/explanation/other
			// 不再覆盖它（实测：一个代码生成任务会因为追问「再实现一个快速排序」被判成 algorithm，
			// 使代码类规则被 rulePolicy 静默停用）。只有"在新代码上工作"的强信号才可覆盖。
			if (
				prev === undefined ||
				STRONG_SIGNAL_CATEGORIES.has(event.category as TaskCategory) ||
				prev !== "code_generation"
			) {
				this.currentTaskCategory = event.category
			}
		}
		// 【P5-A】请求边界（违规单位 = 一个**学生请求**）：
		//   - 清空「本请求已计数」集合 ⇒ 同一条规则在一次请求内至多升级一次；
		//   - 记录请求数（供「一次提问内的多回合不算 AI 依赖」使用）；
		//   - 重新判定本轮是否在索要完整实现（供 T16 的 complete_impl_demand 规则）。
		if (isStudentIntent) {
			// 【P8/T3（裁定 3-B）】先结算上一请求的「学生是否真的动手」，再开新请求的记账
			this.settleStudentEditReset()
			this.aiWrittenFilesThisRequest.clear()
			this.studentEditedFilesThisRequest.clear()
			this.bumpedRulesThisRequest.clear()
			// 【P2-3】软提示同样以「学生请求」为节流单位：每请求清空去重集合；
			// 同时结算上一请求的 ai_code 连续性（上一请求没有 ai_code ⇒ 连续计数中断）
			this.softFiredThisRequest.clear()
			if (this.studentRequestCount > 0 && !this.softPrevRequestHadAiCode) {
				this.softAiCodeStreak = 0
			}
			this.softPrevRequestHadAiCode = false
			this.softAiCodeCountedThisRequest = false
			this.studentRequestCount++
			this.currentRequestIsDemand = isCompleteImplDemand(event.rawContent)
			// 【P6/T9】服从态仅本轮：新的学生请求一律复位。
			// 【P6/T9 fix F1】**两个终态**都要复位：`denied` 必须与 `granted` 一样活到下一个学生请求
			// （期间 `attemptApiRequest` 会被工具轮与首 chunk 重试多次进入）—— 否则否认后门控重新武装 ⇒ 反复重问。
			if (this.demandComplianceState === "granted" || this.demandComplianceState === "denied") {
				this.demandComplianceState = "none"
			}
			this.currentRequestIsInability = isInabilityStatement(event.rawContent)
			// 【P6/T7】询问类型与权重：概念问答只记 50%（滚动窗口上限 10 个请求）
			this.currentRequestQueryType = toQueryType(event.category)
			this.currentRequestDependencyWeight = dependencyWeightForQueryType(this.currentRequestQueryType)
			this.recentRequestWeights.push(this.currentRequestDependencyWeight)
			if (this.recentRequestWeights.length > DEPENDENCY_WINDOW_REQUESTS) {
				this.recentRequestWeights.shift()
			}
		}
		// 【F3】概念护栏的任务级粘性：索要完整代码**不退出**。
		// ⚠️ 分类只在「学生侧」事件上读（isStudentIntent）：实测 adoption_infer 事件也带 category
		//    （如 language_request），若不加这个门，助手侧事件会误触发 CODE_WORK 退出。
		this.conceptModeState = nextConceptMode(this.conceptModeState, {
			category: isStudentIntent ? event.category : undefined,
			studentEdited: event.eventType === "code_edit" && event.editor !== "ai",
			wantsCompleteImpl: isStudentIntent && event.category === "code_generation",
		})

		this.updateRealtimeStreaks(event)

		// 【P8/T3（裁定 3-B）】记录本请求内的 AI 写盘（结算时与「学生编辑」做集合差）。
		// 注意：必须与 `updateRealtimeStreaks` 的“学生编辑”记录成对存在，
		// 否则 `settleStudentEditReset()` 会把归属误判当成真动手。
		if ((event.eventType === "code_edit" || event.eventType === "file_save") && event.editor === "ai" && event.filePath) {
			this.aiWrittenFilesThisRequest.add(normalizePathKey(event.filePath))
		}

		this.evaluateRules(event)
	}

	/**
	 * 【P8/T3（裁定 3-B）】把「上一请求内学生动过手」结算为明确的清零动作。
	 *
	 * 判定：`学生编辑过的文件` **减去** `同一请求内 AI 写过的文件` 仍有剩余 ⇒ 才算真的动手。
	 *
	 * 为什么延迟到请求边界：写盘归属误判产生的 `code_edit(editor=user)` 往往**早于**任何 AI 归属事件
	 * （2026-10-18 实测 4 次写盘里 3 次如此），即时判定看不到未来。只在边界看整个请求，
	 * 才符合裁定原文「同一学生请求内该文件没有任何 AI 写盘事件」。
	 */
	private settleStudentEditReset(): void {
		if (this.studentEditedFilesThisRequest.size === 0) {
			return
		}
		const genuine = [...this.studentEditedFilesThisRequest].filter((f) => !this.aiWrittenFilesThisRequest.has(f))
		if (genuine.length === 0) {
			// 整批“学生编辑”都落在本请求里被 AI 写过的文件上 ⇒ 归属误判，不清零
			Logger.info(`[BehaviorMonitor][${this.taskId}] student-edit ignored: same files were written by AI in this request`)
			return
		}
		this.clearAiCodingProgress(`student edited ${genuine.join(", ")}`)
	}

	/** 【P8/T3】“学生确实动手”的后果：阻断通道归零 + 依赖度窗口清空（同一误判的连带项） */
	private clearAiCodingProgress(reason: string): void {
		delete this.escalationCounter.ai_coding_rounds
		this.recentRequestWeights = []
		Logger.info(`[BehaviorMonitor][${this.taskId}] ai_coding_rounds reset → 0 (${reason})`)
	}

	private updateRealtimeStreaks(event: StudentInteractionLog): void {
		if (event.eventType === "code_edit") {
			// 【F2】只有「人」的编辑才算学生动手：AI 的 write_to_file / apply_patch 也会产生 code_edit，
			// 旧逻辑在此清零 streak，使 consecutive_code_generation 永远到不了 3（见 spec §7.4）。
			// 缺省 editor（旧日志）按人工处理，保持向后兼容。
			if (event.editor !== "ai") {
				this.turnsSinceLastEdit = 0
				// 学生主动编辑代码 → 重置 streak（阻断判定仅关注连续无编辑的代码生成）
				this.assistantCodeStreak = 0
				// 【P8/T3（裁定 3-B）】计数清零**不再当场发生**：写盘归属误判产生的
				// `code_edit(editor=user)` 常常**早于**任何 AI 归属事件（2026-10-18 实测 3/4 次如此），
				// 当场判定看不到未来 ⇒ 记入本请求集合，由 `settleStudentEditReset()` 在请求边界结算。
				// 没有 `filePath` 时无法做逐文件甄别（旧日志 / 异 fixtures）⇒ 保守地立即清零。
				if (event.filePath) {
					this.studentEditedFilesThisRequest.add(normalizePathKey(event.filePath))
				} else {
					this.clearAiCodingProgress("student edit (no filePath)")
				}
				if (this.options.debug) {
					Logger.info(
						`[BehaviorMonitor][debug] code_edit by student → turnsSinceLastEdit & assistantCodeStreak reset to 0`,
					)
				}
			} else if (this.options.debug) {
				// AI 落盘：既不清零也不额外计数（该回合已由 assistant turn_message 的 hasCodeBlock 计入）
				Logger.info(`[BehaviorMonitor][debug] code_edit by AI → streaks untouched (ai=${this.assistantCodeStreak})`)
			}
			return
		}

		if (event.eventType === "turn_message") {
			if (event.role === "assistant") {
				// 【v2.13 方案 A】streak 只认 **fenced 代码块**，不再认"文本里出现过代码/反引号/工具标记"。
				// 实测：DSML 工具标记与行内代码（如 `wiki_backend_unreachable`）都会被旧判定算成代码，
				// 把一个纯概念问答任务在几个回合内推到触发阈值。
				// 兼容：缺少该字段的旧事件回退到 hasCode。
				const hasRealCode = event.hasCodeBlock ?? event.hasCode
				if (hasRealCode) {
					this.assistantCodeStreak++
				}
				// hasCode=false 时不再清零 assistantCodeStreak
				// 只有在 code_edit 事件时才重置，避免 AI 发送非代码消息（如 execute_command / read_file / 提示文本）意外打断计数
			} else {
				// 【P5-A】★ 只有**学生回合**推进"连续未编辑"计数（一次请求 = 一格）。
				// 实测反例：一次提问产生 12 个助手回合 ⇒ 旧口径直接记成 12 格并连记 3 次违规。
				this.turnsSinceLastEdit++
			}
			// 【P5-A】退化口径：从未见过学生回合时（离线重放 / 单测 / 异常数据）仍按回合计数 ——
			// 宁可多计也不静默失效（与 rulePolicy「分类缺失时全部启用」同一保守原则）。
			if (event.role === "assistant" && this.studentRequestCount === 0) {
				this.turnsSinceLastEdit++
			}

			if (this.options.debug) {
				Logger.info(
					`[BehaviorMonitor][debug] streaks: assistantCodeStreak=${this.assistantCodeStreak}, turnsSinceLastEdit=${this.turnsSinceLastEdit}`,
				)
			}
		}
	}

	private evaluateRules(event: StudentInteractionLog): void {
		// 【方案 C-1】按学生意图分流：概念问答下停用代码类规则。
		// ⚠️ 【F1】升级计数已从 notify() 移入被本门控包裹的 check*Rule()，因此门控现在**同时停用
		// 「评估」与「计数」**（这也是「概念问答下不可升级」断言的依据）。updateRealtimeStreaks()
		// 仍会在每次 ingest 时推进 assistantCodeStreak / turnsSinceLastEdit，所以一旦 C-3 翻转把学生
		// 重分类为 code_generation，下一个助手回合就可能触发 consecutive_code_generation 并重新开始计数
		// —— 这是**有意行为**（回归场景 5 断言此点），不是 bug。
		const policy = (ruleId: BehaviorRuleId): boolean => getRulePolicy(ruleId, this.currentTaskCategory).enabled

		// 【P6/T5】独立阻断通道：只数"助手真的写了文件"，与其它规则解耦（不读 streak、不看分类之外的状态）。
		if (policy("ai_coding_rounds")) {
			this.checkAiCodingRoundsRule(event)
		}
		if (policy("consecutive_code_generation")) {
			this.checkConsecutiveCodeGenerationRule(event)
		}
		if (policy("no_edit_streak")) {
			this.checkNoEditStreakRule(event)
		}
		if (policy("high_adoption_low_self_modification")) {
			this.checkHighAdoptionLowSelfModificationRule(event)
		}
		if (policy("high_recent_ai_dependency")) {
			this.checkHighRecentAiDependencyRule(event)
		}
		if (policy("complete_impl_demand")) {
			this.checkCompleteImplDemandRule(event)
		}

		// 【P2-3】六条软提示：不受任务分类门控（见 rulePolicy.getSoftRulePolicy），
		// 但只产出 hint/question，绝不阻断任务。
		this.evaluateSoftRules(event)
	}

	/**
	 * 【F1】该事件是否构成一次「代码生成违规」计数。
	 * 违规单位 = **一个推进 assistantCodeStreak 的 turn_message**：助手回合且携带真实（fenced）代码块。
	 * 其它事件（user turn_message / adoption_infer / file_save / code_edit / task_start）不计 ——
	 * 否则单轮会因伴随事件被重复计数，或“学生提问”本身就把升级阈值推满（方案 D 想避免的情况）。
	 */
	private isAssistantCodeTurn(event: StudentInteractionLog): boolean {
		if (event.eventType !== "turn_message" || event.role !== "assistant") {
			return false
		}
		// 与 updateRealtimeStreaks() 保持同一判定：缺少 hasCodeBlock 的旧事件回退到 hasCode
		return event.hasCodeBlock ?? event.hasCode
	}

	private checkConsecutiveCodeGenerationRule(event: StudentInteractionLog): void {
		// 【F1】★ 计数与提醒冷却/阈值解耦：命中的回合当即计一次，不受 cooldownMs 影响；
		// 下面的 streak 阈值只在决定「是否发提醒」时生效。
		// 【P5-A】但计数**单位是学生请求**：同一请求内至多升级一次（一次提问可能含 2 个代码回合）。
		if (this.isAssistantCodeTurn(event)) {
			this.bumpOncePerRequest("consecutive_code_generation")
		}

		if (this.assistantCodeStreak < this.options.consecutiveAssistantCodeThreshold) {
			return
		}

		this.notify(
			"consecutive_code_generation",
			`检测到你连续 ${this.assistantCodeStreak} 次请求代码生成，建议先尝试自行修改一小段，再让 AI 帮你 review。`,
			this.assistantCodeStreak,
			this.options.consecutiveAssistantCodeThreshold,
		)
	}

	private checkNoEditStreakRule(event: StudentInteractionLog): void {
		// 【F1-fix】★ 违规单位 = **规则条件成立的那一个 turn_message**（turnsSinceLastEdit >= 阈值），
		// 不是「任意 turn_message」。旧写法在条件判断**之前**无条件 bump，等于每来一个回合就记一次违规：
		// 阈值 3 时学生「边改代码边提问」问到第 3 句就被误阻断（且学生真的编辑时计数器并不归零）。
		// 计数仍与提醒冷却解耦（不受 cooldownMs 影响），阈值也仍在决定「是否发提醒」时生效。
		if (this.turnsSinceLastEdit < this.options.noEditTurnStreakThreshold) {
			return
		}

		if (event.eventType === "turn_message") {
			// 【P5-A】单位 = 学生请求（计数只由学生回合推进 + 本请求内至多一次）
			this.bumpOncePerRequest("no_edit_streak")
		}

		this.notify(
			"no_edit_streak",
			`你已经连续 ${this.turnsSinceLastEdit} 轮没有代码编辑，建议动手验证或微调一处关键实现。`,
			this.turnsSinceLastEdit,
			this.options.noEditTurnStreakThreshold,
		)
	}

	/**
	 * 【P5/T16】直接索要「完整实现」。
	 *
	 * 单位 = **学生请求**（`bumpOncePerRequest`）⇒ 第 3 次索要计数为 3。
	 * 【P6/T6】但本规则**永不阻断**（阻断只由 `ai_coding_rounds` 承担）；它的职责是计数、发提示，
	 * 并作为 b+c 服从流程（"我不会写" ⇒ 询问一次 ⇒ 确认后给完整实现）的入口 — 即 M6'' 的口径。
	 * 本规则不依赖 `assistantCodeStreak` / `turnsSinceLastEdit`，因此概念型任务里也能生效。
	 */
	private checkCompleteImplDemandRule(event: StudentInteractionLog): void {
		// 只在**学生侧入口事件**（开题 / 学生回合）上推进：`code_edit`、`adoption_infer` 等伴生事件
		// 不该被当成"又一次索要完整实现"（计数单位是学生请求，由其入口事件触发；与 dedupe 共同保证 ≤1/请求）。
		if (event.eventType !== "turn_message" && event.eventType !== "task_start") {
			return
		}
		if (!this.currentRequestIsDemand) {
			return
		}

		const count = this.bumpOncePerRequest("complete_impl_demand")

		this.notify(
			"complete_impl_demand",
			`这是本任务第 ${count} 次直接索要完整实现。先自己写一版（哪怕只有循环骨架），再让 AI 对照，学得最快。`,
			count,
			ESCALATION_COUNT_THRESHOLD,
		)
	}

	/**
	 * 【P6/T5 + P7/T3】独立阻断通道：助手**代写**了几次。
	 *
	 * 两个信号（任一成立即 +1，同一请求仍最多 +1）：
	 *   A. `code_edit` 且 `editor === "ai"` —— 真的把文件写到了磁盘
	 *      （F2/F11 已保证 AI 落盘事件的归属；等价于 write_to_file / replace_in_file / apply_patch 成功写盘）；
	 *   B. 【P7/T3（裁定 2）】`turn_message` + 助手 + `hasFullImpl` —— 在回复里给出了**可直接运行的完整实现**。
	 *
	 * 为什么需要 B（2026-10-18 实测）：在「学生反复索要完整实现」这一目标场景里，拒答约束让助手
	 * **一次也不落盘**（全会话 0 个 `code_edit`）⇒ 只认落盘的通道结构性不可达，阻断永不触发。
	 * B 把「代写」的口径从"写进文件"扩到"给出了完整实现"，与询问文案「连续 3 次直接编码」一致。
	 *
	 * 单位 = 一个学生请求内至多 1 次 —— 同一请求里写 3 个文件、或流式帧 + `attempt_completion`
	 * 把同一段完整实现记两次，都是"一件事"。
	 */
	private checkAiCodingRoundsRule(event: StudentInteractionLog): void {
		const wroteFile = event.eventType === "code_edit" && event.editor === "ai"
		const deliveredFullImpl = event.eventType === "turn_message" && event.role === "assistant" && event.hasFullImpl === true
		if (!wroteFile && !deliveredFullImpl) {
			return
		}
		const count = this.bumpOncePerRequest("ai_coding_rounds")
		this.notify(
			"ai_coding_rounds",
			`我已经替你写了 ${count} 次完整代码（本次来源：${wroteFile ? "写入代码文件" : "给出完整实现"}）。接下来请自己动手写一版，哪怕只是循环骶架。`,
			count,
			ESCALATION_COUNT_THRESHOLD,
		)
	}

	/** 【P6/T5 + P7/T3】独立阻断通道的当前计数（= 助手代写次数：落盘 **或** 给出完整实现） */
	public getAiCodingCount(): number {
		return this.getEscalationCount("ai_coding_rounds")
	}

	/**
	 * 【F1】累加某规则的升级计数并返回新值。
	 * 与 notify() 解耦：提醒受 cooldownMs 节流，计数不受任何冷却影响。
	 */
	private bumpEscalation(ruleId: BehaviorRuleId): number {
		const n = (this.escalationCounter[ruleId] ?? 0) + 1
		this.escalationCounter[ruleId] = n
		return n
	}

	/**
	 * 【P5-A】违规单位 = **一个学生请求**：同一请求内同一条规则至多升级一次。
	 * 防止"一次长请求内连记数次违规"（实测 M4' 一次提问即达阻断阈值）。
	 */
	private bumpOncePerRequest(ruleId: BehaviorRuleId): number {
		// 【P5-A】退化口径（从未见过学生回合）：不做每请求去重，按回合计数
		if (this.studentRequestCount > 0) {
			if (this.bumpedRulesThisRequest.has(ruleId)) {
				return this.getEscalationCount(ruleId)
			}
			this.bumpedRulesThisRequest.add(ruleId)
		}
		return this.bumpEscalation(ruleId)
	}

	private checkHighAdoptionLowSelfModificationRule(event: StudentInteractionLog): void {
		const determinedAdoptions = this.recentEvents.filter(
			(e) => e.eventType === "adoption_infer" && e.adoptionStatus && e.adoptionStatus !== "unknown",
		)
		if (determinedAdoptions.length < this.options.minAdoptionSamples) {
			if (this.options.debug) {
				Logger.info(
					`[BehaviorMonitor][debug] adoption rule skipped: samples=${determinedAdoptions.length} < min=${this.options.minAdoptionSamples}`,
				)
			}
			return
		}

		const adoptedCount = determinedAdoptions.filter((e) => e.adoptionStatus === "adopted").length
		const adoptionRate = adoptedCount / determinedAdoptions.length

		const assistantWithCodeCount = this.recentEvents.filter(
			(e) => e.eventType === "turn_message" && e.role === "assistant" && e.hasCode,
		).length
		if (assistantWithCodeCount === 0) {
			return
		}

		const codeEditCount = this.recentEvents.filter((e) => e.eventType === "code_edit").length
		const selfModificationRate = Math.min(codeEditCount / assistantWithCodeCount, 1)

		if (this.options.debug) {
			Logger.info(
				`[BehaviorMonitor][debug] adoption rule: adoptionRate=${(adoptionRate * 100).toFixed(0)}%(threshold=${(this.options.adoptionRateThreshold * 100).toFixed(0)}%), selfMod=${(selfModificationRate * 100).toFixed(0)}%(threshold=${(this.options.selfModificationThreshold * 100).toFixed(0)}%)`,
			)
		}

		if (
			adoptionRate >= this.options.adoptionRateThreshold &&
			selfModificationRate <= this.options.selfModificationThreshold
		) {
			// 【T9-b / 裁定 C】★ 与其它两条规则同口径：命中即计数，不受提醒冷却影响。
			// 违规单位沿用 F1 的统一口径 —— **一个推进 assistantCodeStreak 的助手代码回合**。
			// 本规则的命中条件来自滚动窗口的聚合量（不由当前事件单独决定），所以必须靠事件单位
			// 约束计数频率：若写成「每次 ingest 命中即 +1」，一次提问（约 5~11 条事件）就会把阈值推满。
			// 归因：F1 把自增从 notify()（受 120s 冷却节流）移出后，此处若不同步补上，
			// 该规则的升级计数将**恒为 0** —— 命中只产生提醒，永远升不了级。
			if (this.isAssistantCodeTurn(event)) {
				this.bumpOncePerRequest("high_adoption_low_self_modification")
			}

			this.notify(
				"high_adoption_low_self_modification",
				`近期建议采纳率较高（${(adoptionRate * 100).toFixed(0)}%），但自主修改偏少，建议在采纳后再做一次本地优化。`,
				adoptionRate,
				this.options.adoptionRateThreshold,
			)
		}
	}

	/**
	 * 【P6/T7】AI 依赖度 = 窗口内学生请求的**加权和**（概念问答 0.5 / 其余 1）。
	 * 命中只发**温和提示**，永不阻断（`rulePolicy` 把唯一阻断入口留给 `ai_coding_rounds`）。
	 * 单位是学生请求 ⇒ 一次长检索（多助手回合）不会把它击穿（F9 的教训）。
	 */
	private checkHighRecentAiDependencyRule(event: StudentInteractionLog): void {
		if (event.eventType !== "turn_message") {
			return
		}
		// 【P6/T7】旧门控（`assistantTurnsWithoutUser >= minTurnsForDependency` + `studentRequestCount < 2`）已删除：
		// 它算的是「学生未参与的**助手回合**数」，在「问一句 → 6~12 个助手回合」的形态下与依赖度无关，
		// 且概念问答的助手回合多为讲解、本就不应计入 ⇒ 概念问题永远凑不满 ⇒ 整条规则静默失效。
		// 现在分母（学生请求加权和）本身就可靠，单次提问的 0.5/1.0 远低于阈值 3，M1' 自然不受影响。
		const score = this.getWeightedDependencyScore()
		if (score < this.options.dependencyWeightedThreshold) {
			return
		}

		this.bumpOncePerRequest("high_recent_ai_dependency")
		this.notify(
			"high_recent_ai_dependency",
			`最近 ${this.recentRequestWeights.length} 次提问累计依赖度 ${score.toFixed(1)}（概念问答按 50% 计），建议先写思路或伪代码再请求完整答案。`,
			score,
			this.options.dependencyWeightedThreshold,
		)
	}

	// =============================================
	// 【P2-3】六条软提示：只提示、永不阻断
	// =============================================

	/**
	 * 软提示统一入口（设计 §5.2）。
	 *
	 * 六条规则的触发语义：
	 * - design_stall：连续 3 个「设计/思路」类学生请求且期间无 self_code；
	 * - same_error_twice：同一 exit_code + 同一首行错误出现 2 次；
	 * - full_impl_demand：本轮直接索要完整实现（第 4 次起文案放行为伪代码）；
	 * - ai_code_streak：连续 2 个学生请求里都有 ai_code 且期间无 self_code；
	 * - concept_streak：连续 3 个「概念问答」类学生请求且期间无 self_code；
	 * - error_no_progress：error_help 之后 5 个学生请求内没有 file_save/self_code 进展。
	 *
	 * 节流：每规则每学生请求 ≤ 1 条 + 120s 冷却（沿用 `notify` 的 `cooldownMs`）；
	 * 同一事件命中多条时按 `SOFT_INTERVENTION_PRIORITY` 只出一条（BN-37）。
	 */
	private evaluateSoftRules(event: StudentInteractionLog): void {
		const isStudentIntent =
			event.eventType === "task_start" || (event.eventType === "turn_message" && event.role === "user")
		// 优先读 P2-1 写入的 behaviorType；旧日志没有该字段时由 resolveBehaviorType 按
		// code_edit/file_save/queryType 回退推断（Lead 在 task/index.ts 接入分类器前也能工作）。
		const behaviorType = resolveBehaviorType(event as unknown as MetricsEvent)

		// ① self_code = 学生真的动手：打断所有「连续…且无 self_code」计数，并视为 error_help 有进展
		if (behaviorType === "self_code") {
			this.softDesignStreak = 0
			this.softConceptStreak = 0
			this.softAiCodeStreak = 0
			this.softErrorPendingRequests = null
		}

		// ② ai_code 连续性：按学生请求计数，同一请求内多个 ai_code 事件只推进一格
		if (behaviorType === "ai_code") {
			this.softPrevRequestHadAiCode = true
			if (!this.softAiCodeCountedThisRequest) {
				this.softAiCodeCountedThisRequest = true
				this.softAiCodeStreak++
			}
		}

		const candidates: SoftCandidate[] = []

		if (behaviorType === "ai_code" && this.softAiCodeStreak >= AI_CODE_STREAK_THRESHOLD) {
			candidates.push({
				ruleId: "ai_code_streak",
				message: `连续 ${this.softAiCodeStreak} 个学生请求里都由我（AI）给出了代码，建议读懂后自己改 3 行。`,
				metricValue: this.softAiCodeStreak,
				threshold: AI_CODE_STREAK_THRESHOLD,
			})
		}

		if (isStudentIntent) {
			// ③ design / concept 连续计数（两类互斥：出现任意其它类型即打断「连续」）
			if (behaviorType === "design") {
				this.softDesignStreak++
				this.softConceptStreak = 0
			} else if (behaviorType === "concept") {
				this.softConceptStreak++
				this.softDesignStreak = 0
			} else {
				this.softDesignStreak = 0
				this.softConceptStreak = 0
			}

			if (this.softDesignStreak >= DESIGN_STALL_THRESHOLD) {
				candidates.push({
					ruleId: "design_stall",
					message: `连续 ${this.softDesignStreak} 次停在设计阶段，建议先用 3 行伪代码写下你的猜测。`,
					metricValue: this.softDesignStreak,
					threshold: DESIGN_STALL_THRESHOLD,
				})
			}
			if (this.softConceptStreak >= CONCEPT_STREAK_THRESHOLD) {
				candidates.push({
					ruleId: "concept_streak",
					message: `连续 ${this.softConceptStreak} 次概念提问，建议先动手写一行最小示例再回来问。`,
					metricValue: this.softConceptStreak,
					threshold: CONCEPT_STREAK_THRESHOLD,
				})
			}

			// ④ 完整实现索要：本轮索要即提示；第 4 次起文案层放行为伪代码（见 generator）
			if (this.currentRequestIsDemand) {
				this.softDemandCount++
				candidates.push({
					ruleId: "full_impl_demand",
					message: `第 ${this.softDemandCount} 次直接索要完整实现，建议先写出思路与伪代码，再要代码。`,
					metricValue: this.softDemandCount,
					threshold: FULL_IMPL_DEMAND_RELEASE_COUNT,
				})
			}

			// ⑤ same_error_twice：同一 exit_code + 同一首行错误出现 2 次
			const errorSignature = this.extractSoftErrorSignature(event.rawContent)
			if (errorSignature) {
				const signatureCount = (this.softErrorSignatureCounts.get(errorSignature) ?? 0) + 1
				if (signatureCount >= SAME_ERROR_TWICE_THRESHOLD) {
					this.softErrorSignatureCounts.set(errorSignature, 0)
					candidates.push({
						ruleId: "same_error_twice",
						message: `同一个报错出现了 ${signatureCount} 次，建议把最小复现代码缩到能复现的那 5 行。`,
						metricValue: signatureCount,
						threshold: SAME_ERROR_TWICE_THRESHOLD,
					})
				} else {
					this.softErrorSignatureCounts.set(errorSignature, signatureCount)
				}
			}

			// ⑥ error_no_progress：error_help 后 5 个学生请求内没有保存/自主编码进展
			if (behaviorType === "error_help") {
				this.softErrorPendingRequests = 0
			} else if (this.softErrorPendingRequests !== null) {
				this.softErrorPendingRequests++
				if (this.softErrorPendingRequests >= ERROR_NO_PROGRESS_REQUESTS) {
					this.softErrorPendingRequests = null
					candidates.push({
						ruleId: "error_no_progress",
						message: `报错求助后 ${ERROR_NO_PROGRESS_REQUESTS} 个请求都没有新的保存/运行痕迹，建议加一行 print 看变量。`,
						metricValue: ERROR_NO_PROGRESS_REQUESTS,
						threshold: ERROR_NO_PROGRESS_REQUESTS,
					})
				}
			}
		}

		// ⑦ BN-37：同一事件最多一条软提示，按优先级取最高（被冷却/去重拦下则顺延下一条）
		for (const ruleId of SOFT_INTERVENTION_PRIORITY) {
			const candidate = candidates.find((item) => item.ruleId === ruleId)
			if (candidate && this.pushSoftAlert(candidate)) {
				return
			}
		}
	}

	/** 【P2-3】记录并产出一条软提示；false = 被「本请求去重」或「规则冷却」拦下 */
	private pushSoftAlert(candidate: SoftCandidate): boolean {
		if (this.softFiredThisRequest.has(candidate.ruleId)) {
			return false
		}
		const now = Date.now()
		const lastShownAt = this.lastReminderAt[candidate.ruleId] ?? 0
		if (now - lastShownAt < this.options.cooldownMs) {
			return false
		}
		this.softFiredThisRequest.add(candidate.ruleId)
		this.softLastRuleId = candidate.ruleId
		this.notify(candidate.ruleId, candidate.message, candidate.metricValue, candidate.threshold)
		return true
	}

	/** 【P2-3】最近一次软提示的规则 ID（null = 尚未触发；测试与日志审计用） */
	public getLastSoftRuleId(): SoftInterventionRuleId | null {
		return this.softLastRuleId
	}

	/**
	 * 【P2-3】提取「同一个报错」的签名：`exit_code|首行错误`。
	 * 轻量正则启发式，不追求完备；同一 exit_code 且首行错误文本相同即视为同一个报错。
	 */
	private extractSoftErrorSignature(rawContent: string | undefined): string | null {
		const text = (rawContent ?? "").trim()
		if (text.length === 0) {
			return null
		}
		const exitCodeMatch = /exit[_\s-]?code\s*[:=：]?\s*(-?\d+)/i.exec(text)
		const errorLineMatch =
			/([A-Za-z_$][\w.$]*(?:Error|Exception|ExitStatus)\b[^\n]{0,100})/.exec(text) ??
			/(?:报错|错误|异常|失败)[：:]\s*([^\n]{0,100})/.exec(text)
		const errorLine = (errorLineMatch?.[1] ?? "").replace(/\s+/g, " ").trim()
		if (!exitCodeMatch && errorLine.length === 0) {
			return null
		}
		return `${exitCodeMatch?.[1] ?? "?"}|${errorLine.slice(0, 100)}`
	}

	/** 【P6/T7】当前滚动窗口的加权依赖度 */
	public getWeightedDependencyScore(): number {
		return this.recentRequestWeights.reduce((sum, w) => sum + w, 0)
	}

	/** 【P6/T7】本轮请求的询问类型（供日志字段使用） */
	public getCurrentRequestQueryType(): QueryType {
		return this.currentRequestQueryType
	}

	/** 【P6/T7】本轮请求的依赖度权重 */
	public getCurrentRequestDependencyWeight(): number {
		return this.currentRequestDependencyWeight
	}

	private notify(ruleId: BehaviorRuleId, message: string, metricValue: number = 0, threshold: number = 0): void {
		const now = Date.now()
		const lastTs = this.lastReminderAt[ruleId] ?? 0
		if (now - lastTs < this.options.cooldownMs) {
			return
		}

		this.lastReminderAt[ruleId] = now

		// 【F1】冷却只挡提示，不再挡计数：计数已由 check*Rule() 在冷却之外完成，
		// 此处仅读取当前累计值（原为 `?? 0) + 1`，导致阈值被 120s 冷却结构性锁死）。
		const escalationCount = this.getEscalationCount(ruleId)

		Logger.info(
			`[BehaviorMonitor][${this.taskId}][${ruleId}] ${message} (escalationCount=${escalationCount})`,
		)

		// 生成结构化警报，附带回退计数，供 TeachingInterventionManager 消费
		const alert: BehaviorAlert = {
			ruleId,
			message,
			triggeredAt: new Date().toISOString(),
			metricValue,
			threshold,
			escalationCount,
			// 【P7/T4】记录学生请求序号：未被展示的警报最多顺延 1 个请求（见 dropStaleAlerts）
			studentRequest: this.studentRequestCount,
		}
		this.pendingAlerts.push(alert)
	}

	/**
	 * 查看当前是否有待处理的风险警报（只读）
	 */
	public hasPendingAlerts(): boolean {
		return this.pendingAlerts.length > 0
	}

	/**
	 * 获取所有待处理的警报（只读快照，不清空队列）。
	 * 【P7/T4】返回**副本**：此前直接返回内部数组，调用方拿到的活引用会在后续 ingest 时静默变长
	 * （`before.length` 先后读两次会得到不同值，测试与日志都容易误读）。
	 */
	public getPendingAlerts(): ReadonlyArray<BehaviorAlert> {
		return [...this.pendingAlerts]
	}

	/**
	 * 消费（获取并清空）所有待处理的警报
	 * 调用后队列被清空，同一组警报只会被消费一次
	 */
	public consumePendingAlerts(): BehaviorAlert[] {
		const alerts = [...this.pendingAlerts]
		this.pendingAlerts = []
		return alerts
	}

	/**
	 * 【P7/T4（裁定 3）】只移除**已经展示给学生的那一条**警报。
	 *
	 * 旧行为是 `consumePendingAlerts()` 清空整队后只展示优先级最高的一条 ⇒ 其余规则
	 * 的警报**永久丢失**（2026-10-18 实测：加权依赖度 4.0 ≥ 3 已达阈并入了队，
	 * 却被同轮 `no_edit_streak` 挤掉，此后 120s 规则冷却使它再也无法入队）。
	 */
	public dropAlert(alert: BehaviorAlert): boolean {
		const index = this.pendingAlerts.indexOf(alert)
		if (index < 0) {
			return false
		}
		this.pendingAlerts.splice(index, 1)
		return true
	}

	/**
	 * 【P7/T4（裁定 3）】丢弃过期警报：触发于 `maxCarryRequests` 个学生请求之前的未展示警报。
	 *
	 * 为什么需要：顺延后如果一直有更高优先级的规则在抢，陈年提示可能在几十秒后突然冒出，
	 * 那时学生早已不在同一个语境里。默认只顺延 1 个学生请求。
	 * @returns 被丢弃的警报（供调用方写日志）
	 */
	public dropStaleAlerts(maxCarryRequests = 1): BehaviorAlert[] {
		const stale = this.pendingAlerts.filter(
			(alert) => alert.studentRequest !== undefined && alert.studentRequest < this.studentRequestCount - maxCarryRequests,
		)
		if (stale.length > 0) {
			this.pendingAlerts = this.pendingAlerts.filter((alert) => !stale.includes(alert))
		}
		return stale
	}

	/** 【方案 C-1】当前任务的学生意图分类（未捕获到时为 undefined） */
	public getTaskCategory(): TaskCategory | undefined {
		return this.currentTaskCategory
	}

	/** 【F3】当前任务的概念问答模式粘性状态（供 index.ts 决定是否注入护栏） */
	public getConceptModeState(): ConceptModeState {
		return { ...this.conceptModeState }
	}
	/** 【P5-A】本任务内的学生请求数（供 index.ts 判"一轮内多回合"与记账去重） */
	public getStudentRequestCount(): number {
		return this.studentRequestCount
	}

	/** 【P5/T16】当前请求是否在索要「完整实现」（index.ts 据此注入"本轮不得给出完整实现"约束） */
	public isCurrentRequestDemand(): boolean {
		return this.currentRequestIsDemand
	}

	/** 【P6/T9】本轮学生是否明确表示"自己写不出来" */
	public isCurrentRequestInability(): boolean {
		return this.currentRequestIsInability
	}

	/** 【P6/T9】服从流程状态 */
	public getDemandComplianceState(): DemandComplianceState {
		return this.demandComplianceState
	}

	/** 【P6/T9】已向学生询问一次（本轮不再重复询问） */
	public markDemandComplianceAsked(): void {
		this.demandComplianceState = "asked"
	}

	/** 【P6/T9】学生已确认 → 本轮给出完整实现 */
	public markDemandComplianceGranted(): void {
		this.demandComplianceState = "granted"
	}

	/**
	 * 【P6/T9 fix F1】学生否认 / `ask` 抛错中止 → 终态 `denied`（**本学生请求内不再询问**）。
	 *
	 * 终止态同样落 `denied` 的理由：`ask` 抛错（任务中止 / ask promise 被忽略）时若停在 `"asked"`，
	 * 请求边界的复位分支（只认两个终态）不会命中 ⇒ 该 taskId（含 30 分钟内恢复会话复用同一实例）
	 * 再也进不了 b+c 流程。
	 *
	 * ⚠️ 否认时**不要**把状态打回 `"none"`：那会让 `index.ts` 的询问门控在**同一学生请求内**重新武装
	 * （`attemptApiRequest` 会被工具轮与首 chunk 重试多次进入）⇒ 每隔一轮重问一次。
	 * 复位只发生在请求边界（见 `ingest()`）与 `reset()`。
	 */
	public markDemandComplianceDenied(): void {
		this.demandComplianceState = "denied"
	}

	/**
	 * 获取同规则累计触发次数
	 */
	public getEscalationCount(ruleId: BehaviorRuleId): number {
		return this.escalationCounter[ruleId] ?? 0
	}

	/**
	 * 重置所有状态（通常在任务重启时调用）
	 */
	public reset(): void {
		this.recentEvents = []
		this.lastReminderAt = {}
		this.pendingAlerts = []
		this.assistantCodeStreak = 0
		this.turnsSinceLastEdit = 0
		this.bumpedRulesThisRequest = new Set<BehaviorRuleId>()
		this.studentRequestCount = 0
		this.currentRequestIsDemand = false
		// 【P8/T3】写盘/编辑归属集合一并复位（跨任务不得残留“上一请求 AI 写过某文件”）
		this.aiWrittenFilesThisRequest = new Set<string>()
		this.studentEditedFilesThisRequest = new Set<string>()
		// 【P6/T9】服从流程状态一并复位（跨任务不得残留"已获准"）
		this.currentRequestIsInability = false
		this.demandComplianceState = "none"
		// 【P6/T7】依赖度加权窗口与本轮询问类型一并复位（否则恢复会话后会带着上次的分数）
		this.recentRequestWeights = []
		this.currentRequestQueryType = "other"
		this.currentRequestDependencyWeight = 1
		this.escalationCounter = {}
		// 【P6/T5】`ai_coding_rounds` 的计数就存在 `escalationCounter` 里，随上面一行一并清空
		//（原先紧跟一行 `delete this.escalationCounter.ai_coding_rounds` 是 no-op 死代码，已删）。
		// 【P2-3】软提示状态一并复位（跨任务不得残留上一任务的连续计数/去重）
		this.softFiredThisRequest = new Set<SoftInterventionRuleId>()
		this.softDesignStreak = 0
		this.softConceptStreak = 0
		this.softAiCodeStreak = 0
		this.softAiCodeCountedThisRequest = false
		this.softPrevRequestHadAiCode = false
		this.softDemandCount = 0
		this.softErrorSignatureCounts = new Map<string, number>()
		this.softErrorPendingRequests = null
		this.softLastRuleId = null
		this.currentTaskCategory = undefined
		this.conceptModeState = INITIAL_CONCEPT_MODE_STATE
	}
}
