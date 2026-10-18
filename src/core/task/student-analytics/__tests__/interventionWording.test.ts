/**
 * 【P7/T5】文案与约束的「说到做到」校验（附议 1 + 附议 2）。
 *
 * 附议 1 的由来：2026-10-18 实测里学生只发了 2 条消息，干预文案却说「我刚才**连续 3 轮**给出的内容里
 * 都带了代码」—— `{streak}` 是**助手回合**数，而升级计数单位是**学生请求**，两个口径混在一句话里。
 * 附议 2 的由来：模型给了填空模板并把三个空全部填好，形式上拒答、实质上等于给了完整实现。
 */
import { expect } from "chai"
import { buildDemandRefusalConstraint } from "@/core/teaching/conceptModeConstraint"
import { generateInterventionMessage, TEMPLATE_REGISTRY } from "../InterventionMessageGenerator"
import type { BehaviorAlert } from "../types"

const alert = (over: Partial<BehaviorAlert> = {}): BehaviorAlert => ({
	ruleId: "consecutive_code_generation",
	message: "",
	triggeredAt: new Date().toISOString(),
	metricValue: 3,
	threshold: 3,
	escalationCount: 1,
	...over,
})

describe("【P7/T5】consecutive_code_generation 文案口径", () => {
	it("★ 不再出现「连续 {streak} 轮」这种把助手回合说成学生轮次的说法", () => {
		const groups = TEMPLATE_REGISTRY.consecutive_code_generation
		for (const severity of ["gentle", "moderate", "strong"] as const) {
			for (const template of groups[severity]) {
				expect(template.template, `${severity}/${template.style}`).to.not.include("连续 {streak} 轮")
			}
		}
	})

	it("★ {count} 用**学生请求**口径（escalationCount），不与 {streak} 混用", () => {
		// `preferredStyle: "hint"` + gentle 只有一个候选 ⇒ 结果确定，不依赖随机
		const original = Math.random
		Math.random = () => 0
		try {
			const msg = generateInterventionMessage(alert({ metricValue: 3, escalationCount: 1 }), "hint")
			expect(msg.severity).to.equal("gentle")
			expect(msg.content).to.include("已记录 1 次")
			expect(msg.content).to.not.include("{count}")
			expect(msg.content).to.not.include("{streak}")
		} finally {
			Math.random = original
		}
	})
})

describe("【P7/T5】拒答约束：骨架与答案二选一（附议 2）", () => {
	it("★ 明确禁止「给了骨架又给出各处答案」", () => {
		const text = buildDemandRefusalConstraint()
		expect(text).to.include("不要再给出各处的具体取值")
		// 编号仍然连续（1..5），避免新增条目时把后面的序号弄乱
		for (const n of [1, 2, 3, 4, 5]) {
			expect(text).to.include(`${n}. `)
		}
	})
})
