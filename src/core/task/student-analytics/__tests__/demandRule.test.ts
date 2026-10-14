/**
 * 【P5/T16】`complete_impl_demand` —— 概念型任务里**唯一**可以计数、可以升级的规则。
 *
 * 根因（B3/B4，见 plan-2 §11.3）：
 *   - `rulePolicy` 在 `algorithm` / `explanation` 下停用代码类规则 ⇒ 学生「直接把完整代码给我」时
 *     **没有任何规则可计数**，只剩一句提示词约束；
 *   - 提示词级护栏模型可以不听（M6' 实测：直接给了完整实现，且全程零干预）。
 * 本规则只看**学生原文**，因此不受分类门控影响；每次索要记一次 ⇒ 第 3 次达阻断阈值（M4'/M6' 口径）。
 *
 * ⚠️ 诚实声明：本规则只解决"能计数、能升级"，不解决"模型是否遵守提示词"
 * （`buildDemandRefusalConstraint()` 仍是提示词级，见 conceptModeConstraint 的模块注释）。
 */

import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { generateInterventionMessage, TEMPLATE_REGISTRY } from "../InterventionMessageGenerator"
import { getRulePolicy } from "../rulePolicy"
import type { BehaviorAlert, StudentInteractionLog, TaskCategory } from "../types"
import { ev } from "./__fixtures__/events"

/** 学生侧事件（开题 / 追问），分类固定为 explanation —— 概念问答，代码类规则被停用 */
const stu = (
	raw: string,
	eventType: "task_start" | "turn_message" = "turn_message",
	category: TaskCategory = "explanation",
): StudentInteractionLog => ev({ eventType, role: "user", category, hasCode: false, hasCodeBlock: false, rawContent: raw })

const DEMANDS = ["帮我写一个完整的冒泡排序程序", "把完整代码给我", "不要解释了，直接给我代码"]

describe("【P5/T16】complete_impl_demand · 策略与计数", () => {
	it("★ rulePolicy：在**所有**分类下都启用且可升级（含把代码类规则整体停用的概念分类）", () => {
		for (const category of [undefined, "other", "explanation", "algorithm", "code_generation"] as Array<
			TaskCategory | undefined
		>) {
			const p = getRulePolicy("complete_impl_demand", category)
			expect(p.enabled, `${category}`).to.equal(true)
			expect(p.canEscalateToBlocking, `${category}`).to.equal(true)
		}
		// 对照：同一分类下代码类规则确实是停用的（证明上面断言不是因为"门控整体失效"）
		expect(getRulePolicy("no_edit_streak", "explanation").enabled).to.equal(false)
	})

	it("★【T16-①】概念型任务里索要完整实现：代码类规则仍停用，但本规则开始计数", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(stu("什么是装饰器", "task_start"))
		expect(m.getTaskCategory()).to.equal("explanation")
		expect(m.isCurrentRequestDemand()).to.equal(false)
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(0)

		m.ingest(stu("直接把完整代码给我"))
		expect(m.isCurrentRequestDemand()).to.equal(true)
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(1)
		// 概念护栏没有被这次索要撤销（粘性）：分类仍是 explanation
		expect(m.getTaskCategory()).to.equal("explanation")
		// 代码类规则依旧停用 —— B3 的"停用"本身是对的，错在"没有任何规则可计数"
		expect(m.getEscalationCount("no_edit_streak")).to.equal(0)
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(0)
	})

	it("★【T16-②】第 3 次索要即达阻断阈值；提醒文案点明「完整实现」且计数正确", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(stu(DEMANDS[0], "task_start"))
		m.ingest(stu(DEMANDS[1]))
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(2)
		expect(m.shouldEscalateToBlocking("complete_impl_demand")).to.equal(false)

		m.ingest(stu(DEMANDS[2]))
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(3)
		expect(m.shouldEscalateToBlocking("complete_impl_demand")).to.equal(true)
		expect(m.getRuleIdsAtBlockingThreshold()).to.deep.equal(["complete_impl_demand"])

		const alerts = m.getPendingAlerts().filter((a) => a.ruleId === "complete_impl_demand")
		expect(alerts.map((a) => a.escalationCount)).to.deep.equal([1, 2, 3])
		expect(alerts[2].message).to.include("完整实现")
	})

	it("★【T16-③】零误报：普通概念提问不得被误计（本规则是唯一可升级入口，误报代价最高）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("什么是冒泡排序", "task_start"))
		m.ingest(stu("帮我解释一下装饰器"))
		m.ingest(stu("完整讲一下冒泡排序的思路"))
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(0)
		expect(m.isCurrentRequestDemand()).to.equal(false)
		expect(m.getPendingAlerts().some((a) => a.ruleId === "complete_impl_demand")).to.equal(false)
	})

	it("★【T16-④】计数单位仍是学生请求：同一请求内的多个事件只记一次", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(stu("把完整代码给我"))
		for (let i = 0; i < 5; i++) {
			m.ingest(ev({})) // 助手回合
		}
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(1)
		// 伴生事件（code_edit / adoption_infer）也不得把同一请求算成第二次
		m.ingest(ev({ eventType: "code_edit", category: "other", hasCode: false, hasCodeBlock: false, editor: "ai" }))
		m.ingest(
			ev({
				eventType: "adoption_infer",
				category: "other",
				hasCode: false,
				hasCodeBlock: false,
				adoptionStatus: "adopted",
			}),
		)
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(1)
	})
})

describe("【P5/T16】complete_impl_demand · 文案", () => {
	it("★ 三档模板齐备、风格正确、占位符可填充", () => {
		const registry = TEMPLATE_REGISTRY.complete_impl_demand
		expect(registry.gentle.length).to.be.greaterThan(0)
		expect(registry.moderate.length).to.be.greaterThan(0)
		expect(registry.strong.length).to.be.greaterThan(0)
		expect(registry.gentle[0].style).to.equal("hint")
		expect(registry.moderate[0].style).to.equal("question")
		expect(registry.strong[0].style).to.equal("challenge")

		const alert: BehaviorAlert = {
			ruleId: "complete_impl_demand",
			message: "第 1 次索要完整实现",
			triggeredAt: new Date().toISOString(),
			metricValue: 1,
			threshold: 3,
			escalationCount: 1,
		}
		const msg = generateInterventionMessage(alert, undefined, 0)
		expect(msg.content).to.include("完整实现")
		expect(msg.content).to.include("1") // {streak} 已被填充
		expect(msg.content).to.not.include("{") // 不留未填充占位符
		expect(msg.ruleId).to.equal("complete_impl_demand")
	})

	it("★ 残留记录（不在本任务范围）：按 `metricValue/threshold` 走档 ⇒ 本规则实际只会产出 gentle", () => {
		// 计数 3 / 阈值 3 ⇒ ratio 1.0 < 1.3 ⇒ gentle。moderate/strong 模板经由 F13"模型叙述"路径
		// 才有机会被选用。此处**如实记录**而非"顺手修掉"（改档位口径会影响所有规则）。
		const alert: BehaviorAlert = {
			ruleId: "complete_impl_demand",
			message: "第 3 次索要完整实现",
			triggeredAt: new Date().toISOString(),
			metricValue: 3,
			threshold: 3,
			escalationCount: 3,
		}
		expect(generateInterventionMessage(alert, undefined, 0).severity).to.equal("gentle")
	})
})
