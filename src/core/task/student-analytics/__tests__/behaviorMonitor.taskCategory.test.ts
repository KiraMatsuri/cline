import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import type { StudentInteractionLog, TaskCategory } from "../types"

const ev = (
	taskId: string,
	role: "user" | "assistant",
	idx: number,
	category: TaskCategory,
	extra: Partial<StudentInteractionLog> = {},
): StudentInteractionLog => ({
	ts: new Date().toISOString(),
	taskId,
	eventType: "turn_message",
	role,
	category,
	contentLength: 10,
	hasCode: false,
	languageHint: "python",
	imageCount: 0,
	fileCount: 0,
	turnIndex: idx,
	...extra,
})

const taskStart = (taskId: string, category: TaskCategory): StudentInteractionLog => ({
	...ev(taskId, "user", 0, category),
	eventType: "task_start",
})

describe("BehaviorMonitor — 按学生意图分流（方案 C-1）", () => {
	it("★ 概念问答：即使连续 5 个助手回合都含代码，也不触发代码类规则", () => {
		const m = new BehaviorMonitor("c1", { cooldownMs: 0 })
		m.ingest(taskStart("c1", "explanation"))
		for (let i = 1; i <= 5; i++) {
			m.ingest(ev("c1", "assistant", i, "explanation", { hasCode: true, hasCodeBlock: true }))
		}
		const rules = m.getPendingAlerts().map((a) => a.ruleId)
		expect(rules).to.not.include("consecutive_code_generation")
		expect(rules).to.not.include("no_edit_streak")
	})

	it("★ 代码生成任务：同样的序列必须仍然触发（干预机制不得失效）", () => {
		const m = new BehaviorMonitor("c2", { cooldownMs: 0 })
		m.ingest(taskStart("c2", "code_generation"))
		for (let i = 1; i <= 5; i++) {
			m.ingest(ev("c2", "assistant", i, "code_generation", { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})

	it("★【F9】概念问答下 high_recent_ai_dependency 连提示都不发", () => {
		const m = new BehaviorMonitor("c3", { cooldownMs: 0, escalationBlockingThreshold: 1 })
		m.ingest(taskStart("c3", "explanation"))
		for (let i = 1; i <= 8; i++) {
			m.ingest(ev("c3", "assistant", i, "explanation"))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("high_recent_ai_dependency")
		expect(m.shouldEscalateToBlocking("high_recent_ai_dependency")).to.equal(false)
	})

	it("★ 分类未知时保守启用（不得因分类失败静默失效）", () => {
		const m = new BehaviorMonitor("c4", { cooldownMs: 0 })
		for (let i = 1; i <= 5; i++) {
			m.ingest(ev("c4", "assistant", i, "other", { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})

	it("助手事件的 category 不得被当作学生意图", () => {
		const m = new BehaviorMonitor("c5", { cooldownMs: 0, escalationBlockingThreshold: 2 })
		m.ingest(taskStart("c5", "code_generation"))
		// 助手回合报告 explanation —— 不应改变已经确立的学生意图
		for (let i = 1; i <= 5; i++) {
			m.ingest(ev("c5", "assistant", i, "explanation", { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getTaskCategory()).to.equal("code_generation")
	})
})
