import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
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

describe("场景 2 — 真实依赖必须仍然干预", () => {
	it("★ 学生连续索要完整代码（起始即 code_generation）→ 触发 consecutive_code_generation", () => {
		const m = new BehaviorMonitor("s2", { cooldownMs: 0 })
		m.ingest({ ...ev("s2", "user", 0, "code_generation"), eventType: "task_start" })
		for (let i = 1; i <= 3; i++) {
			m.ingest(ev("s2", "assistant", i, "code_generation", { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})

	it("★ 连续无编辑（真在写代码的任务）→ 触发 no_edit_streak", () => {
		const m = new BehaviorMonitor("s3", { cooldownMs: 0 })
		m.ingest({ ...ev("s3", "user", 0, "debugging"), eventType: "task_start" })
		for (let i = 1; i <= 8; i++) {
			m.ingest(ev("s3", "assistant", i, "debugging"))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("no_edit_streak")
	})
})

describe("场景 3 — 阻断仍可升级，且时长与文案一致", () => {
	it("★ 代码类任务下累计 6 次触发 → 阻断，冷却为 60s", () => {
		const m = new BehaviorMonitor("s4", { cooldownMs: 0, escalationBlockingThreshold: 6 })
		// 显式抬高单任务限额、并放宽循环轮数：让这个用例只验证“阻断能否升级”，
		// 不因限额/轮数这类无关参数而假失败。
		const mgr = new TeachingInterventionManager("s4", {
			globalCooldownMs: 0,
			blockingCooldownMs: 60_000,
			maxInterventionsPerTask: 30,
		})

		m.ingest({ ...ev("s4", "user", 0, "code_generation"), eventType: "task_start" })

		let blockingText: string | null = null
		let turn = 1
		for (let round = 0; round < 20 && blockingText === null; round++) {
			m.ingest(ev("s4", "assistant", turn++, "code_generation", { hasCode: true, hasCodeBlock: true }))
			const text = mgr.checkAndGenerateIntervention(m, turn)
			if (text && text.includes('interventionType="blocking"')) {
				blockingText = text
			}
		}

		expect(blockingText, "阻断未能在合理轮次内触发").to.not.equal(null)
		expect(blockingText).to.include("冷却倒计时: 1 分钟")
		expect(blockingText).to.not.include("3 分钟")
		expect(mgr.isBlockingActive()).to.equal(true)
		// 剩余时间应在 60s 以内（允许执行耗时）
		expect(mgr.getBlockingEndsAt() - Date.now()).to.be.at.most(60_000)
		expect(mgr.getBlockingEndsAt() - Date.now()).to.be.greaterThan(55_000)
	})
})
