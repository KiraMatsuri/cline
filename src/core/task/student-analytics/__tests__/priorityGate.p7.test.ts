/**
 * G7 · P7 判据门禁（L2 层）—— 代写信号 / 无法理解识别 / 警报顺延
 *
 * 对应 2026-10-18 F5 实测暴露的三处问题，以及用户三项裁定的落地形态：
 *  M4''（新口径）：助手**代写** 3 次 ⇒ 计数到 3 并产生软提示（阻断能力已删除，【P2-2】）
 *  M18'：填空模板 / 伪代码骨架 ⇒ **不**计入代写（防误判）
 *  M6'' 入口：「我还是无法理解」这类自然说法必须触发 b+c 询问
 *  M19'：两条规则同时达标 ⇒ 分两次展示，不再丢失
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import type { StudentInteractionLog } from "../types"
import { ev } from "./__fixtures__/events"

const runtimeProp = (obj: object, key: string): unknown => (obj as unknown as Record<string, unknown>)[key]

const stu = (raw: string): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: raw })
/** 助手给出了可直接运行的完整实现（P7/T2 判定为 true 的那种回合） */
const fullImplTurn = (): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "assistant", hasCode: true, hasCodeBlock: true, hasFullImpl: true })
/** 骨架 / 填空模板 / 伪代码：有代码块但不可运行 */
const skeletonTurn = (): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "assistant", hasCode: true, hasCodeBlock: true, hasFullImpl: false })
const assistantCodeTurn = (): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "assistant", hasCode: true, hasCodeBlock: true })

describe("G7 · P7（代写信号 / 无法理解 / 警报顺延）", () => {
	it("【G7-①】M4''：代写 3 次（此处为「给出完整实现」）⇒ 计数到 3，只产生软提示", () => {
		const mgr = new TeachingInterventionManager("t1", { globalCooldownMs: 0 })
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })

		for (let i = 0; i < 2; i++) {
			m.ingest(stu(`第 ${i + 1} 次：直接给我完整代码`))
			m.ingest(fullImplTurn())
		}
		expect(m.getAiCodingCount()).to.equal(2)
		expect(mgr.checkAndGenerateIntervention(m, 1) ?? "").to.not.include("阻断模式")
		expect(runtimeProp(mgr, "isBlockingActive")).to.equal(undefined)

		m.ingest(stu("第 3 次：直接给我完整代码"))
		m.ingest(fullImplTurn())
		expect(m.getAiCodingCount()).to.equal(3)
		const text = mgr.checkAndGenerateIntervention(m, 2)
		expect(text).to.be.a("string").and.to.not.be.empty
		expect(text).to.not.include("阻断模式")
	})

	it("【G7-②】M18'：填空模板 / 骨架 3 次 ⇒ 不计入代写（防误判），也不产生阻断", () => {
		const mgr = new TeachingInterventionManager("t1", { globalCooldownMs: 0 })
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m.ingest(stu(`第 ${i + 1} 次：直接给我完整代码`))
			m.ingest(skeletonTurn())
		}
		expect(m.getAiCodingCount()).to.equal(0)
		expect(mgr.checkAndGenerateIntervention(m, 1) ?? "").to.not.include("阻断模式")
		expect(runtimeProp(mgr, "isBlockingActive")).to.equal(undefined)
	})

	it("【G7-③】M6'' 入口：自然说法「我还是无法理解」即进入 b+c 询问条件", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		// 实测原句（旧实现漏的就是它）
		m.ingest(stu("即使这样我还是无法理解，直接把完整代码给我"))
		expect(m.isCurrentRequestInability()).to.equal(true)
		expect(m.getDemandComplianceState()).to.equal("none") // 询问入口的前置条件

		// 反向对照：同一会话里紧接着的一句"已经理解了"不得被当成写不出来
		const m2 = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m2.ingest(stu("我已经理解了核心原理，但我需要你帮我编写完整程序"))
		expect(m2.isCurrentRequestInability()).to.equal(false)

		// 确认后进入服从态（供 index.ts 注入服从约束）
		m.markDemandComplianceAsked()
		m.markDemandComplianceGranted()
		expect(m.getDemandComplianceState()).to.equal("granted")
	})

	it("【G7-④】M19'：两条规则同时达标 ⇒ 分两次展示，被挤掉的那条不丢失", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 120_000 })
		m.ingest(stu("第 1 次"))
		m.ingest(assistantCodeTurn())
		m.ingest(stu("第 2 次"))
		m.ingest(assistantCodeTurn())
		m.ingest(stu("第 3 次"))
		m.ingest(assistantCodeTurn())
		const initial = m.getPendingAlerts().length
		expect(initial).to.be.greaterThan(1)

		const mgr = new TeachingInterventionManager("t1", { globalCooldownMs: 0 })
		const shown: string[] = []
		for (let turn = 1; turn <= initial; turn++) {
			const d = mgr.checkAndGenerateInterventionDecision(m, turn)
			expect(d).to.not.equal(null)
			if (d) {
				shown.push(d.ruleId)
			}
		}
		expect(new Set(shown).size).to.be.greaterThan(1) // 两条不同规则都展示了
		expect(m.getPendingAlerts()).to.have.length(0)
	})

	it("【G7-⑤】结构守卫（变更探测器）：信号真的写进日志，管理器不再整队消费", () => {
		// ⚠️ 诚实声明：这是**变更探测器**，不是端到端验证（Task 实例无法在单测里构造）。
		// 它只防"改别处时把这两条通路悄悄删掉"这类回归。
		const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")
		expect(taskSrc).to.include("hasFullImpl: analysis.hasFullImpl")

		const managerSrc = fs.readFileSync(path.join(__dirname, "..", "TeachingInterventionManager.ts"), "utf-8")
		expect(managerSrc).to.include("monitor.dropAlert(priorityAlert)")
		expect(managerSrc).to.not.include("const alerts = monitor.consumePendingAlerts()")
	})
})
