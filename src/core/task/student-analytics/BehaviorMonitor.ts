/**
 * 实时行为监测器（轻量、非阻断）
 *
 * 目标：在插件运行期基于滚动窗口做行为模式检测，
 * 当检测到高依赖或单一行为趋势时，输出温和提醒。
 */

import { Logger } from "@/shared/services/Logger"
import type { BehaviorAlert, BehaviorRuleId, StudentInteractionLog } from "./types"

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
	/** 触发阻断式干预的同规则累计次数阈值（默认 4 次） */
	escalationBlockingThreshold?: number
}

const DEFAULT_OPTIONS: Required<BehaviorMonitorOptions> = {
	enabled: true,
	debug: false, // 开发阶段默认开启，验证完毕后改为 false
	windowSize: 20, // 覆盖 ~4 轮完整对话（每轮约 5 条事件）
	cooldownMs: 15_000, // 15 秒冷却（原 60s，降低以避免快速连续请求时错过触发窗口）
	minTurnsForDependency: 4, // 4 条 turn_message 即开始评估 AI 依赖
	aiDependencyThreshold: 0.7, // 70% AI 参与占比（Cline 多工具调用场景下可达）
	noEditTurnStreakThreshold: 5, // 连续 5 轮无编辑（约 2-3 轮对话）
	consecutiveAssistantCodeThreshold: 3, // 连续 3 次 AI 生成代码即触发（原 2，上调避免误触发）
	adoptionRateThreshold: 0.7,
	selfModificationThreshold: 0.25,
	minAdoptionSamples: 2, // 2 条采纳推断即可评估
	escalationBlockingThreshold: 4, // 同规则累计 4 次触发 → 阻断式干预
}

export class BehaviorMonitor {
	private readonly taskId: string
	private readonly options: Required<BehaviorMonitorOptions>
	private recentEvents: StudentInteractionLog[] = []
	private lastReminderAt: Partial<Record<BehaviorRuleId, number>> = {}
	/** 待消费的结构化风险警报队列 */
	private pendingAlerts: BehaviorAlert[] = []

	private assistantCodeStreak = 0
	private turnsSinceLastEdit = 0

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

		this.updateRealtimeStreaks(event)
		this.evaluateRules()
	}

	private updateRealtimeStreaks(event: StudentInteractionLog): void {
		if (event.eventType === "code_edit") {
			this.turnsSinceLastEdit = 0
			// 学生主动编辑代码 → 重置 streak（阻断判定仅关注连续无编辑的代码生成）
			this.assistantCodeStreak = 0
			if (this.options.debug) {
				Logger.info(`[BehaviorMonitor][debug] code_edit detected → turnsSinceLastEdit & assistantCodeStreak reset to 0`)
			}
			return
		}

		if (event.eventType === "turn_message") {
			this.turnsSinceLastEdit++

			if (event.role === "assistant") {
				if (event.hasCode) {
					this.assistantCodeStreak++
				}
				// hasCode=false 时不再清零 assistantCodeStreak
				// 只有在 code_edit 事件时才重置，避免 AI 发送非代码消息（如 execute_command / read_file / 提示文本）意外打断计数
			}

			if (this.options.debug) {
				Logger.info(
					`[BehaviorMonitor][debug] streaks: assistantCodeStreak=${this.assistantCodeStreak}, turnsSinceLastEdit=${this.turnsSinceLastEdit}`,
				)
			}
		}
	}

	private evaluateRules(): void {
		this.checkConsecutiveCodeGenerationRule()
		this.checkNoEditStreakRule()
		this.checkHighAdoptionLowSelfModificationRule()
		this.checkHighRecentAiDependencyRule()
	}

	private checkConsecutiveCodeGenerationRule(): void {
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

	private checkNoEditStreakRule(): void {
		if (this.turnsSinceLastEdit < this.options.noEditTurnStreakThreshold) {
			return
		}

		this.notify(
			"no_edit_streak",
			`你已经连续 ${this.turnsSinceLastEdit} 轮没有代码编辑，建议动手验证或微调一处关键实现。`,
			this.turnsSinceLastEdit,
			this.options.noEditTurnStreakThreshold,
		)
	}

	private checkHighAdoptionLowSelfModificationRule(): void {
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
			this.notify(
				"high_adoption_low_self_modification",
				`近期建议采纳率较高（${(adoptionRate * 100).toFixed(0)}%），但自主修改偏少，建议在采纳后再做一次本地优化。`,
				adoptionRate,
				this.options.adoptionRateThreshold,
			)
		}
	}

	private checkHighRecentAiDependencyRule(): void {
		const turns = this.recentEvents.filter((e) => e.eventType === "turn_message")
		if (turns.length < this.options.minTurnsForDependency) {
			if (this.options.debug) {
				Logger.info(
					`[BehaviorMonitor][debug] aiDependency rule skipped: turns=${turns.length} < min=${this.options.minTurnsForDependency}`,
				)
			}
			return
		}

		const assistantTurns = turns.filter((e) => e.role === "assistant").length
		const userTurns = turns.filter((e) => e.role === "user").length
		const totalTurns = assistantTurns + userTurns
		if (totalTurns === 0) {
			return
		}

		const aiDependency = assistantTurns / totalTurns

		if (this.options.debug) {
			Logger.info(
				`[BehaviorMonitor][debug] aiDependency rule: assistant=${assistantTurns}, user=${userTurns}, ratio=${(aiDependency * 100).toFixed(0)}%(threshold=${(this.options.aiDependencyThreshold * 100).toFixed(0)}%)`,
			)
		}

		if (aiDependency > this.options.aiDependencyThreshold) {
			this.notify(
				"high_recent_ai_dependency",
				`最近 ${turns.length} 条交互中 AI 参与占比较高（${(aiDependency * 100).toFixed(0)}%），建议先写思路或伪代码再请求完整答案。`,
				aiDependency,
				this.options.aiDependencyThreshold,
			)
		}
	}

	private notify(ruleId: BehaviorRuleId, message: string, metricValue: number = 0, threshold: number = 0): void {
		const now = Date.now()
		const lastTs = this.lastReminderAt[ruleId] ?? 0
		if (now - lastTs < this.options.cooldownMs) {
			return
		}

		this.lastReminderAt[ruleId] = now

		// 递增同规则累计触发次数（用于阻断式干预升级判定）
		const escalationCount = (this.escalationCounter[ruleId] ?? 0) + 1
		this.escalationCounter[ruleId] = escalationCount

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

	/**
	 * 获取同规则累计触发次数
	 */
	public getEscalationCount(ruleId: BehaviorRuleId): number {
		return this.escalationCounter[ruleId] ?? 0
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
		this.escalationCounter = {}
		this.blockingTriggered = false
	}
}
