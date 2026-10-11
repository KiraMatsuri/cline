import { expect } from "chai"
import { parseFencedCodeBlocks } from "../codeBlocks"

describe("parseFencedCodeBlocks", () => {
	it("解析语言标签与内容行数（空行不计）", () => {
		const [b] = parseFencedCodeBlocks("```python\na = 1\n\nb = 2\n```")
		expect(b.lang).to.equal("python")
		expect(b.lineCount).to.equal(2)
		expect(b.inner).to.equal("a = 1\n\nb = 2")
	})

	it("无语言标签时 lang 为空串", () => {
		expect(parseFencedCodeBlocks("```\nx\n```")[0].lang).to.equal("")
	})

	it("★ 行内代码不算块", () => {
		expect(parseFencedCodeBlocks("`x` 是个变量")).to.deep.equal([])
	})

	it("★ 多个块全部解析", () => {
		expect(parseFencedCodeBlocks("```\na\n```\n中间文字\n```python\nb\nc\n```")).to.have.lengthOf(2)
	})

	it("★ 未闭合的围栏不算一个块（流式中间态）", () => {
		expect(parseFencedCodeBlocks("```python\na = 1\n")).to.deep.equal([])
	})

	it("空输入 / null 输入", () => {
		expect(parseFencedCodeBlocks("")).to.deep.equal([])
	})
})
