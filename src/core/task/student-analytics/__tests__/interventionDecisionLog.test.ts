import { expect } from "chai"
import { resolveInterventionCopyForDisplay } from "../interventionDisplay"

/**
 * 【F13】M9' 的**可数性**：文案展示决策的四分支表。
 *
 * 它是纯函数（`interventionDisplay.ts`），因此可以脱离 Task/vscode 直接断言 ——
 * M9' 的三条守恒式全部建立在这四个分支的记账正确性上：
 *   ① found+ok            → `copy_accepted`（计入 C）
 *   ② found+校验不过       → `copy_rejected` + reasons（计入 T）
 *   ③ !found+本轮有注入    → `copy_rejected` + ["block_missing"]（计入 T，**不得**与 N 混算）
 *   ④ !found+无注入+像提示 → `hint_without_injection`（计入 N）
 *   ⑤ !found+无注入+不像   → 不落事件
 */
describe("F13 · 文案展示决策（M9' 记账）", () => {
	it("① found + 校验通过 → 展示模型文案，记 copy_accepted / voice=model", () => {
		const r = resolveInterventionCopyForDisplay({
			found: { rule: "no_edit_streak", severity: "gentle", copy: "我刚刚给了实现。你先动手写第一版？" },
			body: "",
			lastInjectionTemplate: "模板兜底文案",
			recentTexts: "",
		})
		expect(r.text).to.equal("我刚刚给了实现。你先动手写第一版？")
		expect(r.event?.copyVoice).to.equal("model")
		expect(r.event?.copyDecision).to.equal("copy_accepted")
		expect(r.event?.copyReasons).to.deep.equal([])
		expect(r.event?.eventType).to.equal("intervention_copy")
	})

	it("② found + 校验不过 → 降级模板文案，记 copy_rejected + reasons / voice=template", () => {
		const tooLong = "啊".repeat(130)
		const r = resolveInterventionCopyForDisplay({
			found: { rule: "no_edit_streak", severity: "gentle", copy: tooLong },
			body: "",
			lastInjectionTemplate: "模板兜底文案",
			recentTexts: "",
		})
		expect(r.text).to.equal("模板兜底文案")
		expect(r.event?.copyVoice).to.equal("template")
		expect(r.event?.copyDecision).to.equal("copy_rejected")
		expect(r.event?.copyReasons).to.include("too_long")
	})

	it("②' found + 校验不过 + **无**模板兜底 → 不附加文案，但仍记 copy_rejected", () => {
		const r = resolveInterventionCopyForDisplay({
			found: { rule: "no_edit_streak", severity: "gentle", copy: "啊".repeat(130) },
			body: "",
			lastInjectionTemplate: undefined,
			recentTexts: "",
		})
		expect(r.text).to.equal(undefined)
		expect(r.event?.copyDecision).to.equal("copy_rejected")
		expect(r.event?.copyReasons).to.include("too_long")
	})

	it("③ **缺块** + 本轮有注入 → 模板兜底照常展示，记 copy_rejected + [block_missing]（干预一次都不丢）", () => {
		const r = resolveInterventionCopyForDisplay({
			found: null,
			body: "这是模型正常的回答正文。",
			lastInjectionTemplate: "模板兜底文案",
			recentTexts: "",
		})
		expect(r.text).to.equal("模板兜底文案")
		expect(r.event?.copyVoice).to.equal("template")
		expect(r.event?.copyDecision).to.equal("copy_rejected")
		expect(r.event?.copyReasons).to.deep.equal(["block_missing"])
	})

	it("④ 缺块 + 无注入 + 正文像提示语（💡 开头）→ 不附加，只记账 hint_without_injection", () => {
		const r = resolveInterventionCopyForDisplay({
			found: null,
			body: "💡 学习提示：这几轮基本都是我在说。",
			lastInjectionTemplate: undefined,
			recentTexts: "",
		})
		expect(r.text).to.equal(undefined)
		expect(r.event?.copyDecision).to.equal("hint_without_injection")
		expect(r.event?.copyReasons).to.deep.equal(["no_injection_active"])
		expect(r.event?.copyVoice).to.equal(undefined)
	})

	it("④' 缺块 + 无注入 + 正文命中关键词 → 同样只记账（不与 block_missing 混算）", () => {
		const r = resolveInterventionCopyForDisplay({
			found: null,
			body: "独立编码提示：先自己动手写一版。",
			lastInjectionTemplate: undefined,
			recentTexts: "",
		})
		expect(r.event?.copyDecision).to.equal("hint_without_injection")
	})

	it("⑤ 缺块 + 无注入 + 不像提示语 → 不附加、不落事件", () => {
		const r = resolveInterventionCopyForDisplay({
			found: null,
			body: "下面是插入排序的实现说明。",
			lastInjectionTemplate: undefined,
			recentTexts: "",
		})
		expect(r.text).to.equal(undefined)
		expect(r.event).to.equal(undefined)
	})

	it("★ 恒等：正文为空且无 found/无注入 → 无文案、无事件（不得凭空产出）", () => {
		const r = resolveInterventionCopyForDisplay({
			found: null,
			body: "",
			lastInjectionTemplate: undefined,
			recentTexts: "",
		})
		expect(r.text).to.equal(undefined)
		expect(r.event).to.equal(undefined)
	})
})
