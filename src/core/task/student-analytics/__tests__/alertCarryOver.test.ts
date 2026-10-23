/**
 * 【P7/T4（裁定 3）】未展示的警报**顺延**，不再被静默丢弃。
 *
 * 实测依据（2026-10-18，taskId=1792299354229）：第 4 个学生请求时加权依赖度已达 4.0（阈值 3），
 * `high_recent_ai_dependency` 确实入队了，但同一轮 `no_edit_streak` 优先级更高 ——
 * 旧实现 `consumePendingAlerts()` 先把整队取走再只展示一条 ⇒ 依赖度提示**永久消失**，
 * 此后 120s 规则冷却使它再也无法入队（整轮 7 个请求里一次都没出现）。
 *
 * 判据（M19'）：两条规则同时达标 ⇒ 第一次只展示 1 条，**下一次**展示另一条。
 */
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import type { StudentInteractionLog } from "../types"
import { ev } from "./__fixtures__/events"

const stu = (raw: string): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: raw })
const assistantCodeTurn = (): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "assistant", hasCode: true, hasCodeBlock: true })
const runtimeProp = (obj: object, key: string): unknown => (obj as unknown as Record<string, unknown>)[key]

/** 造出「两条规则各一条警报同时在队」的局面：`no_edit_streak` + `consecutive_code_generation` */
const twoAlertsPending = (): BehaviorMonitor => {
	// 用 120s 规则冷却，否则同一条规则会在每个后续回合重复入队（本用例关心的是"两条规则"，不是"多条重复"）
	const m = new BehaviorMonitor("t1", { cooldownMs: 120_000 })
	m.ingest(stu("第 1 次"))
	m.ingest(assistantCodeTurn())
	m.ingest(stu("第 2 次"))
	m.ingest(assistantCodeTurn())
	m.ingest(stu("第 3 次")) // turnsSinceLastEdit = 3 ⇒ no_edit_streak 入队
	m.ingest(assistantCodeTurn()) // assistantCodeStreak = 3 ⇒ consecutive_code_generation 入队
	return m
}

describe("【P7/T4】警报顺延（裁定 3）", () => {
	it("★ 前提：两条规则确实同时在队（否则下面的断言是恒真的）", () => {
		const m = twoAlertsPending()
		const ruleIds = m.getPendingAlerts().map((a) => a.ruleId)
		expect(ruleIds).to.include("no_edit_streak")
		expect(ruleIds).to.include("consecutive_code_generation")
		expect(new Set(ruleIds).size).to.be.greaterThan(1)
	})

	it("★ 每次只展示一条，且被挤掉的规则最终仍会展示（不再丢失）", () => {
		const m = twoAlertsPending()
		const mgr = new TeachingInterventionManager("t1", { globalCooldownMs: 0 })
		const initial = m.getPendingAlerts().length
		expect(initial).to.be.greaterThan(1)

		const seen = new Set<string>()
		for (let turn = 1; turn <= initial; turn++) {
			const decision = mgr.checkAndGenerateInterventionDecision(m, turn)
			expect(decision, `第 ${turn} 次调用应当有可展示的警报`).to.not.equal(null)
			if (decision) {
				seen.add(decision.ruleId)
			}
			// 每次只消费一条：剩余 = initial - turn
			expect(m.getPendingAlerts()).to.have.length(initial - turn)
		}

		// 核心：被更高优先级挤掉的规则**没有被丢弃**
		expect(seen.has("no_edit_streak")).to.equal(true)
		expect(seen.has("consecutive_code_generation")).to.equal(true)
		expect(mgr.checkAndGenerateInterventionDecision(m, initial + 1)).to.equal(null)
	})

	it("★ 陈旧警报被丢弃（最多顺延 1 个学生请求）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 120_000 })
		m.ingest(stu("第 1 次"))
		m.ingest(assistantCodeTurn())
		m.ingest(assistantCodeTurn())
		m.ingest(assistantCodeTurn()) // 本请求内 consecutive_code_generation 入队（studentRequest = 1）

		const before = [...m.getPendingAlerts()]
		expect(before.length).to.be.greaterThan(0)
		expect(
			before.every((a) => a.studentRequest === 1),
			"第 1 个请求产生的警报应带序号 1",
		).to.equal(true)

		// 学生又问了两次，期间一次展示机会都没有 ⇒ 第 1 个请求的那批提示已经不合语境
		m.ingest(stu("第 2 次"))
		m.ingest(stu("第 3 次"))

		const dropped = m.dropStaleAlerts()
		expect(dropped).to.have.length(before.length)
		// 剩下的只可能是本轮新产生的（序号 ≥ 2）
		expect(m.getPendingAlerts().every((a) => (a.studentRequest ?? 0) >= 2)).to.equal(true)
	})

	it("★ dropAlert 只移除传入的那一条；未知警报返回 false", () => {
		const m = twoAlertsPending()
		const initial = m.getPendingAlerts().length
		const [first] = m.getPendingAlerts()
		expect(m.dropAlert(first)).to.equal(true)
		expect(m.getPendingAlerts()).to.have.length(initial - 1)
		expect(m.dropAlert(first)).to.equal(false) // 已经移除过
	})

	it("★ 决策只消费当前这条警报，不会整队清空（不存在阻断式清队分支）", () => {
		const m = twoAlertsPending()
		const mgr = new TeachingInterventionManager("t1", { globalCooldownMs: 0 })
		const initial = m.getPendingAlerts().length

		const decision = mgr.checkAndGenerateInterventionDecision(m, 10)
		expect(decision, "仍有可展示的警报").to.not.equal(null)
		// 软提示：决策类型恒为 normal，不存在阻断态
		expect(decision?.interventionType).to.equal("normal")
		expect(runtimeProp(mgr, "isBlockingActive")).to.equal(undefined)
		// 只消费一条：其余警报仍留在队列里（旧实现会整队 consume）
		expect(m.getPendingAlerts()).to.have.length(initial - 1)
	})
})
