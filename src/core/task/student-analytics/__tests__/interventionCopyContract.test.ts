import { expect } from "chai"
import { buildCopyTaskSheet, MAX_COPY_CHARS, SEVERITY_VOICE, validateCopy } from "../InterventionCopyContract"

/**
 * 【F13】文案契约：四条**确定性**校验（失败 ⇒ 降级模板）+ 一条**启发性**校验（只记账、不降级）。
 *
 * 用户裁定（2026-10-11）：轻量启发式不得影响「干预一定发生」这一确定性 ⇒ 主题锚定失败时
 * `ok` 仍为 true、`downgrade` 仍为 false，只把 `topic_unanchored` 放进 advisories。
 */
const ctx = (recentTexts = ""): { recentTexts: string } => ({ recentTexts })

describe("F13 · 文案契约校验", () => {
	it("★ 去 emoji 后 > 120 字 → too_long（ok=false / downgrade=true）", () => {
		const copy = `💡 ${"啊".repeat(MAX_COPY_CHARS)}先动手试试？`
		const v = validateCopy(copy, ctx("啊"))
		expect(v.ok).to.equal(false)
		expect(v.downgrade).to.equal(true)
		expect(v.reasons).to.include("too_long")
	})

	it("★ 恰好 120 字（去 emoji）不算超长", () => {
		const suffix = "请先动手写一版？"
		const copy = "啊".repeat(MAX_COPY_CHARS - [...suffix].length) + suffix
		expect([...copy].length).to.equal(MAX_COPY_CHARS)
		expect(validateCopy(copy, ctx("啊")).reasons).to.not.include("too_long")
	})

	it("★ 含 fenced 代码块 → has_fenced_code", () => {
		const copy = "我刚刚给出了实现。请先动手写出 ```python\nprint(1)\n``` 这段逻辑，你会怎么写？"
		expect(validateCopy(copy, ctx("实现")).reasons).to.include("has_fenced_code")
	})

	it("★ 既无问号也无行动动词 → no_blank", () => {
		const copy = "我刚刚给出了这段完整实现。"
		const v = validateCopy(copy, ctx("实现"))
		expect(v.ok).to.equal(false)
		expect(v.reasons).to.include("no_blank")
	})

	it("★ 含违禁语（系统/检测）→ forbidden_phrase", () => {
		const copy = "请不要提系统检测到的依赖问题，先自己动手写一版？"
		expect(validateCopy(copy, ctx("依赖")).reasons).to.include("forbidden_phrase")
	})

	it("★ 主题未锚定 → **只进 advisories**：ok===true && downgrade===false（用户裁定的核心）", () => {
		const v = validateCopy("我刚刚给出了实现的思路。你打算先动手写哪一部分呢？", ctx("请解释 二分查找 的原理"))
		expect(v.ok).to.equal(true)
		expect(v.downgrade).to.equal(false)
		expect(v.advisories).to.include("topic_unanchored")
		expect(v.reasons).to.have.lengthOf(0)
	})

	it("★ 主题已锚定 → advisories 不含 topic_unanchored", () => {
		const v = validateCopy("我刚刚给出了排序算法的思路。你打算先动手写哪一部分呢？", ctx("请解释 排序算法 的原理"))
		expect(v.advisories).to.not.include("topic_unanchored")
	})

	it("★ recentTexts 为空时不误报（无从判定主题）→ 只记账、不降级", () => {
		const v = validateCopy("我刚刚给了实现。你先动手写第一版？", ctx(""))
		expect(v.ok).to.equal(true)
		expect(v.downgrade).to.equal(false)
	})
})

describe("F13 · 写作任务书（buildCopyTaskSheet）", () => {
	const sheet = (severity: "gentle" | "moderate" | "strong" = "gentle", recentCopies: string[] = []) =>
		buildCopyTaskSheet({
			ruleId: "no_edit_streak",
			severity,
			style: "hint",
			templateText: "💡 实践建议：最近 8 轮我们都在聊，还没动手改过代码。想不想挑一处小地方试试？",
			recentCopies,
		})

	it("★ 外层标签是 <teaching_intervention …>，且**先于**回执示例出现", () => {
		const t = sheet()
		expect(t).to.match(/<teaching_intervention\s/)
		expect(t.startsWith('<teaching_intervention rule="no_edit_streak" severity="gentle">')).to.equal(true)
		expect(t.trimEnd().endsWith("</teaching_intervention>")).to.equal(true)
		// 结构不变量：外层标签是 `<teaching_intervention …>`（无 `_copy` 后缀），
		// 回执示例只以内层块形式出现且必须位于其后。
		expect(t.indexOf("<teaching_intervention ")).to.be.lessThan(t.indexOf("<teaching_intervention_copy"))
	})

	it("★ 力度档原样传递 + 语气要求原文（模型不得更改）", () => {
		for (const severity of ["gentle", "moderate", "strong"] as const) {
			expect(sheet(severity)).to.include(SEVERITY_VOICE[severity])
		}
	})

	it("★ 必含三要素（观察 / 锚定当前主题 / 留白）", () => {
		const t = sheet()
		expect(t).to.include("观察")
		expect(t).to.include("锚定当前主题")
		expect(t).to.include("留白")
	})

	it("★ 必含硬约束（字数上限 / 无代码块 / 不承诺 / 不得提及系统检测自动）", () => {
		const t = sheet()
		expect(t).to.include(`≤ ${MAX_COPY_CHARS} 字`)
		expect(t).to.include("emoji 不计")
		expect(t).to.include("不得含代码块")
		expect(t).to.include("不得承诺")
		expect(t).to.include("系统/检测/自动")
	})

	it("★ 必含回执格式示例，且明确要求回执块写在**正文**（否则 M9' 的 C 恒为 0）", () => {
		const t = sheet()
		expect(t).to.include('<teaching_intervention_copy rule="no_edit_streak" severity="gentle">')
		expect(t).to.include("</teaching_intervention_copy>")
		expect(t).to.include("正文")
		expect(t).to.include("result")
	})

	it("★ 模板本体作为语义基准/力度锚点随任务书附带", () => {
		expect(sheet()).to.include("💡 实践建议：最近 8 轮我们都在聊")
	})

	it("★ recentCopies 非空 → 回传并要求「换一种说法」；为空 → 不出现该指令", () => {
		const withRecent = sheet("gentle", ["旧文案一", "旧文案二"])
		expect(withRecent).to.include("换一种说法")
		expect(withRecent).to.include("旧文案一")
		expect(withRecent).to.include("旧文案二")
		expect(sheet()).to.not.include("换一种说法")
	})
})
