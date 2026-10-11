import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import type { StudentInteractionLog } from "../types"

const turn = (
	taskId: string,
	role: "user" | "assistant",
	idx: number,
	extra: Partial<StudentInteractionLog> = {},
): StudentInteractionLog => ({
	ts: new Date().toISOString(),
	taskId,
	eventType: "turn_message",
	role,
	category: "explanation",
	contentLength: 10,
	hasCode: false,
	languageHint: "python",
	imageCount: 0,
	fileCount: 0,
	turnIndex: idx,
	...extra,
})

// 关掉规则级冷却，让每次 ingest 都立刻评估规则
describe("BehaviorMonitor — assistantCodeStreak 只认 fenced 代码块（方案 A）", () => {
	it("★ 仅行内代码的助手回合不得推高 streak", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 1; i <= 5; i++) {
			m.ingest(turn("t1", "assistant", i, { hasCode: true, hasCodeBlock: false }))
		}
		// 阈值 3；若仍按 hasCode 计数会触发 consecutive_code_generation
		expect(m.getPendingAlerts().some((a) => a.ruleId === "consecutive_code_generation")).to.equal(false)
	})

	it("★ 含 fenced 代码块的助手回合仍然推高 streak（真实信号不得丢）", () => {
		const m = new BehaviorMonitor("t2", { cooldownMs: 0 })
		for (let i = 1; i <= 3; i++) {
			m.ingest(turn("t2", "assistant", i, { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getPendingAlerts().some((a) => a.ruleId === "consecutive_code_generation")).to.equal(true)
	})

	it("缺少 hasCodeBlock 的旧事件回退到 hasCode（兼容）", () => {
		const m = new BehaviorMonitor("t3", { cooldownMs: 0 })
		for (let i = 1; i <= 3; i++) {
			m.ingest(turn("t3", "assistant", i, { hasCode: true }))
		}
		expect(m.getPendingAlerts().some((a) => a.ruleId === "consecutive_code_generation")).to.equal(true)
	})
})
