/**
 * 【P6/T2】回合级的干预编排（纯函数）。
 *
 * 为什么抽出来：携带重投（`carryOverHint`）/ 阻断例外 / 是否覆盖待投递文案这三条规则原来内联在
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
	/**
	 * 是否用本轮决策覆盖"待投递 / 兜底模板"三个字段（顺延回合不覆盖）。
	 * 【P6/T2 fix】`intervention_decision` 记账与这三个字段同一门控 —— 不再另设一个恒等的
	 * `accountDecision` 字段（它从未被读取，只会让读者以为记账是另一条规则决定的）。
	 */
	overwritePending: boolean
}

export function planInterventionTurn(input: TurnPlanInput): TurnPlan {
	const { carryOverHint, hasDecision, isBlocking } = input
	if (!hasDecision) {
		return { inject: false, overwritePending: false }
	}
	// 阻断无条件生效（带新的倒计时）
	if (isBlocking) {
		return { inject: true, overwritePending: true }
	}
	// 顺延回合：保留上一轮那条待投递文案（避免"记的是新文案、学生看到的是旧文案"）
	if (carryOverHint) {
		return { inject: true, overwritePending: false }
	}
	return { inject: true, overwritePending: true }
}
