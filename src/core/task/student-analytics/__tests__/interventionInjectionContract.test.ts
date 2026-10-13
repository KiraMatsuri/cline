import { expect } from "chai"
import { SEVERITY_VOICE } from "../InterventionCopyContract"
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
	it("★ T13 已落地回执契约：**必须**要求模型产出回执块（两条展示路径已挂剥离）", () => {
		// 回归方向说明：T6 期间因「剥离层还没落地」而守护 `to.not.include(...)`，
		// 注释里已写明「T13 落地 extractInterventionCopy 之后必须反转」。T13 同时落地了
		// 回执契约、校验降级与两条展示路径的剥离，因此此处**反转**为必须包含。
		const t = formatInterventionForInjection(msg())
		expect(t).to.include("<teaching_intervention_copy")
		expect(t).to.include("</teaching_intervention_copy>")
		expect(t).to.include("正文") // 块必须写在正文（工具参数不计入 M9' 的 C）
	})

	it("★ 任务书要素经 formatInterventionForInjection 原样透传（力度档原文 / 三要素 / 去重指令）", () => {
		const t = formatInterventionForInjection(msg(), ["旧文案一"])
		expect(t).to.include(SEVERITY_VOICE.gentle)
		expect(t).to.include("观察")
		expect(t).to.include("锚定当前主题")
		expect(t).to.include("留白")
		expect(t).to.include("换一种说法")
		expect(t).to.include("旧文案一")
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
