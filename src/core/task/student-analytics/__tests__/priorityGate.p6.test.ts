/**
 * G6 · P6 优先级综合（L2 层）—— ai_coding_rounds 计数通道 / 依赖度加权 / 学生编辑清零
 *
 * 覆盖 plan-2 §0 的四类检查（正常路径 / 边界 / 回归 / 可跑通），并对应两轮实测的失败点：
 *  M4''：只有助手**真实落盘**才计入 ai_coding_rounds（旧：学生索要即阻断）
 *  M15'：学生本人编辑 ⇒ 计数清零
 *  M16'：重复概念提问 ⇒ 出现提示（旧：零提示）；单次仍零提示
 *
 * 【P2-2】阻断式干预已删除：落盘/完整实现只驱动计数与软提示，不存在阻断态。
 */
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import type { StudentInteractionLog, TaskCategory } from "../types"
import { editEv, ev } from "./__fixtures__/events"

const runtimeProp = (obj: object, key: string): unknown => (obj as unknown as Record<string, unknown>)[key]

const stu = (raw: string, category: TaskCategory = "code_generation"): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", category, hasCode: false, hasCodeBlock: false, rawContent: raw })
const aiWrite = (): StudentInteractionLog => editEv({ editor: "ai" })

describe("G6 · P6（ai_coding_rounds 计数通道 / 依赖度加权 / 学生编辑清零）", () => {
	it("【G6-①】M4''：只讲解不落盘 ⇒ ai_coding_rounds 恒 0、无阻断；真实落盘 3 次 ⇒ 计数 3 且只产生软提示", () => {
		const mgr = new TeachingInterventionManager("t1", { globalCooldownMs: 0 })
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })

		// 3 个请求，助手只讲解（老口径会在此处阻断）
		for (let i = 0; i < 3; i++) {
			m.ingest(stu(`第 ${i + 1} 次：帮我写完整的冒泡排序程序`))
			m.ingest(ev({ hasCodeBlock: false, hasCode: false }))
			expect(m.getAiCodingCount()).to.equal(0)
		}
		// 允许出现普通提示（依赖度/no_edit_streak），但不得是阻断文案、不得进入阻断态
		const noBlockText = mgr.checkAndGenerateIntervention(m, 1)
		expect(noBlockText ?? "").to.not.include("阻断模式")
		expect(runtimeProp(mgr, "isBlockingActive")).to.equal(undefined)

		// 助手真实落盘 3 次 ⇒ 计数 3，软提示
		for (let i = 0; i < 3; i++) {
			m.ingest(stu(`第 ${i + 1} 次：请直接写进文件`))
			m.ingest(aiWrite())
		}
		expect(m.getAiCodingCount()).to.equal(3)
		const text = mgr.checkAndGenerateIntervention(m, 4)
		expect(text).to.be.a("string").and.to.not.be.empty
		expect(text).to.not.include("阻断模式")
		expect(runtimeProp(mgr, "isBlockingActive")).to.equal(undefined)
	})

	it("【G6-②】M15' 学生本人编辑 ⇒ 计数清零（不清零则会累积到误报）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第一次"))
		m.ingest(aiWrite())
		m.ingest(stu("第二次"))
		m.ingest(aiWrite())
		m.ingest(editEv({ editor: "user" }))
		m.ingest(stu("第三次"))
		m.ingest(aiWrite())
		expect(m.getAiCodingCount()).to.equal(1)
		expect(runtimeProp(m, "shouldEscalateToBlocking")).to.equal(undefined)
	})

	it("【G6-③】M16' 重复概念提问 ⇒ 提示；单次 ⇒ 零提示（保住 M1'）", () => {
		const once = new BehaviorMonitor("t1", { cooldownMs: 0 })
		once.ingest(stu("什么是冒泡排序", "algorithm"))
		expect(once.getPendingAlerts()).to.have.length(0)

		const many = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 6; i++) {
			many.ingest(stu(`第 ${i + 1} 个概念问题`, "explanation"))
		}
		const alerts = many.getPendingAlerts().filter((a) => a.ruleId === "high_recent_ai_dependency")
		expect(alerts).to.have.length(1)
		expect(many.getWeightedDependencyScore()).to.equal(3)
		expect(many.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
		// 阻断阈值这一类可注入/可观察接口已删除
		expect(runtimeProp(many, "getBlockingThresholdFor")).to.equal(undefined)
	})
})
