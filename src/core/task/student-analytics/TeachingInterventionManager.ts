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
	InterventionStyle,
} from "./types"

const DEFAULT_OPTIONS: Required<InterventionManagerOptions> = {
	enabled: true,
	globalCooldownMs: 5_000, // 5 秒全局冷却（用于提示式干预）
	maxInterventionsPerTask: 10, // 单任务最多 10 次干预（含阻断）
	minTurnsBetweenInterventions: 0, // 不限制轮次间隔
	preferredStyle: "hint" as InterventionStyle, // 默认使用提示风格
	logToOutputChannel: true,
	escalationBlockingThreshold: 4, // 同规则累计 4 次 → 阻断
	blockingCooldownMs: 180_000, // 阻断冷却 3 分钟
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
		if (!this.options.enabled || !monitor) {
			return null
		}

		// 检查阻断冷却是否仍在进行中
		if (this.blockingActive && !this.isBlockingCooldownExpired()) {
			const remaining = this.getBlockingRemainingSeconds()
			Logger.info(
				`[TeachingIntervention][${this.taskId}] blocking cooldown active (${remaining}s remaining), returning reminder`,
			)
			// 返回阻断提醒消息（含剩余时间），让 index.ts 能继续执行阻断逻辑
			return this.getBlockingReminderMessage()
		}

		// 阻断冷却到期，重置阻断状态
		if (this.blockingActive && this.isBlockingCooldownExpired()) {
			Logger.info(`[TeachingIntervention][${this.taskId}] blocking cooldown expired, releasing block`)
			this.blockingActive = false
			this.blockingEndsAt = 0
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

		// 检查是否有警报达到了阻断升级阈值
		const blockingAlert = alerts.find((alert) =>
			monitor.shouldEscalateToBlocking(alert.ruleId),
		)

		let intervention: InterventionMessage
		let injectionText: string

		if (blockingAlert) {
			// ===== 阻断式干预 =====
			intervention = generateBlockingInterventionMessage(
				blockingAlert,
				this.options.blockingCooldownMs,
			)

			// 标记阻断已触发
			monitor.markBlockingTriggered()
			this.blockingActive = true
			this.blockingEndsAt = Date.now() + this.options.blockingCooldownMs

			// 保存阻断干预消息（用于冷却期间展示提醒）
			this.lastBlockingIntervention = intervention

			// 格式化为注入文本
			injectionText = formatInterventionForInjection(intervention)

			Logger.info(
				`[TeachingIntervention][${this.taskId}] BLOCKING INTERVENTION triggered: rule=${intervention.ruleId}, ` +
				`escalationCount=${blockingAlert.escalationCount}, disabledFeatures=${intervention.disabledFeatures?.join(",")}, ` +
				`cooldown=${intervention.countdownSeconds}s`,
			)
		} else {
			// ===== 普通提示式干预 =====
			const eligibleAlerts = alerts.filter((alert) => this.isRuleCooldownExpired(alert.ruleId))
			if (eligibleAlerts.length === 0) {
				Logger.info(`[TeachingIntervention][${this.taskId}] skipped: all alerts in rule-level cooldown`)
				return null
			}

			const priorityAlert = this.selectHighestPriorityAlert(eligibleAlerts)
			intervention = generateInterventionMessage(
				priorityAlert,
				this.options.preferredStyle,
				this.options.globalCooldownMs,
			)
			injectionText = formatInterventionForInjection(intervention)

			if (this.options.logToOutputChannel) {
				Logger.info(
					`[TeachingIntervention][${this.taskId}] INJECTING intervention: rule=${intervention.ruleId}, severity=${intervention.severity}, style=${intervention.style}, escalationCount=${priorityAlert.escalationCount}`,
				)
			}
		}

		// 记录干预
		this.recordIntervention(intervention, turnIndex)

		return injectionText
	}

	/**
	 * 阻断冷却是否已过期
	 */
	private isBlockingCooldownExpired(): boolean {
		return Date.now() >= this.blockingEndsAt
	}

	/**
	 * 获取阻断剩余秒数
	 */
	private getBlockingRemainingSeconds(): number {
		return Math.max(0, Math.ceil((this.blockingEndsAt - Date.now()) / 1000))
	}

	/**
	 * 检查当前是否处于阻断激活状态
	 */
	public isBlockingActive(): boolean {
		return this.blockingActive && !this.isBlockingCooldownExpired()
	}

	/**
	 * 获取阻断冷却结束时间戳
	 */
	public getBlockingEndsAt(): number {
		return this.blockingEndsAt
	}

	/**
	 * 生成阻断冷却期间的提醒消息（含剩余时间）
	 */
	private getBlockingReminderMessage(): string {
		const remaining = this.getBlockingRemainingSeconds()
		const minutes = Math.floor(remaining / 60)
		const seconds = remaining % 60
		const timeDisplay = seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`

		if (this.lastBlockingIntervention) {
			return [
				`<teaching_intervention rule="${this.lastBlockingIntervention.ruleId}" severity="strong" style="blocking" interventionType="blocking">`,
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
