import { expect } from "chai"
import { formatInterventionForInjection } from "../InterventionMessageGenerator"
import type { InterventionMessage } from "../types"

const msg = (over: Partial<InterventionMessage> = {}): InterventionMessage =>
	({
		ruleId: "no_edit_streak",
		severity: "gentle",
		style: "hint",
		content: "你已经连续 8 轮没有代码编辑，建议动手验证或微调一处关键实现。",
		interventionType: "normal",
		generatedAt: new Date().toISOString(),
		cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
		...over,
	}) as InterventionMessage

describe("F6 · 干预注入格式契约", () => {
	it("★ T13 之前不得要求模型产出回执块（显示层还没挂剥离，学生会在正文里看到 XML 残渣）", () => {
		// 回归方向说明：T13 落地 extractInterventionCopy / stripInterventionCopyBlock 之后，
		// 本用例应被**反转**为「必须要求回执块」，并与两条显示路径的剥离用例一起改。
		const t = formatInterventionForInjection(msg())
		expect(t).to.not.include("<teaching_intervention_copy>")
	})

	it("★ 不得再写「让它看起来像你主动给出的建议」这类自由改写软指引", () => {
		const t = formatInterventionForInjection(msg())
		expect(t).to.not.include("看起来像是你主动给出的教学建议")
	})

	it("★ 保留 <teaching_intervention> 外层标签与干预正文（可审计）", () => {
		const t = formatInterventionForInjection(msg())
		expect(t).to.include('<teaching_intervention rule="no_edit_streak"')
		expect(t).to.include("你已经连续 8 轮没有代码编辑")
		expect(t).to.include("</teaching_intervention>")
	})
})
