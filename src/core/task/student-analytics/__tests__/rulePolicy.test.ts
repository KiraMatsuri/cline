import { expect } from "chai"
import { getRulePolicy } from "../rulePolicy"
import type { BehaviorRuleId, TaskCategory } from "../types"

/** 全部规则（含独立阻断通道 `ai_coding_rounds`）*/
const ALL_RULES: BehaviorRuleId[] = [
	"ai_coding_rounds",
	"consecutive_code_generation",
	"no_edit_streak",
	"high_adoption_low_self_modification",
	"high_recent_ai_dependency",
	"complete_impl_demand",
]

describe("rulePolicy · getRulePolicy（方案 C-1 +【P6/T6】阻断白名单反转）", () => {
	it("★ 概念问答（explanation）下停用代码类规则", () => {
		for (const rule of ["consecutive_code_generation", "no_edit_streak"] as BehaviorRuleId[]) {
			expect(getRulePolicy(rule, "explanation").enabled, rule).to.equal(false)
		}
	})

	it("★ 算法思路（algorithm）同样停用代码类规则", () => {
		for (const rule of ["consecutive_code_generation", "no_edit_streak"] as BehaviorRuleId[]) {
			expect(getRulePolicy(rule, "algorithm").enabled, rule).to.equal(false)
		}
	})

	it("★【P6/T6】只有 ai_coding_rounds 允许升级为阻断，其余一律只提示", () => {
		for (const category of [undefined, "other", "explanation", "algorithm", "code_generation"] as Array<
			TaskCategory | undefined
		>) {
			expect(getRulePolicy("ai_coding_rounds", category), `${category}`).to.deep.equal({
				enabled: true,
				canEscalateToBlocking: true,
			})
			for (const rule of [
				"complete_impl_demand",
				"consecutive_code_generation",
				"no_edit_streak",
				"high_recent_ai_dependency",
				"high_adoption_low_self_modification",
			] as BehaviorRuleId[]) {
				expect(getRulePolicy(rule, category).canEscalateToBlocking, `${category}/${rule}`).to.equal(false)
			}
		}
	})

	it("★【P6/T6】概念问答下依赖规则改为**启用但只提示**（重复概念提问也要能出提示）", () => {
		expect(getRulePolicy("high_recent_ai_dependency", "algorithm")).to.deep.equal({
			enabled: true,
			canEscalateToBlocking: false,
		})
	})

	it("★【P6/T6】high_recent_ai_dependency 在任何分类下都启用，但任何分类下都不可阻断", () => {
		for (const category of [undefined, "other", "explanation", "algorithm", "code_generation"] as Array<
			TaskCategory | undefined
		>) {
			expect(getRulePolicy("high_recent_ai_dependency", category), `${category}`).to.deep.equal({
				enabled: true,
				canEscalateToBlocking: false,
			})
		}
	})

	it("★ 代码类任务下所有规则都启用；除 ai_coding_rounds 外一律不可升级为阻断", () => {
		for (const category of ["code_generation", "debugging", "refactoring", "testing"] as TaskCategory[]) {
			for (const rule of ALL_RULES) {
				const p = getRulePolicy(rule, category)
				expect(p.enabled, `${category}/${rule}`).to.equal(true)
				// 【P6/T6】阻断的唯一入口是独立通道 ai_coding_rounds：
				// 其余规则（含 F9 之后仍可升级的 consecutive_code_generation / no_edit_streak /
				// complete_impl_demand / high_adoption_low_self_modification）一律"可提示、不可阻断"。
				const expectedEscalation = rule === "ai_coding_rounds"
				expect(p.canEscalateToBlocking, `${category}/${rule}`).to.equal(expectedEscalation)
			}
		}
	})

	it("★ 分类未知 / other / language_request 时保守启用全部（不得因分类失败而静默失效）", () => {
		for (const category of [undefined, "other", "language_request"] as Array<TaskCategory | undefined>) {
			for (const rule of ALL_RULES) {
				expect(getRulePolicy(rule, category).enabled, `${category}/${rule}`).to.equal(true)
			}
		}
	})

	it("★【F5】code_generation 下代码类规则可用，但阻断能力已收归独立通道（不得被误读为门控失效）", () => {
		expect(getRulePolicy("consecutive_code_generation", "code_generation")).to.deep.equal({
			enabled: true,
			canEscalateToBlocking: false,
		})
		expect(getRulePolicy("no_edit_streak", "code_generation")).to.deep.equal({
			enabled: true,
			canEscalateToBlocking: false,
		})
	})
})
