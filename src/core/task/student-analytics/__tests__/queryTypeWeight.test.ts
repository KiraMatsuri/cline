/**
 * 【P6/T7】询问类型影响 AI 依赖度：概念问答只记 50%。
 * 目的：① 概念提问重复出现时**应当**出现干预文案（用户 2026-10-14 第 3 问）；
 *      ② 但单次提问必须仍然零提示（保住 M1'）。
 */
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { dependencyWeightForQueryType, toQueryType } from "../queryType"
import type { StudentInteractionLog } from "../types"
import { ev } from "./__fixtures__/events"

const ask = (raw: string, category: StudentInteractionLog["category"]): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", category, hasCode: false, hasCodeBlock: false, rawContent: raw })

describe("【P6/T7】询问类型 → 依赖度加权", () => {
	it("★ 权重表", () => {
		expect(toQueryType("explanation")).to.equal("concept")
		expect(toQueryType("algorithm")).to.equal("concept")
		expect(toQueryType("code_generation")).to.equal("coding")
		expect(toQueryType("debugging")).to.equal("coding")
		expect(toQueryType("testing")).to.equal("coding")
		expect(toQueryType("other")).to.equal("other")
		expect(toQueryType(undefined)).to.equal("other")
		expect(dependencyWeightForQueryType("concept")).to.equal(0.5)
		expect(dependencyWeightForQueryType("coding")).to.equal(1)
		expect(dependencyWeightForQueryType("other")).to.equal(1)
	})

	it("★ 单次概念提问：零提示（保住 M1'）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ask("什么是冒泡排序", "algorithm"))
		expect(m.getWeightedDependencyScore()).to.equal(0.5)
		expect(m.getPendingAlerts().some((a) => a.ruleId === "high_recent_ai_dependency")).to.equal(false)
	})

	it("★ 6 次概念提问 ⇒ 加权和 3.0 ⇒ 出现提示（且永不阻断）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 6; i++) {
			m.ingest(ask(`第 ${i + 1} 个概念问题`, "explanation"))
		}
		expect(m.getWeightedDependencyScore()).to.be.closeTo(3, 1e-9)
		expect(m.getPendingAlerts().some((a) => a.ruleId === "high_recent_ai_dependency")).to.equal(true)
		expect(m.shouldEscalateToBlocking("high_recent_ai_dependency")).to.equal(false)
	})

	it("★ 3 次编码类提问 ⇒ 加权和 3.0 ⇒ 出现提示；学生本人编辑 ⇒ 清零", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m.ingest(ask(`第 ${i + 1} 次求助`, "code_generation"))
		}
		expect(m.getWeightedDependencyScore()).to.be.closeTo(3, 1e-9)
		expect(m.getPendingAlerts().some((a) => a.ruleId === "high_recent_ai_dependency")).to.equal(true)

		m.reset()
		m.ingest(ask("第 1 次", "code_generation"))
		m.ingest(ev({ eventType: "code_edit", category: "other", hasCode: false, hasCodeBlock: false, editor: "user" }))
		expect(m.getWeightedDependencyScore()).to.equal(0)
	})

	it("★ 边界：窗口上限 10 次请求（滚动窗口，不是无限累计）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 25; i++) {
			m.ingest(ask(`第 ${i + 1} 问`, "explanation"))
		}
		expect(m.getWeightedDependencyScore()).to.be.at.most(5) // 10 × 0.5
	})
})
