import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { editEv, ev } from "./__fixtures__/events"

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

	it("★【P5-A/T19-b】一次提问内的多回合**不再**计入 ai_dependency（M1' 的通过条件）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		// 一次提问（task_start）+ 12 个助手回合：实测 M1' 就是这种形态（一提问即误报"AI 独占"）
		m.ingest(ev({ eventType: "task_start", role: "user", category: "code_generation" }))
		for (let i = 0; i < 12; i++) m.ingest(ev({ role: "assistant" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("high_recent_ai_dependency")
		// 学生第二次发言后（>=2 次请求）规则仍正常计数 —— 它没被关掉，只是不再把"一次长提问"当依赖
		m.ingest(ev({ role: "user", category: "code_generation" }))
		for (let i = 0; i < 6; i++) m.ingest(ev({ role: "assistant" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.be.greaterThan(0)
		// 但**永不得**进入阻断候选
		expect(m.shouldEscalateToBlocking("high_recent_ai_dependency")).to.equal(false)
		expect(m.getRuleIdsAtBlockingThreshold()).to.not.include("high_recent_ai_dependency")
	})

	it("★【回归修复】其他三条规则的阻断能力未被削弱（对照）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(ev({}))
		expect(m.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(true)
	})

	it("★【修复】学生编辑代码（code_edit）也把计数归零", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 5; i++) m.ingest(ev({ role: "assistant" }))
		m.ingest(editEv({ editor: "user" })) // 学生亲手改代码
		m.ingest(ev({ role: "assistant" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
	})

	it("★【修复】AI 落盘（editor: ai）**不**归零（那不是学生动手）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 6; i++) m.ingest(ev({ role: "assistant" }))
		m.ingest(editEv({ editor: "ai" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
	})
})
