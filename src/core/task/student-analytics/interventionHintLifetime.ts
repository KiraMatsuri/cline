/**
 * 【P8/T6】干预提示的生命周期判定（纯函数）。
 *
 * 为什么需要：2026-10-18 实测发现第一条决策（09:54:13）**既没送达也没记账** ——
 * 该请求内模型连续做了 4 个工具轮才出正文，而旧逻辑的顺延重投上限是「2 轮」：
 * 到第 4 轮时 `pendingInterventionText` 被清空，正文到达时已无模板可兜底 ⇒
 * 学生没看到提示、日志也没有 `intervention_copy`（M9' ③ 因此差 1）。
 *
 * 新口径：**同一学生请求内一直有效**（学生还没换话题，提示就还有意义）；
 * 跨请求时才用原有的「最多顺延 N 轮」，避免陈年提示污染下一轮。
 */
export interface HintLifetimeInput {
	/** 是否存在待投递的干预文本 */
	hasPending: boolean
	/** 本轮是否已经交付过一条文案（交付过就不该再顺延） */
	delivered: boolean
	/** 决策产生时的学生请求序号（`undefined` = 未知，退回旧口径） */
	decisionRequest?: number
	/** 当前学生请求序号 */
	currentRequest: number
	/** 跨请求顺延的剩余次数 */
	redeliveryLeft: number
}

export interface HintLifetimeDecision {
	/** 是否继续保留并重投该提示 */
	carryOver: boolean
	/** 是否消耗一次跨请求顺延额度（同请求内不消耗） */
	consumeRedelivery: boolean
}

export function decideHintLifetime(input: HintLifetimeInput): HintLifetimeDecision {
	if (!input.hasPending || input.delivered) {
		return { carryOver: false, consumeRedelivery: false }
	}
	// 同一学生请求 ⇒ 一直有效（工具轮多也不丢），且不消耗跨请求额度
	if (input.decisionRequest !== undefined && input.decisionRequest === input.currentRequest) {
		return { carryOver: true, consumeRedelivery: false }
	}
	if (input.redeliveryLeft > 0) {
		return { carryOver: true, consumeRedelivery: true }
	}
	return { carryOver: false, consumeRedelivery: false }
}
