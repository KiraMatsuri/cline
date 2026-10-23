/**
 * 规则策略（方案 C-1）
 *
 * 背景：4 条规则原本对任何任务都启用，但它们的阈值是按"学生在写代码、AI 在旁辅助"设计的。
 * 学生端当前的主要用法是"提问 → AI 检索资料并讲解"，在这个用法下：
 *   - 学生本来就不编辑代码 → no_edit_streak 恒真
 *   - 一次提问产生多个助手回合 → high_recent_ai_dependency 恒 > 0.7
 *   - Python 讲解必然出现代码/反引号 → consecutive_code_generation 极易触发
 * 三条规则同时近似恒真。
 *
 * 【P2-2】阻断式干预已整体移除：本模块只剩「该规则是否参与评估」这一件事。
 * 旧的白名单（能力升级白名单）已删除 ——
 * 任何规则都**不再**升级为阻断式干预（不 ask、不结束回合）。
 *
 * 本模块把"什么时候该干预"显式编码为纯函数，便于单测与离线复算。
 */

import type { BehaviorRuleId, TaskCategory } from "./types"

export interface RulePolicy {
	/** 该规则是否参与评估 */
	enabled: boolean
}

/** 以"讲解/思路"为主的分类：学生的意图是理解，不是要可运行代码 */
const CONCEPTUAL_CATEGORIES: ReadonlySet<TaskCategory> = new Set<TaskCategory>(["explanation", "algorithm"])

/** 在概念问答场景下没有意义的代码类规则 */
const CODE_ORIENTED_RULES: ReadonlySet<BehaviorRuleId> = new Set<BehaviorRuleId>([
	"consecutive_code_generation",
	"no_edit_streak",
])

/** 任何分类下都启用：描述的是**学生意图/助手行为**，与任务分类无关 */
const ALWAYS_ENABLED_RULES: ReadonlySet<BehaviorRuleId> = new Set<BehaviorRuleId>(["complete_impl_demand", "ai_coding_rounds"])

/**
 * 判定某条规则在给定任务分类下的策略。
 *
 * 保守原则：分类缺失/未知/other/language_request 时**全部启用** ——
 * 宁可保留原有干预能力，也不要因为分类器没命中而让干预静默失效。
 */
export function getRulePolicy(ruleId: BehaviorRuleId, category: TaskCategory | undefined): RulePolicy {
	// 「索要完整实现」描述学生意图、「AI 落盘计数」描述助手行为 —— 都与任务分类无关，
	// 概念问答恰恰是它们最需要生效的场景。
	if (ALWAYS_ENABLED_RULES.has(ruleId)) {
		return { enabled: true }
	}

	// 概念问答：代码类规则停用（原有理由不变：这类任务下它们的分母恒真）
	if (category && CONCEPTUAL_CATEGORIES.has(category) && CODE_ORIENTED_RULES.has(ruleId)) {
		return { enabled: false }
	}

	// 其余规则一律启用
	return { enabled: true }
}

// =============================================
// 【P2-3】六条软提示规则（只提示、永不阻断）
// =============================================

/**
 * 【P2-3】六条软提示规则的 ID。
 *
 * 它们都已并入 `types.ts` 的 `BehaviorRuleId`（日志字段可直接写），
 * 这里单独抽一份子集类型，便于「软规则专属逻辑」在类型层面与旧六条规则隔开。
 */
export type SoftInterventionRuleId =
	| "design_stall"
	| "same_error_twice"
	| "full_impl_demand"
	| "ai_code_streak"
	| "concept_streak"
	| "error_no_progress"

/** 【P2-3】全部软规则（顺序 = 设计 §5.2 表格顺序） */
export const SOFT_INTERVENTION_RULE_IDS: readonly SoftInterventionRuleId[] = [
	"design_stall",
	"same_error_twice",
	"full_impl_demand",
	"ai_code_streak",
	"concept_streak",
	"error_no_progress",
]

/**
 * 【P2-3 / BN-37】同一条消息同时命中多条软规则时**只出一条**的优先级（高 → 低）。
 * 前两条是「学生明显卡住/在重复踩坑」的强信号；其余按出现顺序稳定排序。
 */
export const SOFT_INTERVENTION_PRIORITY: readonly SoftInterventionRuleId[] = [
	"full_impl_demand",
	"same_error_twice",
	"error_no_progress",
	"design_stall",
	"ai_code_streak",
	"concept_streak",
]

/** 【P2-3】软提示冷却时长（与 `BehaviorMonitor.DEFAULT_OPTIONS.cooldownMs` 同源：120s） */
export const SOFT_INTERVENTION_COOLDOWN_MS = 120_000

/**
 * 【P2-3】完整实现索要的「放行伪代码」档位（第 4 次起）。
 * ⚠️ 与 P1-6 的 `TeachingSessionMode.DEMAND_LADDER.experiment = 4` 对齐；Lead 集成时如需统一请以 P1-6 为准。
 */
export const FULL_IMPL_DEMAND_RELEASE_COUNT = 4

/** 【P2-3】判定某个规则 ID 是否属于六条软提示规则（收窄类型用） */
export function isSoftInterventionRule(ruleId: string): ruleId is SoftInterventionRuleId {
	return (SOFT_INTERVENTION_RULE_IDS as readonly string[]).includes(ruleId)
}

/**
 * 【P2-3】软提示规则的策略：**任何任务分类下都启用**（否则概念问答里 `concept_streak` 永不触发）。
 * 软提示本身只提示、永不阻断，因此策略里没有「可升级阻断」的位置。
 */
export function getSoftRulePolicy(ruleId: SoftInterventionRuleId, _category: TaskCategory | undefined): RulePolicy {
	return { enabled: isSoftInterventionRule(ruleId) }
}
