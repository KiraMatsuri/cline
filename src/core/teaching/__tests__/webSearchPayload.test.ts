import { expect } from "chai"
import { buildWebSearchError, parseWebSearchResults, type WebSearchErrorCode } from "../mcp-web/webSearchPayload"

describe("F8 · 联网检索结构化错误载荷", () => {
	it("★ 四种错误码都给出可读中文 message 且 ok=false", () => {
		const codes: WebSearchErrorCode[] = ["backend_unreachable", "endpoint_missing", "timeout", "bad_response"]
		for (const code of codes) {
			const p = buildWebSearchError(code)
			expect(p.ok).to.equal(false)
			expect(p.error).to.equal(code)
			expect(p.message).to.be.a("string")
			expect(p.message).to.not.equal("")
			// 必须是中文可读文案（能直接展示给模型/日志）
			expect(p.message).to.match(/[\u4e00-\u9fa5]/)
		}
	})

	it("★ 可附 detail，且不覆盖基础说明", () => {
		const base = buildWebSearchError("timeout")
		const withDetail = buildWebSearchError("timeout", "http_504")
		expect(withDetail.error).to.equal("timeout")
		expect(withDetail.ok).to.equal(false)
		// 基础说明仍在，detail 只是追加上去
		expect(withDetail.message).to.include(base.message)
		expect(withDetail.message).to.include("http_504")
	})

	it("★ parseWebSearchResults 接受合法形状", () => {
		const raw = { results: [{ title: "T", snippet: "S", url: "https://example.com" }] }
		expect(parseWebSearchResults(raw)).to.deep.equal([{ title: "T", snippet: "S", url: "https://example.com" }])
		// 空结果是合法的（确实没检索到），返回 [] 而非 null
		expect(parseWebSearchResults({ results: [] })).to.deep.equal([])
	})

	it("★ parseWebSearchResults 对畸形输入返回 null（缺 results / 非数组 / 元素缺字段 / null）", () => {
		expect(parseWebSearchResults(null)).to.equal(null)
		expect(parseWebSearchResults(undefined)).to.equal(null)
		expect(parseWebSearchResults("nope")).to.equal(null)
		expect(parseWebSearchResults({})).to.equal(null)
		expect(parseWebSearchResults({ results: {} })).to.equal(null)
		expect(parseWebSearchResults({ results: "x" })).to.equal(null)
		// 元素缺字段 / 字段类型不对 / 元素为 null
		expect(parseWebSearchResults({ results: [{ title: "T" }] })).to.equal(null)
		expect(parseWebSearchResults({ results: [{ title: "T", snippet: "S" }] })).to.equal(null)
		expect(parseWebSearchResults({ results: [{ title: 1, snippet: "S", url: "u" }] })).to.equal(null)
		expect(parseWebSearchResults({ results: [null] })).to.equal(null)
	})
})
