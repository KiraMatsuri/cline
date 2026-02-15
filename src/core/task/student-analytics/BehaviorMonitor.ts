/**
 * 实时行为监测器（轻量、非阻断）
 *
 * 目标：在插件运行期基于滚动窗口做行为模式检测，
 * 当检测到高依赖或单一行为趋势时，输出温和提醒。
 */

import { Logger } from "@/shared/services/Logger"
import type { StudentInteractionLog } from "./types"

type BehaviorRuleId =
	| "consecutive_code_generation"
	| "no_edit_streak"
	| "high_adoption_low_self_modification"
	| "high_recent_ai_dependency"

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
}

const DEFAULT_OPTIONS: Required<BehaviorMonitorOptions> = {
	enabled: true,
	debug: false, // 开发阶段默认开启，验证完毕后改为 false
	windowSize: 20, // 覆盖 ~4 轮完整对话（每轮约 5 条事件）
	cooldownMs: 60_000, // 60 秒冷却，兼顾调试效率和提醒频率
	minTurnsForDependency: 4, // 4 条 turn_message 即开始评估 AI 依赖
	aiDependencyThreshold: 0.7, // 70% AI 参与占比（Cline 多工具调用场景下可达）
	noEditTurnStreakThreshold: 5, // 连续 5 轮无编辑（约 2-3 轮对话）
	consecutiveAssistantCodeThreshold: 3, // 连续 3 次 AI 生成代码
	adoptionRateThreshold: 0.7,
	selfModificationThreshold: 0.25,
	minAdoptionSamples: 2, // 2 条采纳推断即可评估
}

export class BehaviorMonitor {
	private readonly taskId: string
	private readonly options: Required<BehaviorMonitorOptions>
	private recentEvents: StudentInteractionLog[] = []
	private lastReminderAt: Partial<Record<BehaviorRuleId, number>> = {}

	private assistantCodeStreak = 0
	private turnsSinceLastEdit = 0

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
			if (this.options.debug) {
				Logger.info(`[BehaviorMonitor][debug] code_edit detected → turnsSinceLastEdit reset to 0`)
			}
			return
		}

		if (event.eventType === "turn_message") {
			this.turnsSinceLastEdit++

			if (event.role === "assistant") {
				if (event.hasCode) {
					this.assistantCodeStreak++
				} else {
					this.assistantCodeStreak = 0
				}
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
		)
	}

	private checkNoEditStreakRule(): void {
		if (this.turnsSinceLastEdit < this.options.noEditTurnStreakThreshold) {
			return
		}

		this.notify("no_edit_streak", `你已经连续 ${this.turnsSinceLastEdit} 轮没有代码编辑，建议动手验证或微调一处关键实现。`)
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
			)
		}
	}

	private notify(ruleId: BehaviorRuleId, message: string): void {
		const now = Date.now()
		const lastTs = this.lastReminderAt[ruleId] ?? 0
		if (now - lastTs < this.options.cooldownMs) {
			return
		}

		this.lastReminderAt[ruleId] = now
		Logger.info(`[BehaviorMonitor][${this.taskId}][${ruleId}] ${message}`)
	}
}
