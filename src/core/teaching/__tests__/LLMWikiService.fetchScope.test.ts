import { expect } from "chai"
import { afterEach, beforeEach } from "mocha"
import * as sinon from "sinon"
import { LLMWikiService } from "../LLMWikiService"

describe("LLMWikiService.fetchWiki — v3 去周数", () => {
	let sandbox: sinon.SinonSandbox
	let fetchStub: sinon.SinonStub

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		fetchStub = sandbox.stub(globalThis, "fetch").resolves({
			ok: true,
			json: async () => ({
				data: [
					{ id: "a", title: "第3周标题", applicable_week: 3, content: "x" },
					{ id: "b", title: "第9周标题", applicable_week: 9, content: "y" },
				],
				textbook_chapters: [],
			}),
		} as never)

		// LLMWikiService 是单例，内部状态会跨用例残留 → 每个用例开始前复位
		const svc = LLMWikiService.getInstance()
		;(svc as unknown as { _wikiCache: Map<string, unknown[]> })._wikiCache = new Map()
		;(svc as unknown as { _textbookChapters: unknown[] })._textbookChapters = []
		;(svc as unknown as { _serverUrl: string })._serverUrl = "http://localhost:4001"
		;(svc as unknown as { _currentTextbookId: string })._currentTextbookId = ""
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("★ 拉取 URL 不再带 max_week（资料库全量）", async () => {
		const svc = LLMWikiService.getInstance()
		await svc.fetchWiki()
		const url = String(fetchStub.firstCall.args[0])
		expect(url).to.equal("http://localhost:4001/api/v1/wiki")
		expect(url.includes("max_week")).to.equal(false)
	})

	it("★ 返回值包含全部资料，不再按周裁剪", async () => {
		const svc = LLMWikiService.getInstance()
		const all = await svc.fetchWiki()
		expect(all.map((c) => c.title)).to.deep.equal(["第3周标题", "第9周标题"])
	})

	it("★ 索引列出跨周标题（没有「当前周」这个概念了）", async () => {
		const svc = LLMWikiService.getInstance()
		await svc.fetchWiki()
		expect(svc.buildIndexTitles()).to.deep.equal(["第3周标题", "第9周标题"])
	})

	it("★ 配了教材时 URL 带 textbook_id，仍不带 max_week", async () => {
		const svc = LLMWikiService.getInstance()
		;(svc as unknown as { _currentTextbookId: string })._currentTextbookId = "tb_1"
		await svc.fetchWiki()
		const url = String(fetchStub.firstCall.args[0])
		expect(url).to.equal("http://localhost:4001/api/v1/wiki?textbook_id=tb_1")
	})
})
