/**
 * 【P5/T14 + T19-b】违规计数的单位 —— 一个**学生请求**（不是助手回合）。
 *
 * 为什么单开一份：实测 M4'（task `1791978179978`）里学生**只发了一条消息**，
 * 却因为「每个 `turn_message` 都 +1」而在一轮之内把 `no_edit_streak` 推过阈值并连记 3 次
 * ⇒ 一次提问即被阻断 60 秒（根因 A）。本文件把新口径写成可执行的契约：
 *   ① 一次请求内的 12 个助手回合最多推进 1 格（旧口径会记 3 次违规）；
 *   ② 升级计数按「请求」累加，第 3 次索要完整实现才达阻断阈值（M4' 的预期口径）；
 *   ③ 学生本人编辑代码仍然归零；
 *   ④ 退化口径（从未见过学生回合的离线重放）保留按回合计数，不静默失效。
 *
 * ⚠️ 单位的**语义代价**（有意，已在 §11.6 记录）：`no_edit_streak` 的阈值 3 现在意为
 * "连续 3 次提问没动手 ⇒ 提醒"，其升级计数从**第 3 次提问**开始累加，
 * 因此该规则自身达到阻断阈值需要第 5 次提问；而"第 3 次索要完整实现即阻断"由
 * `complete_impl_demand` 规则承担（它每次索要都记一次，见 T14-②）。
 */

import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import type { StudentInteractionLog } from "../types"
import { editEv, ev } from "./__fixtures__/events"

/** 学生回合（同一请求内的追问） */
const stuTurn = (raw: string, over: Partial<StudentInteractionLog> = {}): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: raw, ...over })

/** 学生开题 */
const taskStart = (raw: string, over: Partial<StudentInteractionLog> = {}): StudentInteractionLog =>
	ev({ eventType: "task_start", role: "user", hasCode: false, hasCodeBlock: false, rawContent: raw, ...over })

/** 助手回合（"每次工具调用一个回合"的形态；默认带 fenced 代码块） */
const aiTurn = (over: Partial<StudentInteractionLog> = {}): StudentInteractionLog => ev(over)

/** 复刻实测形态：学生 1 条消息 + N 个助手回合 */
const request = (m: BehaviorMonitor, first: StudentInteractionLog, aiTurns: number): void => {
	m.ingest(first)
	for (let i = 0; i < aiTurns; i++) {
		m.ingest(aiTurn())
	}
}

describe("【P5/T14】计数单位 = 学生请求", () => {
	it("★【T14-①】一次 12 回合的请求：no_edit_streak 记 0 次、代码生成只记 1 次、AI 依赖不触发", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		request(m, stuTurn("帮我看看这个模块该怎么改"), 12)

		expect(m.getStudentRequestCount()).to.equal(1)
		// 旧口径：12 个回合 ⇒ turnsSinceLastEdit=12 ⇒ 越过阈值后连记 3 次 ⇒ 一次提问即阻断
		expect(m.getEscalationCount("no_edit_streak")).to.equal(0)
		expect(m.getPendingAlerts().some((a) => a.ruleId === "no_edit_streak")).to.equal(false)
		// 新口径：本请求内的助手代码回合再多，也只推进 1 格
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(1)
		// 【T19-b】一次请求内的多回合是 agent 循环的正常形态（每次工具调用一个回合），不构成 AI 依赖
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		// 全任务没有任何规则达到阻断阈值
		expect(m.getRuleIdsAtBlockingThreshold()).to.deep.equal([])

		// 回合数翻倍，仍然只 1 格 —— 单位是"请求"，不是"回合"
		for (let i = 0; i < 12; i++) {
			m.ingest(aiTurn())
		}
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(1)
		expect(m.getEscalationCount("no_edit_streak")).to.equal(0)
	})

	it("★【T14-②】连续 3 次索要完整实现 ⇒ 第 3 次达到阻断阈值（M4' 的预期口径）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })

		request(m, taskStart("帮我写一个完整的冒泡排序程序"), 2)
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(1)
		expect(m.shouldEscalateToBlocking("complete_impl_demand")).to.equal(false)

		request(m, stuTurn("把完整代码给我"), 2)
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(2)
		expect(m.shouldEscalateToBlocking("complete_impl_demand")).to.equal(false)

		request(m, stuTurn("不要解释了，直接给我代码"), 2)
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(3)
		expect(m.shouldEscalateToBlocking("complete_impl_demand")).to.equal(true)
	})

	it("★【T14-③】学生本人编辑代码 ⇒ 未编辑计数归零（对照：不编辑则第 3 次请求起才开始计数）", () => {
		// 对照组：连续 3 次提问都不动手
		const noEdit = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		request(noEdit, stuTurn("第一句"), 1)
		request(noEdit, stuTurn("第二句"), 1)
		expect(noEdit.getEscalationCount("no_edit_streak")).to.equal(0) // 阈值 3 = 连续 3 次请求
		request(noEdit, stuTurn("第三句"), 1)
		expect(noEdit.getEscalationCount("no_edit_streak")).to.equal(1)
		expect(noEdit.getPendingAlerts().some((a) => a.ruleId === "no_edit_streak")).to.equal(true)

		// 实验组：第三次请求之前学生自己改了代码 ⇒ 计数从头开始
		const edited = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		request(edited, stuTurn("第一句"), 1)
		request(edited, stuTurn("第二句"), 1)
		edited.ingest(editEv({ editor: "user" }))
		request(edited, stuTurn("第三句"), 1)
		expect(edited.getEscalationCount("no_edit_streak")).to.equal(0)
		expect(edited.getPendingAlerts().some((a) => a.ruleId === "no_edit_streak")).to.equal(false)
	})

	it("★【T14-④】同请求内 2 个代码回合记 1 次；跨请求各 1 个代码回合记 2 次", () => {
		const sameRequest = new BehaviorMonitor("t1", { cooldownMs: 0 })
		sameRequest.ingest(stuTurn("第一次请求"))
		sameRequest.ingest(aiTurn())
		sameRequest.ingest(aiTurn())
		expect(sameRequest.getEscalationCount("consecutive_code_generation")).to.equal(1)

		const twoRequests = new BehaviorMonitor("t1", { cooldownMs: 0 })
		twoRequests.ingest(stuTurn("第一次请求"))
		twoRequests.ingest(aiTurn())
		twoRequests.ingest(stuTurn("第二次请求"))
		twoRequests.ingest(aiTurn())
		expect(twoRequests.getEscalationCount("consecutive_code_generation")).to.equal(2)
	})

	it("★【T14-⑤】退化口径：从未见过学生回合（离线重放/异常数据）仍按回合计数，不静默失效", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 12; i++) {
			m.ingest(aiTurn())
		}
		expect(m.getStudentRequestCount()).to.equal(0)
		// 与 rulePolicy「分类缺失时全部启用」同一保守原则：宁可多计也不失效（生产路径不会走到这里，
		// 因为每个请求都由一个学生侧事件（task_start / turn_message）开路）。
		// 计数口径：阈值 3 ⇒ 前 2 个回合未达阈值（不计数），其后每个回合各记一次 ⇒ 12-2=10。
		expect(m.getEscalationCount("no_edit_streak")).to.equal(10)
	})

	it("★【T14-⑥】reset() 必须清掉新引入的请求级状态（否则恢复会话后会带着上次的计数）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		request(m, taskStart("帮我写一个完整的冒泡排序程序"), 1)
		expect(m.getStudentRequestCount()).to.equal(1)
		expect(m.isCurrentRequestDemand()).to.equal(true)

		m.reset()
		expect(m.getStudentRequestCount()).to.equal(0)
		expect(m.isCurrentRequestDemand()).to.equal(false)
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(0)
	})
})

describe("【P5/T19-b】AI 依赖规则的作用域 = 跨请求", () => {
	it("★ 单次请求的 8 个助手回合不触发；第 2 次请求后仍持续无参与才记 1 次，且永不阻断", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		request(m, stuTurn("第一句"), 8)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)

		request(m, stuTurn("第二句"), 8)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1) // 每请求至多 1 次

		// F9：本规则的度量单位是"学生未参与的助手回合数"，一次提问天然产生 6~11 个回合 ⇒ 不得升级为阻断
		expect(m.shouldEscalateToBlocking("high_recent_ai_dependency")).to.equal(false)
	})

	it("★ 边界：第 2 次请求后学生有发言/编辑 ⇒ 计数归零，规则不再命中", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		request(m, stuTurn("第一句"), 8)
		request(m, stuTurn("第二句"), 8)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)

		// 学生在后续请求里持续参与 ⇒ 连续无发言的回合数不再累积
		request(m, stuTurn("第三句"), 2)
		m.ingest(editEv({ editor: "user" }))
		request(m, stuTurn("第四句"), 2)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
	})
})
