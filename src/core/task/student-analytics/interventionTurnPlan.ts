/**
 * 【P6/T2】回合级的干预编排（纯函数）。
 *
 * 为什么抽出来：携带重投（`carryOverHint`）/ 阻断例外 / 是否记账这三条规则原来内联在
 * `recursivelyMakeClineRequests` 里，只能靠"读源码字符串"断言（Task 1 初审 ⚠️）。
 */
export interface TurnPlanInput {
	/** 上一轮的注入未被展示 ⇒ 本轮顺延重投 */
	carryOverHint: boolean
	/** 本轮是否产生了决策 */
	hasDecision: boolean
	/** 决策是否为阻断型 */
	isBlocking: boolean
}

export interface TurnPlan {
	/** 是否采用本轮决策的注入文本（阻断分支把它作为学生可见文案展示） */
	inject: boolean
	/** 是否用本轮决策覆盖"待投递 / 兜底模板"三个字段（顺延回合不覆盖） */
	overwritePending: boolean
	/** 是否落 `intervention_decision` 记账 */
	accountDecision: boolean
}

export function planInterventionTurn(input: TurnPlanInput): TurnPlan {
	const { carryOverHint, hasDecision, isBlocking } = input
	if (!hasDecision) {
		return { inject: false, overwritePending: false, accountDecision: false }
	}
	// 阻断无条件生效（带新的倒计时）且必须记账
	if (isBlocking) {
		return { inject: true, overwritePending: true, accountDecision: true }
	}
	// 顺延回合：保留上一轮那条待投递文案（避免"记的是新文案、学生看到的是旧文案"），也不再重复记账
	if (carryOverHint) {
		return { inject: true, overwritePending: false, accountDecision: false }
	}
	return { inject: true, overwritePending: true, accountDecision: true }
}
