/**
 * 教学干预管理器
 *
 * 协调 BehaviorMonitor（风险检测）与 InterventionMessageGenerator（消息生成），
 * 管理冷却时间、限额控制、干预历史等。
 *
 * 设计原则：
 * 1. 不阻断 AI 原有生成流程
 * 2. 不修改用户原始输入
 * 3. 不替换 AI 正常回答
 * 4. 只在对话流中插入引导式提示
 * 5. 与现有模块解耦，可独立启停
 */

import { Logger } from "@/shared/services/Logger"
import type { BehaviorMonitor } from "./BehaviorMonitor"
import {
	formatInterventionForInjection,
	generateBlockingInterventionMessage,
	generateInterventionMessage,
} from "./InterventionMessageGenerator"
import type {
	BehaviorAlert,
	BehaviorRuleId,
	InterventionManagerOptions,
	InterventionMessage,
	InterventionRecord,
	InterventionSeverity,
	InterventionStyle,
} from "./types"

export const DEFAULT_OPTIONS: Readonly<Required<InterventionManagerOptions>> = Object.freeze({
	enabled: true,
	globalCooldownMs: 5_000, // 5 秒全局冷却（用于提示式干预）
	maxInterventionsPerTask: 10, // 单任务最多 10 次干预（含阻断）
	minTurnsBetweenInterventions: 0, // 不限制轮次间隔
	preferredStyle: "hint" as InterventionStyle, // 默认使用提示风格
	logToOutputChannel: true,
	// ⚠️ 本项在管理器内**从未被读取**（升级判定走 monitor.shouldEscalateToBlocking）。
	// 保留是为了与 BehaviorMonitor 的值保持一致；改升级阈值请改 BehaviorMonitor。
	// 【F1】6 → 3：与 BehaviorMonitor.DEFAULT_OPTIONS 同步（见 __tests__/interventionParams.test.ts）。
	escalationBlockingThreshold: 3,
	// 【方案 D 止血】180_000 → 60_000。阻隔 3 分钟对"概念问答误触发"场景过重。
	blockingCooldownMs: 60_000,
})

/**
 * 【F13】一次干预决策的全部可审计信息（决策层归代码，叙述层归模型）。
 *
 * 为什么不能只返回注入文本（string）：F6 之后干预文本不再进 `apiConversationHistory`，
 * 如果没有这份结构化交付物，index.ts 就无从知道「本轮到底干预了没、用哪条规则、什么力度」，
 * M9' 的 `D`（决策数）将彻底不可数（F13 硬要求 1）。
 */
export interface InterventionDecision {
	/** 注入 system prompt 的任务书文本（旧 `checkAndGenerateIntervention` 的返回值） */
	injectionText: string
	/** 模板文案（**降级兜底**用；同时是任务书里的「力度锚点」样例） */
	templateText: string
	ruleId: BehaviorRuleId
	severity: InterventionSeverity
	style: InterventionStyle
	interventionType: InterventionMessage["interventionType"]
}

export class TeachingInterventionManager {
	private readonly taskId: string
	private readonly options: Required<InterventionManagerOptions>

	/** 干预历史记录 */
	private interventionHistory: InterventionRecord[] = []

	/** 上次干预时间戳 */
	private lastInterventionAt = 0

	/** 上次干预时的对话轮次索引 */
	private lastInterventionTurnIndex = -Infinity

	/** 每条规则的冷却到期时间 */
	private ruleCooldownUntil: Partial<Record<BehaviorRuleId, number>> = {}

	/** 阻断式干预是否处于激活状态（冷却期内） */
	private blockingActive = false

	/** 阻断式干预的结束时间戳 */
	private blockingEndsAt = 0

	/** 最近一次阻断式干预消息（用于冷却期间展示提示） */
	private lastBlockingIntervention: InterventionMessage | null = null

	// ===================== 跨会话全局阻断状态 =====================
	// 【v2.7】阻断状态提升为全局静态，防止学生"退出对话 → 新建对话"绕过 180s 锁定。
	// 所有 Task/对话共享同一份阻断状态；阻断到期后自动清除。
	/** 全局阻断冷却结束时间戳（0 = 无全局阻断） */
	private static globalBlockingEndsAt = 0
	/** 全局最近一次阻断干预消息（新建对话展示提醒用） */
	private static globalLastBlockingIntervention: InterventionMessage | null = null

	constructor(taskId: string, options?: InterventionManagerOptions) {
		this.taskId = taskId
		this.options = { ...DEFAULT_OPTIONS, ...options }
	}

	/**
	 * 核心方法：检查是否需要干预，如果需要则返回格式化后的干预文本
	 *
	 * 支持两级干预策略：
	 *   1. 普通提示式干预（hint/question/challenge/reflection）
	 *   2. 阻断式干预（blocking）— 同规则累计触发 ≥ escalationBlockingThreshold 次后升级
	 *
	 * 阻断式干预特性:
	 *   - 禁用代码生成与工具执行功能
	 *   - 展示反思引导问题
	 *   - 180 秒冷却倒计时（期间不触发新干预）
	 *
	 * @param monitor   当前任务的 BehaviorMonitor 实例
	 * @param turnIndex 当前对话轮次索引
	 * @returns 需要注入的干预文本（null 表示不干预）
	 */
	public checkAndGenerateIntervention(monitor: BehaviorMonitor | undefined, turnIndex: number): string | null {
		return this.checkAndGenerateInterventionDecision(monitor, turnIndex)?.injectionText ?? null
	}

	/**
	 * 【F13】结构化版本的干预决策（`checkAndGenerateIntervention` 的实现体）。
	 *
	 * 兼容入口 `checkAndGenerateIntervention(): string | null` 的签名与行为**逐字不变**
	 * （6 个测试文件依赖它），只是本方法的一层委托 —— 这样既有测试无需任何改动。
	 *
	 * @param monitor      当前任务的 BehaviorMonitor 实例
	 * @param turnIndex    当前对话轮次索引
	 * @param recentCopies 最近已展示过的文案（回传给任务书要求「换一种说法」，M13'）；缺省为空
	 * @returns 决策对象（null 表示本轮不干预）
	 */
	public checkAndGenerateInterventionDecision(
		monitor: BehaviorMonitor | undefined,
		turnIndex: number,
		recentCopies: readonly string[] = [],
	): InterventionDecision | null {
		if (!this.options.enabled || !monitor) {
			return null
		}

		// 检查阻断冷却是否仍在进行中（实例状态 + 全局跨会话状态）
		// 【v2.7】新建对话后新 Task 无实例阻断状态，但全局阻断仍有效 → 继续拦截
		const endsAt = this.getBlockingEndsAt()
		if (endsAt > 0 && !this.isBlockingCooldownExpired()) {
			// 同步实例状态（新任务用全局恢复）
			this.blockingActive = true
			this.blockingEndsAt = endsAt
			const remaining = this.getBlockingRemainingSeconds()
			Logger.info(
				`[TeachingIntervention][${this.taskId}] blocking cooldown active (${remaining}s remaining), returning reminder`,
			)
			// 返回阻断提醒消息（含剩余时间），让 index.ts 能继续执行阻断逻辑
			// 【F13】阻断冷却期的提醒同样是一次「代码判定要干预」：本轮学生会**实际看到**模板文案，
			// 因此必须与展示侧的 `T`（模板兜底记账）成对出现，否则 M9' ② 会误报「该干预却没干预」。
			return this.buildBlockingReminderDecision()
		}

		// 阻断冷却到期，重置阻断状态（实例 + 全局）
		if (endsAt > 0 && this.isBlockingCooldownExpired()) {
			Logger.info(`[TeachingIntervention][${this.taskId}] blocking cooldown expired, releasing block`)
			this.blockingActive = false
			this.blockingEndsAt = 0
			TeachingInterventionManager.globalBlockingEndsAt = 0
			TeachingInterventionManager.globalLastBlockingIntervention = null
		}

		// ===== 阻断升级（独立入口）=====
		// 【F1】阻断判定不依赖 pendingAlerts：只要某条规则的累计违规数达到阈值，
		// 即使提醒因冷却未入队 / 已被消费，也在此升级为阻断。
		const blockingRule = monitor.getRuleIdsAtBlockingThreshold()[0]
		if (blockingRule) {
			const count = monitor.getEscalationCount(blockingRule)
			return this.triggerBlocking(
				monitor,
				{
					ruleId: blockingRule,
					message: "",
					triggeredAt: new Date().toISOString(),
					metricValue: count,
					threshold: monitor.getEscalationBlockingThreshold(),
					escalationCount: count,
				},
				turnIndex,
			)
		}

		// 检查是否有待处理的警报
		if (!monitor.hasPendingAlerts()) {
			return null
		}

		// 全局冷却检查（仅对普通干预生效，阻断模式跳过此检查）
		if (!this.blockingActive && !this.isGlobalCooldownExpired()) {
			Logger.info(
				`[TeachingIntervention][${this.taskId}] skipped: global cooldown active (${this.getRemainingCooldownMs()}ms remaining)`,
			)
			return null
		}

		// 轮次间隔检查
		if (!this.hasEnoughTurnGap(turnIndex)) {
			Logger.info(
				`[TeachingIntervention][${this.taskId}] skipped: turn gap too small (current=${turnIndex}, last=${this.lastInterventionTurnIndex}, min=${this.options.minTurnsBetweenInterventions})`,
			)
			return null
		}

		// 任务内限额检查
		if (this.isMaxInterventionsReached()) {
			Logger.info(
				`[TeachingIntervention][${this.taskId}] skipped: max interventions reached (${this.interventionHistory.length}/${this.options.maxInterventionsPerTask})`,
			)
			return null
		}

		// 消费警报
		const alerts = monitor.consumePendingAlerts()
		if (alerts.length === 0) {
			return null
		}

		let intervention: InterventionMessage
		let injectionText: string

		// 【F1】防御性回退：上面的 getRuleIdsAtBlockingThreshold() 入口已覆盖此情形。
		// 保留 alerts 侧判定并复用同一个 triggerBlocking()，避免两处阻断分支漂移（DRY）。
		const blockingAlert = alerts.find((alert) => monitor.shouldEscalateToBlocking(alert.ruleId))
		if (blockingAlert) {
			return this.triggerBlocking(monitor, blockingAlert, turnIndex)
		}

		// ===== 普通提示式干预 =====
		const eligibleAlerts = alerts.filter((alert) => this.isRuleCooldownExpired(alert.ruleId))
		if (eligibleAlerts.length === 0) {
			Logger.info(`[TeachingIntervention][${this.taskId}] skipped: all alerts in rule-level cooldown`)
			return null
		}

		const priorityAlert = this.selectHighestPriorityAlert(eligibleAlerts)
		intervention = generateInterventionMessage(priorityAlert, this.options.preferredStyle, this.options.globalCooldownMs)
		injectionText = formatInterventionForInjection(intervention, recentCopies)

		if (this.options.logToOutputChannel) {
			Logger.info(
				`[TeachingIntervention][${this.taskId}] INJECTING intervention: rule=${intervention.ruleId}, severity=${intervention.severity}, style=${intervention.style}, escalationCount=${priorityAlert.escalationCount}`,
			)
		}

		// 记录干预
		this.recordIntervention(intervention, turnIndex)

		// 【F13】把决策的全部可审计信息一并交付（index.ts 据此落 intervention_decision 事件）
		return {
			injectionText,
			templateText: intervention.content,
			ruleId: intervention.ruleId,
			severity: intervention.severity,
			style: intervention.style,
			interventionType: intervention.interventionType,
		}
	}

	/**
	 * 【F1】触发阻断式干预。
	 *
	 * 从 checkAndGenerateIntervention() 抽出（原为内联分支），供两个入口复用：
	 *   ① 阈值式入口（getRuleIdsAtBlockingThreshold）—— 不依赖提醒队列；
	 *   ② alerts 侧回退入口 —— 保持原有行为。
	 */
	private triggerBlocking(monitor: BehaviorMonitor, alert: BehaviorAlert, turnIndex: number): InterventionDecision {
		const intervention = generateBlockingInterventionMessage(alert, this.options.blockingCooldownMs)

		// 标记阻断已触发
		monitor.markBlockingTriggered()
		this.blockingActive = true
		this.blockingEndsAt = Date.now() + this.options.blockingCooldownMs

		// 【v2.7】同步全局阻断状态（退出/新建对话后仍生效）
		TeachingInterventionManager.globalBlockingEndsAt = this.blockingEndsAt
		TeachingInterventionManager.globalLastBlockingIntervention = intervention

		// 保存阻断干预消息（用于冷却期间展示提醒）
		this.lastBlockingIntervention = intervention

		// 格式化为注入文本
		const injectionText = formatInterventionForInjection(intervention)

		Logger.info(
			`[TeachingIntervention][${this.taskId}] BLOCKING INTERVENTION triggered: rule=${intervention.ruleId}, ` +
				`escalationCount=${alert.escalationCount}, disabledFeatures=${intervention.disabledFeatures?.join(",")}, ` +
				`cooldown=${intervention.countdownSeconds}s`,
		)

		// 记录干预
		this.recordIntervention(intervention, turnIndex)

		// 【F13】阻断决策同样结构化交付（含兜底文案与规则/力度/风格）
		return {
			injectionText,
			templateText: intervention.content,
			ruleId: intervention.ruleId,
			severity: intervention.severity,
			style: intervention.style,
			interventionType: intervention.interventionType,
		}
	}

	/**
	 * 阻断冷却是否已过期（基于实例 + 全局取较晚者）
	 */
	private isBlockingCooldownExpired(): boolean {
		return Date.now() >= this.getBlockingEndsAt()
	}

	/**
	 * 【F13】阻断冷却期的提醒也是一次「判定要干预」：把提醒文案与元数据一起交付，
	 * 供 index.ts 同时落 `intervention_decision`（D）与 `intervention_copy`（T）两条记账。
	 * 元数据取最近一次阻断干预（实例优先，退到全局，跨会话仍可对账）。
	 */
	private buildBlockingReminderDecision(): InterventionDecision {
		const reminder = this.getBlockingReminderMessage()
		const last = this.lastBlockingIntervention ?? TeachingInterventionManager.globalLastBlockingIntervention
		return {
			injectionText: reminder,
			templateText: last?.content ?? reminder,
			ruleId: last?.ruleId ?? "consecutive_code_generation",
			severity: "strong",
			style: "blocking",
			interventionType: "blocking",
		}
	}

	/**
	 * 获取阻断剩余秒数
	 */
	private getBlockingRemainingSeconds(): number {
		return Math.max(0, Math.ceil((this.getBlockingEndsAt() - Date.now()) / 1000))
	}

	/**
	 * 检查当前是否处于阻断激活状态
	 * 【v2.7】实例状态或全局跨会话状态任一激活即视为激活
	 */
	public isBlockingActive(): boolean {
		if (this.blockingActive && !this.isBlockingCooldownExpired()) {
			return true
		}
		return TeachingInterventionManager.globalBlockingEndsAt > Date.now()
	}

	/**
	 * 获取阻断冷却结束时间戳（实例与全局取较晚者，全局跨会话延续）
	 */
	public getBlockingEndsAt(): number {
		return Math.max(this.blockingEndsAt, TeachingInterventionManager.globalBlockingEndsAt)
	}

	/**
	 * 跨会话获取全局阻断状态（供 Controller 倒计时组件读取，无需 Task 实例）。
	 * 即使当前无任务（用户退出对话），只要全局阻断未过期即返回状态。
	 */
	public static getGlobalBlockingState(): { active: boolean; endsAt: number } | null {
		if (TeachingInterventionManager.globalBlockingEndsAt > Date.now()) {
			return { active: true, endsAt: TeachingInterventionManager.globalBlockingEndsAt }
		}
		return null
	}

	/**
	 * 生成阻断冷却期间的提醒消息（含剩余时间）
	 */
	private getBlockingReminderMessage(): string {
		const remaining = this.getBlockingRemainingSeconds()
		const minutes = Math.floor(remaining / 60)
		const seconds = remaining % 60
		const timeDisplay = seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`

		// 【v2.7】实例无阻断消息时回退到全局（新建对话场景）
		const lastIntervention = this.lastBlockingIntervention ?? TeachingInterventionManager.globalLastBlockingIntervention
		if (lastIntervention) {
			return [
				`<teaching_intervention rule="${lastIntervention.ruleId}" severity="strong" style="blocking" interventionType="blocking">`,
				`⏳ 【阻断冷却中 — 剩余 ${timeDisplay}】`,
				"",
				"系统仍处于阻断模式。代码生成与工具执行功能暂不可用。",
				"",
				"请继续完成之前的反思练习，或在编辑器中自主编写代码。",
				`倒计时结束后系统将自动恢复功能。`,
				"",
				"如果你已经完成了反思练习，请在此输入你的答案，系统将在冷却结束后读取。",
				"</teaching_intervention>",
			].join("\n")
		}

		// 如果没有存储的阻断消息（极端情况），生成一个简单的
		return [
			`<teaching_intervention rule="consecutive_code_generation" severity="strong" style="blocking" interventionType="blocking">`,
			`⏳ 【阻断冷却中 — 剩余 ${timeDisplay}】`,
			"",
			"系统处于阻断模式，代码生成与工具执行功能暂不可用。",
			"请利用这段时间在编辑器中独立编写代码。",
			"</teaching_intervention>",
		].join("\n")
	}

	/**
	 * 全局冷却是否已过期
	 */
	private isGlobalCooldownExpired(): boolean {
		return Date.now() - this.lastInterventionAt >= this.options.globalCooldownMs
	}

	/**
	 * 获取剩余冷却时间（毫秒）
	 */
	private getRemainingCooldownMs(): number {
		return Math.max(0, this.options.globalCooldownMs - (Date.now() - this.lastInterventionAt))
	}

	/**
	 * 当前轮次与上次干预之间是否有足够间隔
	 */
	private hasEnoughTurnGap(currentTurnIndex: number): boolean {
		return currentTurnIndex - this.lastInterventionTurnIndex >= this.options.minTurnsBetweenInterventions
	}

	/**
	 * 是否已达到单任务干预次数上限
	 */
	private isMaxInterventionsReached(): boolean {
		return this.interventionHistory.length >= this.options.maxInterventionsPerTask
	}

	/**
	 * 规则级冷却是否已过期
	 */
	private isRuleCooldownExpired(ruleId: BehaviorRuleId): boolean {
		const until = this.ruleCooldownUntil[ruleId] ?? 0
		return Date.now() >= until
	}

	/**
	 * 从多个警报中选出优先级最高的
	 * 策略：metricValue / threshold 比值越大，优先级越高
	 */
	private selectHighestPriorityAlert(alerts: BehaviorAlert[]): BehaviorAlert {
		return alerts.reduce((best, current) => {
			const bestRatio = best.threshold > 0 ? best.metricValue / best.threshold : best.metricValue
			const currentRatio = current.threshold > 0 ? current.metricValue / current.threshold : current.metricValue
			return currentRatio > bestRatio ? current : best
		})
	}

	/**
	 * 记录干预到历史，更新冷却状态
	 */
	private recordIntervention(intervention: InterventionMessage, turnIndex: number): void {
		const record: InterventionRecord = {
			intervention,
			taskId: this.taskId,
			injected: true,
			turnIndex,
		}

		this.interventionHistory.push(record)
		this.lastInterventionAt = Date.now()
		this.lastInterventionTurnIndex = turnIndex

		// 设置规则级冷却
		this.ruleCooldownUntil[intervention.ruleId] = new Date(intervention.cooldownUntil).getTime()
	}

	// ===================== 公共查询 API =====================

	/**
	 * 获取当前任务的干预历史
	 */
	public getInterventionHistory(): ReadonlyArray<InterventionRecord> {
		return this.interventionHistory
	}

	/**
	 * 获取当前任务已触发的干预次数
	 */
	public getInterventionCount(): number {
		return this.interventionHistory.length
	}

	/**
	 * 动态启用/禁用干预
	 */
	public setEnabled(enabled: boolean): void {
		this.options.enabled = enabled
		Logger.info(`[TeachingIntervention][${this.taskId}] enabled=${enabled}`)
	}

	/**
	 * 设置偏好的干预风格
	 */
	public setPreferredStyle(style: InterventionStyle): void {
		this.options.preferredStyle = style
	}

	/**
	 * 重置所有状态（通常在任务重启时调用）
	 */
	public reset(): void {
		this.interventionHistory = []
		this.lastInterventionAt = 0
		this.lastInterventionTurnIndex = -Infinity
		this.ruleCooldownUntil = {}
		this.blockingActive = false
		this.blockingEndsAt = 0
		this.lastBlockingIntervention = null
	}
}
