/**
 * G6 · P6 优先级综合（L2 层）—— 独立阻断通道 / 依赖度加权 / 展示去噪
 *
 * 覆盖 plan-2 §0 的四类检查（正常路径 / 边界 / 回归 / 可跑通），并对应两轮实测的失败点：
 *  M4''：只有助手**真实落盘** 3 次才阻断（旧：学生索要 3 次即阻断，实测第 1 次就阻断）
 *  M15'：学生本人编辑 ⇒ 阻断计数清零
 *  M16'：重复概念提问 ⇒ 出现提示（旧：零提示）；单次仍零提示
 *  M17'：阻断文案对学生脱敏；同一条学生消息只展示/记账一次
 *
 * ⚠️ 诚实声明：④ 是**结构守卫（变更探测器）**，不是端到端验证。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { after, beforeEach } from "mocha"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import type { StudentInteractionLog, TaskCategory } from "../types"
import { editEv, ev } from "./__fixtures__/events"

const managerStaticState = TeachingInterventionManager as unknown as {
	globalBlockingEndsAt: number
	globalLastBlockingIntervention: unknown
}
const savedEndsAt = managerStaticState.globalBlockingEndsAt
const savedLast = managerStaticState.globalLastBlockingIntervention

const stu = (raw: string, category: TaskCategory = "code_generation"): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", category, hasCode: false, hasCodeBlock: false, rawContent: raw })
const aiWrite = (): StudentInteractionLog => editEv({ editor: "ai" })
const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")

describe("G6 · P6（独立阻断通道 / 依赖度加权 / 展示去噪）", () => {
	beforeEach(() => {
		managerStaticState.globalBlockingEndsAt = 0
		managerStaticState.globalLastBlockingIntervention = null
	})

	it("【G6-①】M4''：助手真实落盘 3 次才阻断；只讲解不落盘 ⇒ 永不阻断", () => {
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })

		// 3 个请求，助手只讲解（老口径会在此处阻断）
		for (let i = 0; i < 3; i++) {
			m.ingest(stu(`第 ${i + 1} 次：帮我写完整的冒泡排序程序`))
			m.ingest(ev({ hasCodeBlock: false, hasCode: false }))
			expect(m.getAiCodingCount()).to.equal(0)
		}
		// 永不阻断：允许出现普通提示（依赖度/no_edit_streak），但不得是阻断文案、不得进入阻断态
		const noBlockText = mgr.checkAndGenerateIntervention(m, 1)
		expect(noBlockText ?? "").to.not.include("阻断模式")
		expect(mgr.isBlockingActive()).to.equal(false)

		// 助手真实落盘 3 次 ⇒ 阻断
		for (let i = 0; i < 3; i++) {
			m.ingest(stu(`第 ${i + 1} 次：请直接写进文件`))
			m.ingest(aiWrite())
		}
		expect(m.getAiCodingCount()).to.equal(3)
		const text = mgr.checkAndGenerateIntervention(m, 4)
		expect(text).to.be.a("string").and.to.include("阻断模式")
		expect(mgr.isBlockingActive()).to.equal(true)
	})

	it("【G6-②】M15' 学生本人编辑 ⇒ 计数清零（不清零则 3 次后误阻断）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第一次"))
		m.ingest(aiWrite())
		m.ingest(stu("第二次"))
		m.ingest(aiWrite())
		m.ingest(editEv({ editor: "user" }))
		m.ingest(stu("第三次"))
		m.ingest(aiWrite())
		expect(m.getAiCodingCount()).to.equal(1)
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(false)
	})

	it("【G6-③】M16' 重复概念提问 ⇒ 提示；单次 ⇒ 零提示（保住 M1'）", () => {
		const once = new BehaviorMonitor("t1", { cooldownMs: 0 })
		once.ingest(stu("什么是冒泡排序", "algorithm"))
		expect(once.getPendingAlerts()).to.have.length(0)

		// 阻断阈值压到 1：命中 1 次即「计数达标」，使「不阻断」只能由白名单解释（否则此处是恒真断言）
		const many = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 1 })
		for (let i = 0; i < 6; i++) {
			many.ingest(stu(`第 ${i + 1} 个概念问题`, "explanation"))
		}
		const alerts = many.getPendingAlerts().filter((a) => a.ruleId === "high_recent_ai_dependency")
		expect(alerts).to.have.length(1)
		expect(many.getWeightedDependencyScore()).to.equal(3)
		expect(many.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
		expect(many.getBlockingThresholdFor("high_recent_ai_dependency")).to.equal(1)
		expect(many.shouldEscalateToBlocking("high_recent_ai_dependency")).to.equal(false)
	})

	it("【G6-④】结构守卫（变更探测器）：脱敏、幂等、唯一阻断入口", () => {
		expect(taskSrc).to.include("toStudentVisibleBlockingText(")
		expect(taskSrc).to.include("blockingNoticeRequestKey")
		expect(taskSrc).to.not.include("const needDecision = !carryOverHint")
		expect(/BLOCKING_CAPABLE_RULES/.test(fs.readFileSync(path.join(__dirname, "..", "rulePolicy.ts"), "utf-8"))).to.equal(
			true,
		)
	})

	after(() => {
		managerStaticState.globalBlockingEndsAt = savedEndsAt
		managerStaticState.globalLastBlockingIntervention = savedLast
	})
})
