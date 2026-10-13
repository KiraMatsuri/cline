import { expect } from "chai"
import { getRulePolicy } from "../rulePolicy"
import type { BehaviorRuleId, TaskCategory } from "../types"

const ALL_RULES: BehaviorRuleId[] = [
	"consecutive_code_generation",
	"no_edit_streak",
	"high_adoption_low_self_modification",
	"high_recent_ai_dependency",
]

describe("getRulePolicy（方案 C-1）", () => {
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

	it("★【F9】概念问答下 AI 依赖规则连提示也停用，且不得升级为阻断", () => {
		const p = getRulePolicy("high_recent_ai_dependency", "explanation")
		expect(p.enabled).to.equal(false)
		expect(p.canEscalateToBlocking).to.equal(false)
	})

	it("★ 代码类任务下所有规则都启用；仅 AI 依赖不可升级为阻断（F9 回归修复）", () => {
		for (const category of ["code_generation", "debugging", "refactoring", "testing"] as TaskCategory[]) {
			for (const rule of ALL_RULES) {
				const p = getRulePolicy(rule, category)
				expect(p.enabled, `${category}/${rule}`).to.equal(true)
				// 【F9 回归修复 2026-10-13】high_recent_ai_dependency 永不可升级：其度量单位是
				// “连续无学生发言的助手回合数”，Cline 一次提问即产生 6~11 个助手回合，
				// 若允许升级则“一次提问就把学生阻断 60 秒”。其余三条仍可升级。
				const expectedEscalation = rule !== "high_recent_ai_dependency"
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

	it("★【F5】code_generation 下代码类规则可用且可升级（粘性要守住的正是这个口径）", () => {
		expect(getRulePolicy("consecutive_code_generation", "code_generation")).to.deep.equal({
			enabled: true,
			canEscalateToBlocking: true,
		})
		expect(getRulePolicy("no_edit_streak", "code_generation")).to.deep.equal({
			enabled: true,
			canEscalateToBlocking: true,
		})
	})

	it("★【F9】概念问答下 high_recent_ai_dependency 连提示都停用", () => {
		expect(getRulePolicy("high_recent_ai_dependency", "explanation").enabled).to.equal(false)
		expect(getRulePolicy("high_recent_ai_dependency", "algorithm").enabled).to.equal(false)
		// 非概念分类不受影响（仍出温和提示），但**任何分类下都不可升级为阻断**
		expect(getRulePolicy("high_recent_ai_dependency", "code_generation").enabled).to.equal(true)
		expect(getRulePolicy("high_recent_ai_dependency", undefined).enabled).to.equal(true)
		expect(getRulePolicy("high_recent_ai_dependency", "code_generation").canEscalateToBlocking).to.equal(false)
		expect(getRulePolicy("high_recent_ai_dependency", undefined).canEscalateToBlocking).to.equal(false)
	})
})
