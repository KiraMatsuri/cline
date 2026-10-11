import { expect } from "chai"
import { generateInterventionMessage, TEMPLATE_REGISTRY } from "../InterventionMessageGenerator"

describe("干预文案与指标对齐（方案 E）", () => {
	const SEVERITIES = ["gentle", "moderate", "strong"] as const

	// 直接扫描模板注册表，而不是靠 generateInterventionMessage 的随机选档 ——
	// 后者可能只抽到某一档，留下未检查的模板；而那些模板同样会被真实触发。
	it("★ consecutive_code_generation 的全部模板都不得指控学生'请求代码生成'", () => {
		for (const severity of SEVERITIES) {
			for (const t of TEMPLATE_REGISTRY.consecutive_code_generation[severity]) {
				expect(t.template, `${severity}/${t.style}`).to.not.include("请求代码生成")
				expect(t.template, `${severity}/${t.style}`).to.not.include("让我生成代码")
				expect(t.template, `${severity}/${t.style}`).to.not.include("你已经连续请求")
			}
		}
	})

	it("★ no_edit_streak 的全部模板不得写成'你没有编辑代码'的指控", () => {
		for (const severity of SEVERITIES) {
			for (const t of TEMPLATE_REGISTRY.no_edit_streak[severity]) {
				expect(t.template, `${severity}/${t.style}`).to.not.include("没有编辑代码")
			}
		}
	})

	it("★ 文案仍须保留可操作的引导（不得为了改口径把建议删空）", () => {
		for (const severity of SEVERITIES) {
			for (const t of TEMPLATE_REGISTRY.consecutive_code_generation[severity]) {
				expect(t.template.length, `${severity}/${t.style}`).to.be.greaterThan(30)
			}
		}
	})

	it("generateInterventionMessage 仍能正常产出（冒烟）", () => {
		const msg = generateInterventionMessage(
			{
				ruleId: "consecutive_code_generation",
				message: "x",
				triggeredAt: new Date().toISOString(),
				metricValue: 3,
				threshold: 3,
			},
			"hint",
			5_000,
		)
		expect(msg.content.length).to.be.greaterThan(30)
		expect(msg.ruleId).to.equal("consecutive_code_generation")
	})
})
