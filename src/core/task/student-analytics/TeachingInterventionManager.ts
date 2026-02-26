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
	InterventionStyle,
} from "./types"

const DEFAULT_OPTIONS: Required<InterventionManagerOptions> = {
	enabled: true,
	globalCooldownMs: 5_000, // 3 分钟全局冷却
	maxInterventionsPerTask: 8, // 单任务最多 8 次干预
	minTurnsBetweenInterventions: 0, // 至少间隔 3 轮对话
	preferredStyle: "hint" as InterventionStyle, // 默认使用提示风格
	logToOutputChannel: true,
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

	constructor(taskId: string, options?: InterventionManagerOptions) {
		this.taskId = taskId
		this.options = { ...DEFAULT_OPTIONS, ...options }
	}

	/**
	 * 核心方法：检查是否需要干预，如果需要则返回格式化后的干预文本
	 *
	 * 在 Task.recursivelyMakeClineRequests() 中，
	 * 将 userContent 添加到 API 对话历史之前调用此方法。
	 *
	 * @param monitor   当前任务的 BehaviorMonitor 实例
	 * @param turnIndex 当前对话轮次索引
	 * @returns 需要注入的干预文本（null 表示不干预）
	 */
	public checkAndGenerateIntervention(monitor: BehaviorMonitor | undefined, turnIndex: number): string | null {
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

		// 消费警报
		const alerts = monitor.consumePendingAlerts()
		if (alerts.length === 0) {
			return null
		}

		// 过滤掉仍在规则级冷却中的警报
		const eligibleAlerts = alerts.filter((alert) => this.isRuleCooldownExpired(alert.ruleId))
		if (eligibleAlerts.length === 0) {
			Logger.info(`[TeachingIntervention][${this.taskId}] skipped: all alerts in rule-level cooldown`)
			return null
		}

		// 选择优先级最高的警报（取 metricValue/threshold 比值最大的）
		const priorityAlert = this.selectHighestPriorityAlert(eligibleAlerts)

		// 生成干预消息
		const intervention = generateInterventionMessage(
			priorityAlert,
			this.options.preferredStyle,
			this.options.globalCooldownMs,
		)

		// 更新状态
		this.recordIntervention(intervention, turnIndex)

		// 格式化为注入文本
		const injectionText = formatInterventionForInjection(intervention)

		if (this.options.logToOutputChannel) {
			Logger.info(
				`[TeachingIntervention][${this.taskId}] INJECTING intervention: rule=${intervention.ruleId}, severity=${intervention.severity}, style=${intervention.style}`,
			)
		}

		return injectionText
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
