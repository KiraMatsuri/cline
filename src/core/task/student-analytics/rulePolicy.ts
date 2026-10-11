/**
 * 规则策略（方案 C-1）
 *
 * 背景：4 条规则原本对任何任务都启用，但它们的阈值是按"学生在写代码、AI 在旁辅助"设计的。
 * 学生端当前的主要用法是"提问 → AI 检索资料并讲解"，在这个用法下：
 *   - 学生本来就不编辑代码 → no_edit_streak 恒真
 *   - 一次提问产生多个助手回合 → high_recent_ai_dependency 恒 > 0.7
 *   - Python 讲解必然出现代码/反引号 → consecutive_code_generation 极易触发
 * 三条规则同时近似恒真 + 升级阈值小 = 几轮内必然阻断。
 *
 * 本模块把"什么时候该干预"显式编码为纯函数，便于单测与离线复算。
 */

import type { BehaviorRuleId, TaskCategory } from "./types"

export interface RulePolicy {
	/** 该规则是否参与评估 */
	enabled: boolean
	/** 命中后是否允许累计升级为阻断式干预 */
	canEscalateToBlocking: boolean
}

/** 以"讲解/思路"为主的分类：学生的意图是理解，不是要可运行代码 */
const CONCEPTUAL_CATEGORIES: ReadonlySet<TaskCategory> = new Set<TaskCategory>(["explanation", "algorithm"])

/** 在概念问答场景下没有意义的代码类规则 */
const CODE_ORIENTED_RULES: ReadonlySet<BehaviorRuleId> = new Set<BehaviorRuleId>([
	"consecutive_code_generation",
	"no_edit_streak",
])

/**
 * 判定某条规则在给定任务分类下的策略。
 *
 * 保守原则：分类缺失/未知/other/language_request 时**全部启用且可升级** ——
 * 宁可保留原有干预能力，也不要因为分类器没命中而让干预静默失效。
 */
export function getRulePolicy(ruleId: BehaviorRuleId, category: TaskCategory | undefined): RulePolicy {
	if (!category || !CONCEPTUAL_CATEGORIES.has(category)) {
		return { enabled: true, canEscalateToBlocking: true }
	}

	// 概念问答：代码类规则整体停用
	if (CODE_ORIENTED_RULES.has(ruleId)) {
		return { enabled: false, canEscalateToBlocking: false }
	}

	// 其余规则（AI 依赖 / 只采纳不消化）仍保留提示，但不允许升级为阻断 ——
	// 因为在这类任务里它们的分母（user turn_message 数）天然极小，比例指标不可靠。
	return { enabled: true, canEscalateToBlocking: false }
}
