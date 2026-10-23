import { expect } from "chai"
import { getRulePolicy } from "../rulePolicy"
import type { BehaviorRuleId, TaskCategory } from "../types"

/** 全部规则（阻断能力已删除，所有规则都只产出软提示）*/
const ALL_RULES: BehaviorRuleId[] = [
	"ai_coding_rounds",
	"consecutive_code_generation",
	"no_edit_streak",
	"high_adoption_low_self_modification",
	"high_recent_ai_dependency",
	"complete_impl_demand",
]

describe("rulePolicy · getRulePolicy（方案 C-1）", () => {
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

	it("★ ai_coding_rounds 在任何分类下都启用（仅软提示，不存在阻断升级）", () => {
		for (const category of [undefined, "other", "explanation", "algorithm", "code_generation"] as Array<
			TaskCategory | undefined
		>) {
			expect(getRulePolicy("ai_coding_rounds", category), `${category}`).to.deep.equal({ enabled: true })
		}
	})

	it("★ 概念问答下依赖规则改为**启用**（重复概念提问也要能出提示）", () => {
		expect(getRulePolicy("high_recent_ai_dependency", "algorithm")).to.deep.equal({ enabled: true })
	})

	it("★ high_recent_ai_dependency 在任何分类下都启用", () => {
		for (const category of [undefined, "other", "explanation", "algorithm", "code_generation"] as Array<
			TaskCategory | undefined
		>) {
			expect(getRulePolicy("high_recent_ai_dependency", category), `${category}`).to.deep.equal({ enabled: true })
		}
	})

	it("★ 代码类任务下所有规则都启用", () => {
		for (const category of ["code_generation", "debugging", "refactoring", "testing"] as TaskCategory[]) {
			for (const rule of ALL_RULES) {
				expect(getRulePolicy(rule, category).enabled, `${category}/${rule}`).to.equal(true)
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

	it("★【F5】code_generation 下代码类规则可用（门控未失效）", () => {
		expect(getRulePolicy("consecutive_code_generation", "code_generation")).to.deep.equal({ enabled: true })
		expect(getRulePolicy("no_edit_streak", "code_generation")).to.deep.equal({ enabled: true })
	})

	it("★ 策略对象只含 enabled 字段（不存在 canEscalateToBlocking 等阻断升级能力）", () => {
		for (const rule of ALL_RULES) {
			const policy = getRulePolicy(rule, "code_generation")
			expect(Object.keys(policy), rule).to.deep.equal(["enabled"])
			expect(policy).to.not.have.property("canEscalateToBlocking")
		}
	})
})
