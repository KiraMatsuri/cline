import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { ev } from "./__fixtures__/events"

// 公共事件构造器 ev() 的默认 category 是 "code_generation"，这里显式传 category 覆盖。

describe("F5 · 分类口径粘性（code_generation 不被弱信号覆盖）", () => {
	it("★ 追问「再实现一个快速排序」（algorithm）不得覆盖已有的 code_generation", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "code_generation" }))
		expect(m.getTaskCategory()).to.equal("code_generation")
		m.ingest(ev({ eventType: "turn_message", role: "user", category: "algorithm" }))
		expect(m.getTaskCategory()).to.equal("code_generation")
	})

	it("★ explanation / other 同样不得覆盖 code_generation", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "code_generation" }))
		m.ingest(ev({ eventType: "turn_message", role: "user", category: "explanation" }))
		expect(m.getTaskCategory()).to.equal("code_generation")
		m.ingest(ev({ eventType: "turn_message", role: "user", category: "other" }))
		expect(m.getTaskCategory()).to.equal("code_generation")
	})

	it("★ 概念任务（无 code_generation）仍可被后续分类正常改写", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "algorithm" }))
		expect(m.getTaskCategory()).to.equal("algorithm")
		m.ingest(ev({ eventType: "turn_message", role: "user", category: "explanation" }))
		expect(m.getTaskCategory()).to.equal("explanation")
	})

	it("★ 强信号可覆盖 code_generation（students 在新代码上工作时）", () => {
		for (const strong of ["debugging", "refactoring", "testing"] as const) {
			const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
			m.ingest(ev({ eventType: "task_start", role: "user", category: "code_generation" }))
			m.ingest(ev({ eventType: "turn_message", role: "user", category: strong }))
			expect(m.getTaskCategory(), `category=${strong} 应可覆盖`).to.equal(strong)
		}
	})

	it("★ 回归：粘性不影响既有分类链路（无历史时按首条消息确定）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "debugging" }))
		expect(m.getTaskCategory()).to.equal("debugging")
		m.ingest(ev({ eventType: "turn_message", role: "user", category: "algorithm" }))
		expect(m.getTaskCategory()).to.equal("algorithm")
	})

	it("★ 助手事件不得参与分类（只读学生侧）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "code_generation" }))
		m.ingest(ev({ role: "assistant", category: "algorithm" }))
		expect(m.getTaskCategory()).to.equal("code_generation")
	})

	it("★ reset() 后粘性解除（新任务回到未分类状态）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "code_generation" }))
		m.reset()
		expect(m.getTaskCategory()).to.equal(undefined)
		m.ingest(ev({ eventType: "task_start", role: "user", category: "algorithm" }))
		expect(m.getTaskCategory()).to.equal("algorithm")
	})
})
