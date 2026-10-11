import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { refineStudentCategory } from "../RequestIntentRefiner"
import { getRulePolicy } from "../rulePolicy"
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

describe("场景 5 — 概念问答的反馈回路（方案 C-2 + C-3）", () => {
	it("★ 拿到关键实现后持续索要完整代码 → 分类翻转 → 代码类规则重新生效", () => {
		// ① 起始：概念提问
		const base: TaskCategory = "explanation"
		let hasDeliveredKeyCode = false

		// ② 助手给出关键实现（fenced 代码块）
		hasDeliveredKeyCode = true

		// ③ 学生索要完整代码 → 翻转
		const flipped = refineStudentCategory("直接把完整的冒泡排序代码给我", base, hasDeliveredKeyCode)
		expect(flipped).to.equal("code_generation")

		// ④ 翻转后，代码类规则重新可用
		expect(getRulePolicy("consecutive_code_generation", flipped).enabled).to.equal(true)
		expect(getRulePolicy("consecutive_code_generation", base).enabled).to.equal(false)

		// ⑤ 并且真的会被 monitor 触发
		const m = new BehaviorMonitor("loop1", { cooldownMs: 0 })
		m.ingest({ ...ev("loop1", "user", 0, flipped), eventType: "task_start" })
		for (let i = 1; i <= 3; i++) {
			m.ingest(ev("loop1", "assistant", i, flipped, { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})

	it("★ 未给出关键实现时不翻转（不得过早放弃讲解）", () => {
		const c = refineStudentCategory("直接把完整的冒泡排序代码给我", "explanation", false)
		expect(c).to.equal("explanation")
		expect(getRulePolicy("consecutive_code_generation", c).enabled).to.equal(false)
	})
})
