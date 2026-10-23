/**
 * 场景回归（P2-2 删除阻断后重写）。
 *
 * 保留的仍是“干预确实发生”的端到端回归：真实依赖要出提醒、概念问答不得误触发、
 * 分类翻转后代码类规则重新生效。阻断式干预已删除，因此不再有“升级为阻断”的场景；
 * 相应主题由 noBlocking.test.ts 的「不存在 blocking 能力」断言承担。
 */
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
		// 【P5-A】单位 = 学生请求：连续 3 次**提问**都没动手 ⇒ 命中。
		// （旧写法连造 8 个**助手回合**：那其实是"一次提问内的 8 个回合"，新口径下不再算作 8 轮）
		for (let i = 1; i <= 3; i++) {
			m.ingest(ev("s3", "user", i, "debugging", { hasCode: false, hasCodeBlock: false }))
			m.ingest(ev("s3", "assistant", i, "debugging"))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("no_edit_streak")
	})

	it("★ 真实依赖命中后只产生软提示：决策类型恒为 normal，不阻断后续请求", () => {
		const m = new BehaviorMonitor("s4", { cooldownMs: 0 })
		m.ingest({ ...ev("s4", "user", 0, "code_generation"), eventType: "task_start" })
		for (let i = 1; i <= 3; i++) {
			m.ingest(ev("s4", "assistant", i, "code_generation", { hasCode: true, hasCodeBlock: true }))
		}
		const mgr = new TeachingInterventionManager("s4", { globalCooldownMs: 0 })
		const decision = mgr.checkAndGenerateInterventionDecision(m, 10)
		expect(decision, "真实依赖必须仍然出提示").to.not.equal(null)
		expect(decision?.interventionType).to.equal("normal")
		expect(decision?.severity).to.be.oneOf(["gentle", "moderate", "strong"])
		expect(decision?.injectionText).to.be.a("string")
		expect(decision?.injectionText).to.not.include("阻断")
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

describe("场景 1 — 概念问答不得误触发（原始 bug 的回归）", () => {
	it("★ 概念问答：即使助手连续给出真代码块，也不触发代码类规则", () => {
		const m = new BehaviorMonitor("s1", { cooldownMs: 0 })
		m.ingest({ ...ev("s1", "user", 0, "explanation"), eventType: "task_start" })

		// ★ 前提断言：确认分流真的生效了，而不是 monitor 什么都没做。
		// 否则下面两条 not.include 会“真空通过” —— 这正是 wiki 检索验证脚本踩过的坑。
		expect(m.getTaskCategory()).to.equal("explanation")

		// 刻意用 hasCodeBlock: true（真正的代码块），把 Task 3 的作用排除掉，
		// 让这个用例只验证 Task 4 的“分类分流”是否生效。
		for (let i = 1; i <= 5; i++) {
			m.ingest(ev("s1", "assistant", i, "explanation", { hasCode: true, hasCodeBlock: true }))
		}
		const rules = m.getPendingAlerts().map((a) => a.ruleId)
		expect(rules).to.not.include("consecutive_code_generation")
		expect(rules).to.not.include("no_edit_streak")

		// ★ 反向对照：同一事件形状，仅分类不同 → 必须触发。
		// 无此对照，上面的 not.include 无法区分“分流生效”与“monitor 坏了”。
		const ctrl = new BehaviorMonitor("s1c", { cooldownMs: 0 })
		ctrl.ingest({ ...ev("s1c", "user", 0, "code_generation"), eventType: "task_start" })
		for (let i = 1; i <= 5; i++) {
			ctrl.ingest(ev("s1c", "assistant", i, "code_generation", { hasCode: true, hasCodeBlock: true }))
		}
		expect(ctrl.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})
})
