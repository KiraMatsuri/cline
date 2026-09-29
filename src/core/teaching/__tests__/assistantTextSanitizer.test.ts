import { expect } from "chai"
import { stripLeakedToolCallMarkup } from "../assistantTextSanitizer"

// 用码点构造，避免在源码里内联裸标记（裸标记在某些解析器里会被当成控制语法）
const P = String.fromCharCode(0xff5c) // 全角竖线 U+FF5C
const T = (s: string): string => s.replace(/%P%/g, `${P}${P}`)

describe("stripLeakedToolCallMarkup", () => {
	it("★ 不含标记的正常文本原样返回（恒等变换）", () => {
		const normal = [
			"第 1 周学了：环境搭建、变量与类型。",
			"",
			"```python",
			'print("hello")  # 比较符号 a < b、管道 a | b 都不该被删',
			"```",
			"注意 `<div>` 这类尖括号是正文内容，不能当标记清掉。",
		].join("\n")
		expect(stripLeakedToolCallMarkup(normal)).to.equal(normal)
	})

	it("★ 整段都是泄漏标记 → 返回空串（webview 会据此丢弃该死消息）", () => {
		const leaked = T(
			[
				"<%P%DSML%P% calls>",
				'<%P%DSML%P% invoke name="use_mcp_tool">',
				'<%P%DSML%P% parameter name="server_name">wiki<%P%/DSML%P% parameter>',
				'<%P%DSML%P% parameter name="tool_name">list_wiki_weeks<%P%/DSML%P% parameter>',
				"<%P%/DSML%P% invoke>",
				"<%P%/DSML%P% calls>",
			].join("\n"),
		)
		expect(stripLeakedToolCallMarkup(leaked)).to.equal("")
	})

	it("★ 标记与正常文字混排 → 只剔除标记行，保留文字", () => {
		const mixed = T(
			[
				"我检索了课程资料库。",
				'<%P%DSML%P% invoke name="use_mcp_tool">',
				'<%P%DSML%P% parameter name="tool_name">search_wiki<%P%/DSML%P% parameter>',
				"<%P%/DSML%P% invoke>",
				"第 1 周资料目前可访问。",
			].join("\n"),
		)
		const out = stripLeakedToolCallMarkup(mixed)
		expect(out).to.equal("我检索了课程资料库。\n第 1 周资料目前可访问。")
		expect(out).to.not.include(P)
	})

	it("空串 / 空白串边界", () => {
		expect(stripLeakedToolCallMarkup("")).to.equal("")
		expect(stripLeakedToolCallMarkup("   ")).to.equal("   ")
	})

	it("★ ASCII 竖线不算标记（避免误伤 markdown 表格与按位或）", () => {
		const ascii = "| 周 | 内容 |\n|---|---|\n| 1 | 起步 |\n\n`a | b`"
		expect(stripLeakedToolCallMarkup(ascii)).to.equal(ascii)
	})
})
