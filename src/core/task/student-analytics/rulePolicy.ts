/**
 * 规则策略（方案 C-1 +【P6/T6】阻断白名单反转）
 *
 * 背景：4 条规则原本对任何任务都启用，但它们的阈值是按"学生在写代码、AI 在旁辅助"设计的。
 * 学生端当前的主要用法是"提问 → AI 检索资料并讲解"，在这个用法下：
 *   - 学生本来就不编辑代码 → no_edit_streak 恒真
 *   - 一次提问产生多个助手回合 → high_recent_ai_dependency 恒 > 0.7
 *   - Python 讲解必然出现代码/反引号 → consecutive_code_generation 极易触发
 * 三条规则同时近似恒真 + 升级阈值小 = 几轮内必然阻断。
 *
 * 【P6/T6】阻断式干预已改为**独立通道**（product ruling 2026-10-14）：唯一入口是
 * `ai_coding_rounds`（助手真实落盘次数，阈值 3，学生本人编辑清零）。其余规则一律
 * "可提示、不可阻断" —— 因此本模块由原先的"黑名单"（个别规则永不可阻断）**反转为白名单**
 * （只有一条可阻断）。
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

/** 【P6/T6】仅有这一个规则可以升级为阻断式干预（独立通道，见 plan-2 §12.2） */
const BLOCKING_CAPABLE_RULES: ReadonlySet<BehaviorRuleId> = new Set<BehaviorRuleId>(["ai_coding_rounds"])

/** 【P6/T6】任何分类下都启用（仍不可阻断）：描述的是**学生意图/助手行为**，与任务分类无关 */
const ALWAYS_ENABLED_RULES: ReadonlySet<BehaviorRuleId> = new Set<BehaviorRuleId>(["complete_impl_demand", "ai_coding_rounds"])

/**
 * 判定某条规则在给定任务分类下的策略。
 *
 * 保守原则：分类缺失/未知/other/language_request 时**全部启用** ——
 * 宁可保留原有干预能力，也不要因为分类器没命中而让干预静默失效。
 */
export function getRulePolicy(ruleId: BehaviorRuleId, category: TaskCategory | undefined): RulePolicy {
	const canEscalateToBlocking = BLOCKING_CAPABLE_RULES.has(ruleId)

	// 「索要完整实现」描述学生意图、「AI 落盘计数」描述助手行为 —— 都与任务分类无关，
	// 概念问答恰恰是它们最需要生效的场景。
	if (ALWAYS_ENABLED_RULES.has(ruleId)) {
		return { enabled: true, canEscalateToBlocking }
	}

	// 概念问答：代码类规则停用（原有理由不变：这类任务下它们的分母恒真）
	if (category && CONCEPTUAL_CATEGORIES.has(category) && CODE_ORIENTED_RULES.has(ruleId)) {
		return { enabled: false, canEscalateToBlocking }
	}

	// 其余规则一律启用，但**永不可阻断**（P6/T6：阻断唯一入口是 ai_coding_rounds）
	return { enabled: true, canEscalateToBlocking }
}
