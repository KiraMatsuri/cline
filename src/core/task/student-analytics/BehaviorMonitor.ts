/**
 * 实时行为监测器（轻量、非阻断）
 *
 * 目标：在插件运行期基于滚动窗口做行为模式检测，
 * 当检测到高依赖或单一行为趋势时，输出温和提醒。
 */

import { Logger } from "@/shared/services/Logger"
import { type ConceptModeState, INITIAL_CONCEPT_MODE_STATE, nextConceptMode } from "./ConceptModeGate"
import { isCompleteImplDemand } from "./demandDetect"
import { getRulePolicy } from "./rulePolicy"
import type { BehaviorAlert, BehaviorRuleId, StudentInteractionLog, TaskCategory } from "./types"

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
	/** 触发阻断式干预的同规则累计次数阈值（默认 3 次） */
	escalationBlockingThreshold?: number
}

export const DEFAULT_OPTIONS: Readonly<Required<BehaviorMonitorOptions>> = Object.freeze({
	enabled: true,
	debug: false,
	windowSize: 20, // 覆盖 ~4 轮完整对话（每轮约 5 条事件）
	// 【方案 D 止血】15s → 120s。原值让同一条规则在几十秒内被反复计数，
	// 是"3 次提问就攒满升级阈值"的直接原因之一。
	cooldownMs: 120_000,
	// 【方案 D 止血】4 → 6。原值在"一次提问 = 7~11 个助手回合"的形态下太容易达到。
	minTurnsForDependency: 6,
	// 【方案 D 止血】0.7 → 0.85。原阈值在 Cline 多工具循环下几乎必然被突破
	// （实测 3/4 个任务里用户 turn_message 数为 0，比例恒 100%）。
	// 【F9】在线规则已改为按绝对回合数判定，不再读取本阈值；保留字段与默认值仅为向后兼容
	// （离线统计等其它模块仍可能引用）。
	aiDependencyThreshold: 0.85,
	// 【方案 D 止血】5 → 8。该计数器对每个 turn_message 都 +1（助手回合也算），
	// 一次提问就能贡献 7~11，原值 5 等价于"问一句话就触发"。
	// 【P5-A】8 → 3 ★ 单位已改为「学生请求」（见 updateRealtimeStreaks）：
	// 8 现在意为"连续 8 次提问没动手"，与「及时干预」相悖；3 即"连续 3 次提问没动手 → 提醒"，
	// 对齐 M4'（第 3 次索要完整实现即阻断）与 M6'（新一轮索要计入升级计数）的口径。
	noEditTurnStreakThreshold: 3,
	consecutiveAssistantCodeThreshold: 3,
	adoptionRateThreshold: 0.7,
	selfModificationThreshold: 0.25,
	minAdoptionSamples: 2,
	// 【F1】6 → 3：对齐「第 3 次违规即阻断」的验收口径。★ 权威值在本文件：升级判定走
	// shouldEscalateToBlocking()，TeachingInterventionManager 里那份同名配置从未被读取。
	escalationBlockingThreshold: 3,
})

/** 【F5】可覆盖 `code_generation` 的"强信号"分类：都表示学生正在处理**新的具体代码** */
const STRONG_SIGNAL_CATEGORIES: ReadonlySet<TaskCategory> = new Set<TaskCategory>([
	"code_generation",
	"debugging",
	"refactoring",
	"testing",
])

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

	/** 【F9】连续「助手回合且过程中学生没有发言」的计数 —— 比例指标在 Cline 多工具循环下恒真，改用绝对量 */
	private assistantTurnsWithoutUser = 0

	/** 【方案 C-1】最近一次**学生**事件的意图分类（用于规则分流） */
	private currentTaskCategory: TaskCategory | undefined

	/** 【F3】概念问答模式的粘性状态（任务级；反复索要完整代码也不退出） */
	private conceptModeState: ConceptModeState = INITIAL_CONCEPT_MODE_STATE

	/** 同规则累计触发次数（用于阻断式干预升级判定） */
	private escalationCounter: Partial<Record<BehaviorRuleId, number>> = {}

	/** 阻断式干预是否已触发（同一任务内仅触发一次） */
	private blockingTriggered = false

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
			this.bumpedRulesThisRequest.clear()
			this.studentRequestCount++
			this.currentRequestIsDemand = isCompleteImplDemand(event.rawContent)
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

		// 【F9】AI 独占输出的绝对量：任何"学生侧"事件都归零（含 code_edit / task_start），
		//        助手回合 +1。原先只覆盖 turn_message ⇒ "边改代码边不发言"的学生计数仍会爬升。
		if (this.isStudentSideEvent(event)) {
			this.assistantTurnsWithoutUser = 0
		} else if (event.eventType === "turn_message" && event.role === "assistant") {
			this.assistantTurnsWithoutUser++
		}

		this.evaluateRules(event)
	}

	/** 【F9】该事件是否表示"学生本人有动作"（发言 / 开题 / 亲手编辑代码） */
	private isStudentSideEvent(event: StudentInteractionLog): boolean {
		if (event.eventType === "task_start") {
			return true
		}
		if (event.eventType === "turn_message") {
			return event.role !== "assistant"
		}
		// 【F2】只有"人"的编辑才算学生动手；缺省 editor（旧日志）按人工处理
		if (event.eventType === "code_edit") {
			return event.editor !== "ai"
		}
		return false
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
	 * 单位 = **学生请求**（`bumpOncePerRequest`）⇒ 第 3 次索要即达阻断阈值，与 M4'/M6' 口径一致。
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
			this.options.escalationBlockingThreshold,
		)
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
	 * 【F9】改为**绝对回合数**：连续「助手回合且学生未发言」达到阈值即命中。
	 * 比例指标（assistantTurns / totalTurns）在 Cline 形态下分母极小、恒 >0.85，实测 0.857 ⇒ 恒真，压不住。
	 * 计数与提醒冷却解耦（与另两条规则同口径）：命中即 bump，冷却只挡提醒。
	 */
	private checkHighRecentAiDependencyRule(event: StudentInteractionLog): void {
		if (event.eventType !== "turn_message") {
			return
		}
		// 【P5-A/T19-b】★ 一次提问内的多回合是 agent 循环的正常形态（实测 6~12 回合，每次工具调用
		// 一个回合），**不构成**"AI 依赖"。因此必须已有 ≥ 2 次学生请求才评估本规则，
		// 否则 M1'（只问一句「第一周学了什么」）会被误报为依赖。
		// 退化口径：从未见过学生回合时（单测/离线重放）不做此限制。
		if (this.studentRequestCount > 0 && this.studentRequestCount < 2) {
			if (this.options.debug) {
				Logger.info(
					`[BehaviorMonitor][debug] aiDependency rule skipped: studentRequestCount=${this.studentRequestCount} < 2`,
				)
			}
			return
		}
		if (this.assistantTurnsWithoutUser < this.options.minTurnsForDependency) {
			if (this.options.debug) {
				Logger.info(
					`[BehaviorMonitor][debug] aiDependency rule skipped: assistantTurnsWithoutUser=${this.assistantTurnsWithoutUser} < min=${this.options.minTurnsForDependency}`,
				)
			}
			return
		}

		this.bumpOncePerRequest("high_recent_ai_dependency")

		this.notify(
			"high_recent_ai_dependency",
			`最近连续 ${this.assistantTurnsWithoutUser} 个助手回合里你都没有参与，建议先写思路或伪代码再请求完整答案。`,
			this.assistantTurnsWithoutUser,
			this.options.minTurnsForDependency,
		)
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
			`[BehaviorMonitor][${this.taskId}][${ruleId}] ${message} (escalationCount=${escalationCount}/${this.options.escalationBlockingThreshold})`,
		)

		// 生成结构化警报，附带回退计数，供 TeachingInterventionManager 消费
		const alert: BehaviorAlert = {
			ruleId,
			message,
			triggeredAt: new Date().toISOString(),
			metricValue,
			threshold,
			escalationCount,
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
	 * 获取所有待处理的警报（只读，不清空队列）
	 */
	public getPendingAlerts(): ReadonlyArray<BehaviorAlert> {
		return this.pendingAlerts
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
	/**
	 * 获取同规则累计触发次数
	 */
	public getEscalationCount(ruleId: BehaviorRuleId): number {
		return this.escalationCounter[ruleId] ?? 0
	}

	/**
	 * 【F1】列出当前已达到阻断升级阈值的规则 ID（供 TeachingInterventionManager 使用）。
	 * 阻断判定不依赖 pendingAlerts，因此提醒队列为空时仍可升级。
	 */
	public getRuleIdsAtBlockingThreshold(): BehaviorRuleId[] {
		return (Object.keys(this.escalationCounter) as BehaviorRuleId[]).filter((ruleId) => this.shouldEscalateToBlocking(ruleId))
	}

	/**
	 * 检查是否已达到阻断式干预的升级阈值
	 * @param ruleId 要检查的规则 ID
	 * @returns 是否应触发阻断式干预
	 */
	public shouldEscalateToBlocking(ruleId: BehaviorRuleId): boolean {
		if (this.blockingTriggered) {
			return false // 同一任务内阻断仅触发一次
		}
		// 【方案 C-1】概念问答场景下不允许升级为阻断
		if (!getRulePolicy(ruleId, this.currentTaskCategory).canEscalateToBlocking) {
			return false
		}
		const count = this.getEscalationCount(ruleId)
		return count >= this.options.escalationBlockingThreshold
	}

	/**
	 * 标记阻断式干预已触发（防止重复触发）
	 */
	public markBlockingTriggered(): void {
		this.blockingTriggered = true
		Logger.info(`[BehaviorMonitor][${this.taskId}] blocking intervention marked as triggered`)
	}

	/**
	 * 获取阻断触发阈值
	 */
	public getEscalationBlockingThreshold(): number {
		return this.options.escalationBlockingThreshold
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
		this.assistantTurnsWithoutUser = 0
		this.escalationCounter = {}
		this.blockingTriggered = false
		this.currentTaskCategory = undefined
		this.conceptModeState = INITIAL_CONCEPT_MODE_STATE
	}
}
