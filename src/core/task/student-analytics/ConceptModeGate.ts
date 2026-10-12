/**
 * 【F3】概念问答模式「粘性」状态机。
 *
 * 为什么必须粘性：护栏原先按「单轮分类」重算，学生再问一次完整代码就把该轮重分类为
 * code_generation，护栏被静默撤销 —— 等于学生只要多要一次就能拆掉它。改为任务级状态后，
 * 只有两条路径可退出（学生本人编辑代码 / 意图转向已有的具体代码），反复索要只会被计数。
 */

import type { TaskCategory } from "./types"

/** 以"讲解/思路"为主的分类 */
const CONCEPTUAL: ReadonlySet<TaskCategory> = new Set<TaskCategory>(["explanation", "algorithm"])
/** 表示"学生在处理已有的具体代码" → 概念护栏退出 */
const CODE_WORK: ReadonlySet<TaskCategory> = new Set<TaskCategory>(["debugging", "refactoring", "testing", "language_request"])

export interface ConceptModeSignals {
	category: TaskCategory | undefined
	studentEdited: boolean
	wantsCompleteImpl: boolean
}

export interface ConceptModeState {
	active: boolean
	/**
	 * 概念模式**存续期间**学生索要「完整实现」的次数。
	 * 只在 active === true 时递增：护栏一旦退出（学生本人编辑代码 / 意图转向已有具体代码），
	 * 后续的 code_generation 请求不再计入 —— 它反映的是"护栏顶着多少次压力"，而非全局计数。
	 */
	completeImplDemands: number
}

export const INITIAL_CONCEPT_MODE_STATE: ConceptModeState = Object.freeze({
	active: false,
	completeImplDemands: 0,
})

export function nextConceptMode(prev: ConceptModeState, s: ConceptModeSignals): ConceptModeState {
	const demands = prev.completeImplDemands + (prev.active && s.wantsCompleteImpl ? 1 : 0)
	// 退出只有两条 —— ★「索要完整代码」不在其中（这是本次修订的核心）
	if (prev.active && (s.studentEdited || (s.category !== undefined && CODE_WORK.has(s.category)))) {
		return { active: false, completeImplDemands: demands }
	}
	const active = prev.active || (s.category !== undefined && CONCEPTUAL.has(s.category))
	return { active, completeImplDemands: demands }
}
