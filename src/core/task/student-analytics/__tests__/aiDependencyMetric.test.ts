import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { ev } from "./__fixtures__/events"

describe("F9 · ai_dependency 绝对回合数指标", () => {
	it("★ 阈值边界：连续 5 个助手回合不触发，第 6 个触发", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 5; i++) m.ingest(ev({ role: "assistant" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("high_recent_ai_dependency")
		m.ingest(ev({ role: "assistant" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
	})

	it("★ 学生一发言即归零（依赖消失）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 5; i++) m.ingest(ev({ role: "assistant" }))
		m.ingest(ev({ role: "user", category: "code_generation" }))
		m.ingest(ev({ role: "assistant" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
	})

	it("★ 计数与提醒冷却解耦（冷却期内仍逐轮计数）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 120_000 })
		for (let i = 0; i < 8; i++) m.ingest(ev({ role: "assistant" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(3) // 第 6/7/8 回合各 +1
		// 提醒仍受 120s 冷却：AI 依赖规则本身只出 1 条。
		// 实测本序列的 pendingAlerts 共 3 条 —— 另两条来自同一序列下并发的
		// consecutive_code_generation 与 no_edit_streak（故按 ruleId 精确断言）。
		expect(m.getPendingAlerts().filter((a) => a.ruleId === "high_recent_ai_dependency").length).to.equal(1)
		expect(m.getPendingAlerts().length).to.equal(3)
	})

	it("★ 概念问答下零提示（M2' 的通过条件）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "explanation" }))
		for (let i = 0; i < 8; i++) m.ingest(ev({ role: "assistant" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("high_recent_ai_dependency")
		expect(m.shouldEscalateToBlocking("high_recent_ai_dependency")).to.equal(false)
	})

	it("★ reset() 后计数归零", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 6; i++) m.ingest(ev({ role: "assistant" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
		m.reset()
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
	})
})
