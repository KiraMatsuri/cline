import { expect } from "chai"
import { ContentAnalyzer } from "../ContentAnalyzer"

const P = String.fromCharCode(0xff5c) // 全角竖线 U+FF5C
const T = (s: string): string => s.replace(/%P%/g, `${P}${P}`)

describe("ContentAnalyzer.detectCode（方案 A）", () => {
	const a = new ContentAnalyzer()

	it("★ 纯工具调用标记不得判为代码（实测误判来源）", () => {
		const leaked = T(
			[
				"<%P%DSML%P% calls>",
				'<%P%DSML%P% invoke name="use_mcp_tool">',
				'<%P%DSML%P% parameter name="server_name">wiki<%P%/DSML%P% parameter>',
				'<%P%DSML%P% parameter name="arguments">{}<%P%/DSML%P% parameter>',
				"<%P%/DSML%P% invoke>",
				"<%P%/DSML%P% calls>",
			].join("\n"),
		)
		const r = a.analyze(leaked)
		expect(r.hasCode).to.equal(false)
		expect(r.hasCodeBlock).to.equal(false)
	})

	it("★ 含完整代码块 → hasCodeBlock=true（真正的代码生成信号，必须保留）", () => {
		const code = ["```python", "def bubble_sort(a):", "    for i in range(len(a)):", "        pass", "```"].join("\n")
		const r = a.analyze(`冒泡排序可以这样写：\n${code}\n注意边界。`)
		expect(r.hasCode).to.equal(true)
		expect(r.hasCodeBlock).to.equal(true)
		expect(r.codeBlockCount).to.equal(1)
	})

	it("★ 仅行内代码 → hasCodeBlock=false（提及不等于生成）", () => {
		const r = a.analyze("资料库当前无法连接（`wiki_backend_unreachable`），我换个关键词试试。")
		expect(r.hasCodeBlock).to.equal(false)
		expect(r.hasInlineCode).to.equal(true)
	})

	it("学生正文里的 markdown 表格竖线与比较符号不得判为代码", () => {
		const r = a.analyze("| 周 | 内容 |\n|---|---|\n| 1 | 起步 |\n\n当 a < b 时交换。")
		expect(r.hasCode).to.equal(false)
		expect(r.hasCodeBlock).to.equal(false)
	})

	it("工具标记被剔除后，同段文本里的真代码块仍能被识别", () => {
		const mixed = T(["<%P%DSML%P% calls>", "下面给你一个例子：", "```python", "print(a)", "```"].join("\n"))
		const r = a.analyze(mixed)
		expect(r.hasCodeBlock).to.equal(true)
	})
})

describe("ContentAnalyzer.detectCodeBlock", () => {
	const a = new ContentAnalyzer()

	it("仅统计 fenced 代码块，不把行内代码算进去", () => {
		expect(a.detectCodeBlock("`x` 是个变量")).to.equal(false)
		expect(a.detectCodeBlock("```\nx = 1\n```")).to.equal(true)
	})
})
