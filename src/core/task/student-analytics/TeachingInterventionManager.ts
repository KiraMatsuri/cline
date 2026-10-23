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
import { formatInterventionForInjection, generateInterventionMessage } from "./InterventionMessageGenerator"
import type {
	BehaviorAlert,
	BehaviorRuleId,
	InterventionManagerOptions,
	InterventionMessage,
	InterventionRecord,
	InterventionSeverity,
	InterventionStyle,
} from "./types"

/** 【P2-2】管理器实际读取的配置项（旧阻断相关字段已退役，不再列入） */
type EffectiveManagerOptions = Required<
	Pick<
		InterventionManagerOptions,
		"enabled" | "globalCooldownMs" | "maxInterventionsPerTask" | "minTurnsBetweenInterventions" | "preferredStyle" | "logToOutputChannel"
	>
>

export const DEFAULT_OPTIONS: EffectiveManagerOptions = Object.freeze({
	enabled: true,
	globalCooldownMs: 5_000, // 5 秒全局冷却（用于提示式干预）
	maxInterventionsPerTask: 10, // 单任务最多 10 次干预
	minTurnsBetweenInterventions: 0, // 不限制轮次间隔
	preferredStyle: "hint" as InterventionStyle, // 默认使用提示风格
	logToOutputChannel: true,
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
	private readonly options: EffectiveManagerOptions

	/** 干预历史记录 */
	private interventionHistory: InterventionRecord[] = []

	/** 上次干预时间戳 */
	private lastInterventionAt = 0

	/** 上次干预时的对话轮次索引 */
	private lastInterventionTurnIndex = -Infinity

	/** 每条规则的冷却到期时间 */
	private ruleCooldownUntil: Partial<Record<BehaviorRuleId, number>> = {}

	constructor(taskId: string, options?: InterventionManagerOptions) {
		this.taskId = taskId
		this.options = { ...DEFAULT_OPTIONS, ...options }
	}

	/**
	 * 核心方法：检查是否需要干预，如果需要则返回格式化后的干预文本。
	 *
	 * 【P2-2】阻断式干预已整体移除：本方法只产出普通提示式干预
	 * （hint/question/challenge/reflection），永不阻断回合、永不调用 `ask()`、永不 `return true`。
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

		// 检查是否有待处理的警报
		if (!monitor.hasPendingAlerts()) {
			return null
		}

		// 全局冷却检查
		if (!this.isGlobalCooldownExpired()) {
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

		// 【P7/T4（裁定 3）】取队**而不清空**：旧写法 `consumePendingAlerts()` 会把所有警报一次取走，
		// 而下面只展示优先级最高的一条 ⇒ 其余规则的警报永久丢失（2026-10-18 实测：
		// 加权依赖度 4.0 已达阈并入队，却被同轮的 `no_edit_streak` 挤掉且再也不会重现）。
		// 现在只丢掉**真正展示给学生的那一条**，其余顺延到下一次。
		const stale = monitor.dropStaleAlerts()
		for (const alert of stale) {
			Logger.info(
				`[TeachingIntervention][${this.taskId}] drop stale alert: rule=${alert.ruleId}, triggeredAt=${alert.triggeredAt}`,
			)
		}
		const alerts = monitor.getPendingAlerts()
		if (alerts.length === 0) {
			return null
		}

		// ===== 普通提示式干预 =====
		const eligibleAlerts = alerts.filter((alert) => this.isRuleCooldownExpired(alert.ruleId))
		if (eligibleAlerts.length === 0) {
			Logger.info(`[TeachingIntervention][${this.taskId}] skipped: all alerts in rule-level cooldown`)
			return null
		}

		const priorityAlert = this.selectHighestPriorityAlert(eligibleAlerts)
		// 【P7/T4】只丢弃本次真正展示的那一条（其余顺延到下一次）
		monitor.dropAlert(priorityAlert)
		const intervention = generateInterventionMessage(
			priorityAlert,
			this.options.preferredStyle,
			this.options.globalCooldownMs,
		)
		const injectionText = formatInterventionForInjection(intervention, recentCopies)

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
	}
}
