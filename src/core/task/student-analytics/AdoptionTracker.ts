/**
 * AI 建议采纳推断器
 * Adoption Tracker - Infers whether students adopted AI suggestions
 *
 * 推断规则（弱判断版本 v1，F11-② 后）：
 * 0. 与上一条建议**不同主题** → unknown（换题后行为无法归因，不再记 adopted）
 * 1. AI 回复后 60s 内有代码编辑/文件保存 → adopted
 * 2. AI 以 attempt_completion 收尾且学生仍在同一主题 → adopted
 * 3. AI 回复后用户继续追问同一主题 → continued
 * 4. 超时或无后续行为 → unknown
 *
 * ⚠️ `AdoptionStatus` 的 `rejected` 成员当前不可达（见 types.ts 的 JSDoc），保留只为兼容历史日志。
 */

import type { AdoptionStatus, SuggestionType } from "./types"

/**
 * 缓存的 assistant turn 状态
 */
interface PendingAssistantTurn {
	/** 日志时间戳 */
	ts: string
	/** 任务 ID */
	taskId: string
	/** 轮次索引 */
	turnIndex: number
	/** AI 建议类型 */
	suggestionType: SuggestionType
	/** 是否包含代码 */
	hasCode: boolean
	/** 是否已有代码编辑行为 */
	hasCodeEdit: boolean
	/** 是否已有文件保存行为 */
	hasFileSave: boolean
	/** 创建时间（用于超时判断） */
	createdAt: number
}

/** 采纳判断的超时时间（毫秒）：60 秒 */
const ADOPTION_TIMEOUT_MS = 60_000

export class AdoptionTracker {
	/** 每个任务最近一条待判断的 assistant turn */
	private pendingTurns: Map<string, PendingAssistantTurn> = new Map()

	/**
	 * 注册一个新的 assistant turn，等待后续行为来推断采纳情况
	 */
	public registerAssistantTurn(
		taskId: string,
		turnIndex: number,
		suggestionType: SuggestionType,
		hasCode: boolean,
		ts: string,
	): void {
		// 先结算上一条待判断的 turn
		this.finalizeIfPending(taskId)

		this.pendingTurns.set(taskId, {
			ts,
			taskId,
			turnIndex,
			suggestionType,
			hasCode,
			hasCodeEdit: false,
			hasFileSave: false,
			createdAt: Date.now(),
		})
	}

	/**
	 * 当检测到代码编辑事件时调用
	 */
	public onCodeEdit(taskId: string): void {
		const pending = this.pendingTurns.get(taskId)
		if (pending) {
			pending.hasCodeEdit = true
		}
	}

	/**
	 * 当检测到文件保存事件时调用
	 */
	public onFileSave(taskId: string): void {
		const pending = this.pendingTurns.get(taskId)
		if (pending) {
			pending.hasFileSave = true
		}
	}

	/**
	 * 当用户发送新消息时，推断上一条 assistant turn 的采纳状态
	 * @param taskId 任务 ID
	 * @param isSameTopic 是否是同一主题的追问
	 * @returns 推断的采纳状态
	 */
	public onUserMessage(taskId: string, isSameTopic: boolean): AdoptionStatus {
		const pending = this.pendingTurns.get(taskId)
		if (!pending) {
			return "unknown"
		}

		const status = this.inferAdoption(pending, isSameTopic)
		this.pendingTurns.delete(taskId)
		return status
	}

	/**
	 * 最终结算某任务的待判断 turn（任务结束或新 turn 到来时调用）
	 */
	public finalizeIfPending(taskId: string): AdoptionStatus {
		const pending = this.pendingTurns.get(taskId)
		if (!pending) {
			return "unknown"
		}

		const status = this.inferAdoptionByBehavior(pending)
		this.pendingTurns.delete(taskId)
		return status
	}

	/**
	 * 获取某任务当前的待判断状态（用于调试）
	 */
	public getPendingTurn(taskId: string): PendingAssistantTurn | undefined {
		return this.pendingTurns.get(taskId)
	}

	/**
	 * 核心推断逻辑：结合用户后续消息和行为来判断
	 */
	private inferAdoption(pending: PendingAssistantTurn, isSameTopic: boolean): AdoptionStatus {
		// 【F11-②】采纳的前提是"学生还在原来的题目上"。换了话题 ⇒ 本轮行为**无法归因**于上一条建议，
		// 一律 unknown。
		// 修复前：规则 1（完全不看 topic）、规则 2（completion 无条件）与兜底
		// （"有编辑但换了话题 ⇒ adopted"）三处都会在换题后记 adopted ⇒ `adopted` 近乎恒真。
		if (!isSameTopic) {
			return "unknown"
		}

		// 规则 1：同主题下 AI 给了代码、学生随后编辑/保存 → adopted
		if (pending.hasCode && (pending.hasCodeEdit || pending.hasFileSave)) {
			return "adopted"
		}

		// 规则 2：同主题下 AI 以 attempt_completion 收尾 → adopted
		if (pending.suggestionType === "completion") {
			return "adopted"
		}

		// 规则 3：同主题继续追问 → continued
		return "continued"
	}

	/**
	 * 仅基于行为推断（没有用户后续消息时使用）
	 */
	private inferAdoptionByBehavior(pending: PendingAssistantTurn): AdoptionStatus {
		const elapsed = Date.now() - pending.createdAt

		// 有代码编辑或保存行为 → adopted
		if (pending.hasCodeEdit || pending.hasFileSave) {
			return "adopted"
		}

		// 超时且无行为 → unknown
		if (elapsed > ADOPTION_TIMEOUT_MS) {
			return "unknown"
		}

		return "unknown"
	}

	/**
	 * 推断"是否同一主题"的简单逻辑
	 * 基于上一条 assistant 的 category 和当前用户消息的 category 是否相同
	 */
	public static isSameTopicHeuristic(prevCategory: string | undefined, currentCategory: string | undefined): boolean {
		if (!prevCategory || !currentCategory) {
			return false
		}
		return prevCategory === currentCategory
	}

	/**
	 * 清理所有待判断状态
	 */
	public clear(): void {
		this.pendingTurns.clear()
	}
}
