import { expect } from "chai"
import { dropUnclosedInterventionCopy, extractInterventionCopy } from "../interventionCopy"

/**
 * 【F13】回执块 `<teaching_intervention_copy …>…</teaching_intervention_copy>` 的解析与剥离。
 *
 * 这是**纯函数**层：解析给展示层用（回执文案 → 学生可见文案），剥离保证学生永远看不到 XML 残渣。
 * 六类边界 + 逐字节恒等断言（恒等是热路径前提：绝大多数助手正文不含该标签）。
 */
const block = (copy: string, rule = "no_edit_streak", severity = "gentle"): string =>
	`<teaching_intervention_copy rule="${rule}" severity="${severity}">\n${copy}\n</teaching_intervention_copy>`

describe("F13 · 回执块解析与剥离", () => {
	it("★ 不含标签 → found=null 且 rest 与原文**逐字节**相等（恒等变换）", () => {
		const text = "## 插入排序\n\n这段代码的核心是内层循环。\n\n```python\nprint(1)\n```\n"
		const r = extractInterventionCopy(text)
		expect(r.found).to.equal(null)
		expect(r.rest).to.equal(text)
	})

	it("★ 命中：取首块内文为 copy，rest 为剥离后的正文", () => {
		const copy = "我刚刚给了插入排序的完整实现。你先动手写出内层循环，再回来对照？"
		const body = "下面是插入排序的说明。"
		const r = extractInterventionCopy(`${block(copy)}\n\n---\n\n${body}`)
		expect(r.found).to.not.equal(null)
		expect(r.found?.copy).to.equal(copy)
		expect(r.found?.rule).to.equal("no_edit_streak")
		expect(r.found?.severity).to.equal("gentle")
		expect(r.rest).to.equal(`---\n\n${body}`)
		expect(r.rest).to.not.include("<teaching_intervention_copy")
	})

	it("★ 未闭合标签 → found=null 且 rest 与原文完全相同（恒等，交由 partial 分支另行丢弃）", () => {
		const text = `先动手试试：\n<teaching_intervention_copy rule="no_edit_streak" severity="gentle">\n我刚刚给了实现`
		const r = extractInterventionCopy(text)
		expect(r.found).to.equal(null)
		expect(r.rest).to.equal(text)
	})

	it("★ 多块 → 首个作为 found，其余**一并剥离**（学生只看到文案）", () => {
		const first = "我刚刚给了实现。你先动手写第一版，再回来对照？"
		const r = extractInterventionCopy(`${block(first)}\n\n中间正文\n\n${block("第二块文案", "no_edit_streak", "moderate")}`)
		expect(r.found?.copy).to.equal(first)
		expect(r.rest).to.equal("中间正文")
		expect(r.rest).to.not.include("<teaching_intervention_copy")
	})

	it("★ 块在正文中间 → 两侧文字保留，连续空行归一为至多一个空行", () => {
		const r = extractInterventionCopy(`上文\n\n${block("我刚刚给了实现。你先动手写第一版，再回来对照？")}\n\n下文`)
		expect(r.rest).to.equal("上文\n\n下文")
	})

	it("★ 空块 → copy 为空串（交由校验拒绝），且块仍被剥离", () => {
		const r = extractInterventionCopy(
			`<teaching_intervention_copy rule="no_edit_streak" severity="gentle"></teaching_intervention_copy>\n\n正文`,
		)
		expect(r.found).to.not.equal(null)
		expect(r.found?.copy).to.equal("")
		expect(r.rest).to.equal("正文")
	})

	it("★ 属性缺失时 rule / severity 为 undefined（不得臆造）", () => {
		const r = extractInterventionCopy(
			"<teaching_intervention_copy>我刚刚给了实现。你先动手写第一版？</teaching_intervention_copy>",
		)
		expect(r.found?.rule).to.equal(undefined)
		expect(r.found?.severity).to.equal(undefined)
		expect(r.found?.copy).to.equal("我刚刚给了实现。你先动手写第一版？")
	})

	it("★ 剥离完整性：含**完整**块的输入，剥离后一律不再含开标签", () => {
		// ⚠️ 有意**不**把「未闭合」样本放进来：按上面的契约，未闭合标签必须恒等保留
		//（流式中间态由 dropUnclosedInterventionCopy 单独丢弃、完整文本路径不得删学生内容）。
		// 两条用例曾经互斥（一边要求恒等、一边要求不含开标签），本仓库裁定以契约为准。
		const samples = ["", "普通正文", block("文案"), `前\n${block("x")}\n后`, `${block("a")}${block("b")}`]
		for (const s of samples) {
			expect(extractInterventionCopy(s).rest).to.not.include("<teaching_intervention_copy")
		}
	})
})

describe("F13 · 流式中间态：未闭合开标签的丢弃", () => {
	it("★ 存在开标签（尚未闭合）→ 丢弃开标签及其后全部内容，保留前缀", () => {
		const text = '先看这段。\n<teaching_intervention_copy rule="no_edit_streak" severity="gentle">\n我刚刚给了实现'
		expect(dropUnclosedInterventionCopy(text)).to.equal("先看这段。")
	})

	it("★ 不含开标签 → 恒等变换（逐字节）", () => {
		const text = "普通正文\n\n```python\nprint(1)\n```\n"
		expect(dropUnclosedInterventionCopy(text)).to.equal(text)
	})

	it("★ 已闭合的块同样被丢弃（partial 仅预览前缀，最终文案由整条替换呈现）", () => {
		const text = `前缀\n${block("我刚刚给了实现。你先动手写第一版？")}\n正文`
		expect(dropUnclosedInterventionCopy(text)).to.equal("前缀")
	})
})
