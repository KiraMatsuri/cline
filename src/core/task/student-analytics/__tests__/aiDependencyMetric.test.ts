/**
 * 【P6/T7】ai_dependency = **学生请求的加权和**（概念问答记 0.5，其余 1.0），阈值 3。
 *
 * 旧口径是「连续无学生发言的**助手回合数**」—— 在「一次提问 → 6~12 个助手回合」的形态下
 * 它和依赖度无关（F9 实测），只能靠「概念分类下整条停用」止血，代价是**反复问概念题毫无提示**。
 * 本文件把新口径写成可执行契约：
 *   ① 单位 = 学生请求（一次长提问无论多少助手回合最多推进 1 格）；
 *   ② 概念问答只记 50%（6 次概念提问 ≈ 3 次编码类提问）；
 *   ③ 学生本人编辑 ⇒ 归零；AI 落盘**不**归零；
 *   ④ 单次请求仍然零提示（M1' 的通过条件）；
 *   ⑤ 无论攒到多少都**永不阻断**（阻断唯一入口是 `ai_coding_rounds`）。
 */
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import type { StudentInteractionLog, TaskCategory } from "../types"
import { editEv, ev } from "./__fixtures__/events"

/** 学生提问（依赖度的唯一计量单位） */
const ask = (category: TaskCategory, raw: string): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", category, hasCode: false, hasCodeBlock: false, rawContent: raw })

describe("【P6/T7】ai_dependency = 学生请求加权和", () => {
	it("★ 阈值边界：2 次编码类提问（2.0）不触发，第 3 次（3.0）触发", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ask("code_generation", "第一句"))
		m.ingest(ask("code_generation", "第二句"))
		expect(m.getWeightedDependencyScore()).to.equal(2)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("high_recent_ai_dependency")

		m.ingest(ask("code_generation", "第三句"))
		expect(m.getWeightedDependencyScore()).to.equal(3)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("high_recent_ai_dependency")
	})

	it("★ 学生本人编辑代码 ⇒ 加权窗口归零（依赖消失）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) m.ingest(ask("code_generation", `第 ${i + 1} 句`))
		expect(m.getWeightedDependencyScore()).to.equal(3)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)

		m.ingest(editEv({ editor: "user" })) // 学生亲手改代码
		expect(m.getWeightedDependencyScore()).to.equal(0)

		// 从 0 重新累计：再问 2 次（2.0 < 3）不得命中 —— 若没清零，这 2 次会把分数推到 5 并再记一次
		for (let i = 0; i < 2; i++) m.ingest(ask("code_generation", `清零后第 ${i + 1} 句`))
		expect(m.getWeightedDependencyScore()).to.equal(2)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
	})

	it("★ 计数与提醒冷却解耦（冷却期内仍逐请求计数）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 120_000 })
		for (let i = 0; i < 3; i++) m.ingest(ask("code_generation", `第 ${i + 1} 句`))
		// 第 3 次请求首次命中加权阈值
		expect(m.getWeightedDependencyScore()).to.equal(3)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
		// 【交接复查】命中后继续追问仍在计数（旧断言只覆盖"冷却期内逐轮计数"，未验证命中后的持续推进）
		m.ingest(ask("code_generation", "第 4 句"))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(2)

		m.ingest(ask("code_generation", "第 5 句"))
		m.ingest(ask("code_generation", "第 6 句"))
		expect(m.getWeightedDependencyScore()).to.equal(6)
		// 第 3/4/5/6 次请求时分数已达阈值 ⇒ 计数不受冷却影响（共 4 次）
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(4)
		// 提醒仍受 120s 冷却 ⇒ 本规则只出 1 条
		expect(m.getPendingAlerts().filter((a) => a.ruleId === "high_recent_ai_dependency").length).to.equal(1)
		// 【交接复查】补回"同序列的 pendingAlerts 总数"断言（T7 改写时丢失）：
		// 新口径下共 2 条 —— high_recent_ai_dependency + 并发的 no_edit_streak（第 3 次学生请求首次命中）。
		expect(m.getPendingAlerts()).to.have.lengthOf(2)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("high_recent_ai_dependency")
	})

	it("★ 单次概念提问零提示（M2' 的通过条件）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "explanation" }))
		for (let i = 0; i < 8; i++) m.ingest(ev({ role: "assistant" }))
		// 助手回合不再计权：分数只来自那一次开题（概念 ⇒ 0.5）
		expect(m.getWeightedDependencyScore()).to.equal(0.5)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("high_recent_ai_dependency")
		expect(m.shouldEscalateToBlocking("high_recent_ai_dependency")).to.equal(false)
	})

	it("★ reset() 后加权窗口与计数一并归零", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) m.ingest(ask("code_generation", `第 ${i + 1} 句`))
		expect(m.getWeightedDependencyScore()).to.equal(3)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)

		m.reset()
		expect(m.getWeightedDependencyScore()).to.equal(0)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		expect(m.getCurrentRequestQueryType()).to.equal("other")
		expect(m.getCurrentRequestDependencyWeight()).to.equal(1)
	})

	it("★【P5-A/T19-b】一次提问内的多回合不再计入（M1' 的通过条件），且永不阻断", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		// 一次提问（task_start）+ 12 个助手回合：实测 M1' 就是这种形态（一提问即误报"AI 独占"）
		m.ingest(ev({ eventType: "task_start", role: "user", category: "code_generation" }))
		for (let i = 0; i < 12; i++) m.ingest(ev({ role: "assistant" }))
		expect(m.getWeightedDependencyScore()).to.equal(1) // 一次请求 = 1.0，与助手回合数无关
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("high_recent_ai_dependency")

		// 规则本身仍启用（没被关掉），只是不再把"一次长提问"当依赖：累计到 3 次请求即命中
		m.ingest(ask("code_generation", "第二句"))
		m.ingest(ask("code_generation", "第三句"))
		expect(m.getWeightedDependencyScore()).to.equal(3)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
		// 但**永不得**进入阻断候选
		expect(m.shouldEscalateToBlocking("high_recent_ai_dependency")).to.equal(false)
		expect(m.getRuleIdsAtBlockingThreshold()).to.not.include("high_recent_ai_dependency")
	})

	it("★【P6/T6】原可升级的代码规则现只提示（对照）：计数照旧、阻断恒 false", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(ev({}))
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(3)
		expect(m.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
	})

	it("★【修复】学生编辑代码（code_edit）也把加权窗口清空", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) m.ingest(ask("code_generation", `第 ${i + 1} 句`))
		expect(m.getWeightedDependencyScore()).to.equal(3) // 前提：清零前确实攒到了阈值
		m.ingest(editEv({ editor: "user" })) // 学生亲手改代码
		expect(m.getWeightedDependencyScore()).to.equal(0)
	})

	it("★【修复】AI 落盘（editor: ai）**不**归零（那不是学生动手）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) m.ingest(ask("code_generation", `第 ${i + 1} 句`))
		expect(m.getWeightedDependencyScore()).to.equal(3)
		m.ingest(editEv({ editor: "ai" }))
		expect(m.getWeightedDependencyScore()).to.equal(3)
	})
})
