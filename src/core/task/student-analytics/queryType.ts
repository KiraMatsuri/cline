/**
 * 【P6/T7】询问类型（queryType）与其对 AI 依赖度的权重。
 *
 * 为什么需要：依赖度原来按"连续无学生发言的助手回合数"算，在概念问答里分母不可靠，
 * 于是 F9 干脆把该规则在概念分类下整条停用 ⇒ **学生反复问概念题时不会有任何提示**。
 * 改为"学生请求加权和"后分母可靠，概念分类下也能安全启用：
 * **概念问答记 50%**（用户裁定），即 6 次概念提问 ≈ 3 次编码类提问。
 */

import type { TaskCategory } from "./types"

export type QueryType = "concept" | "coding" | "other"

/** 概念问答的依赖度权重（用户 2026-10-14 裁定：只记 50%） */
export const CONCEPT_DEPENDENCY_WEIGHT = 0.5
/** 其余类型按满权重计（含"分类缺失"，沿用"宁可保留能力"的保守原则） */
export const CODING_DEPENDENCY_WEIGHT = 1

const CONCEPT_CATEGORIES: ReadonlySet<TaskCategory> = new Set<TaskCategory>(["explanation", "algorithm"])
const CODING_CATEGORIES: ReadonlySet<TaskCategory> = new Set<TaskCategory>([
	"code_generation",
	"debugging",
	"refactoring",
	"testing",
])

export function toQueryType(category: TaskCategory | undefined): QueryType {
	if (!category) {
		return "other"
	}
	if (CONCEPT_CATEGORIES.has(category)) {
		return "concept"
	}
	if (CODING_CATEGORIES.has(category)) {
		return "coding"
	}
	return "other"
}

export function dependencyWeightForQueryType(queryType: QueryType): number {
	return queryType === "concept" ? CONCEPT_DEPENDENCY_WEIGHT : CODING_DEPENDENCY_WEIGHT
}
