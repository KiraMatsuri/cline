import { expect } from "chai"
import { afterEach, beforeEach } from "mocha"
import * as sinon from "sinon"
import { LLMWikiService } from "../LLMWikiService"

/**
 * P0-3 · 预召回：把最近一条提问变成 top-N 资料片段
 *
 * 这一层的"正确"不是指标好看，而是四件硬事实：
 *   ① 请求里**不再出现 week / max_week**（周数已整体移除，回潮即失效）
 *   ② query 与 limit 真的透传（否则检索等于退化成"取前 N 条"）
 *   ③ 后端挂了 / 没有命中 → 返回 null（调用方保持"只注入索引"，绝不因为这块拖垮提问）
 *   ④ 命中 → 拼出带 chunk_id 与来源标注规则的文本块
 */
describe("LLMWikiService.recallForQuestion — v3 预召回", () => {
	let sandbox: sinon.SinonSandbox
	let fetchStub: sinon.SinonStub

	const setServerUrl = (url: string) => {
		;(LLMWikiService.getInstance() as unknown as { _serverUrl: string })._serverUrl = url
	}

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		fetchStub = sandbox.stub(globalThis, "fetch").resolves({
			ok: true,
			json: async () => ({
				ok: true,
				data: [
					{ id: "c1", title: "列表推导式", content: "列表推导式是……" },
					{ id: "c2", title: "生成器表达式", content: "生成器表达式……" },
				],
			}),
		} as never)
		// 单例内部状态跨用例残留 → 显式复位
		;(LLMWikiService.getInstance() as unknown as { _wikiCache: Map<string, unknown[]> })._wikiCache = new Map()
		setServerUrl("http://localhost:4001")
	})

	afterEach(() => {
		sandbox.restore()
	})

	it("★ 请求 URL 带 q 与 limit，且不含 week / max_week", async () => {
		await LLMWikiService.getInstance().recallForQuestion("什么是列表推导式", { limit: 3 })
		const url = String(fetchStub.firstCall.args[0])
		expect(url.startsWith("http://localhost:4001/api/v1/wiki/search?q=")).to.equal(true)
		expect(url.includes("limit=3")).to.equal(true)
		expect(url.includes("week")).to.equal(false)
	})

	it("★ query 里出现的是学生原问题（URL 编码后仍需能解码回原文）", async () => {
		await LLMWikiService.getInstance().recallForQuestion("什么是列表推导式")
		const url = new URL(String(fetchStub.firstCall.args[0]))
		expect(url.searchParams.get("q")).to.equal("什么是列表推导式")
	})

	it("★ 命中时返回带 chunk_id 与来源规则的片段块", async () => {
		const block = await LLMWikiService.getInstance().recallForQuestion("列表")
		expect(block === null).to.equal(false)
		expect(block as string).to.include("## 参考教材片段（自动检索，可能不完整）")
		expect(block as string).to.include("教材#c1")
		expect(block as string).to.include("(教材: <chunk_id>)")
	})

	it("★ 未配置后端（serverUrl 为空）→ null，且不发请求", async () => {
		setServerUrl("")
		const block = await LLMWikiService.getInstance().recallForQuestion("列表")
		expect(block === null).to.equal(true)
		expect(fetchStub.called).to.equal(false)
	})

	it("★ 提问过短（<2 字）→ null，避免把「好」「嗯」拿去检索", async () => {
		const block = await LLMWikiService.getInstance().recallForQuestion("好")
		expect(block === null).to.equal(true)
		expect(fetchStub.called).to.equal(false)
	})

	it("★ 后端 500 → null（不影响提问）", async () => {
		fetchStub.resolves({ ok: false, status: 500, json: async () => ({}) } as never)
		const block = await LLMWikiService.getInstance().recallForQuestion("列表")
		expect(block === null).to.equal(true)
	})

	it("★ 检索为空（data: []）→ null", async () => {
		fetchStub.resolves({ ok: true, json: async () => ({ ok: true, data: [] }) } as never)
		const block = await LLMWikiService.getInstance().recallForQuestion("列表")
		expect(block === null).to.equal(true)
	})

	it("★ fetch 抛异常（网络断）→ null", async () => {
		fetchStub.rejects(new Error("ECONNREFUSED"))
		const block = await LLMWikiService.getInstance().recallForQuestion("列表")
		expect(block === null).to.equal(true)
	})

	it("★ 长提问被截断到 300 字以内（避免把整段代码塞进 query）", async () => {
		const long = "列".repeat(1200)
		await LLMWikiService.getInstance().recallForQuestion(long)
		const url = new URL(String(fetchStub.firstCall.args[0]))
		const q = url.searchParams.get("q") ?? ""
		expect(q.length <= 300).to.equal(true)
	})

	it("★ limit 超上限被夹到 10", async () => {
		await LLMWikiService.getInstance().recallForQuestion("列表", { limit: 99 })
		const url = String(fetchStub.firstCall.args[0])
		expect(url.includes("limit=10")).to.equal(true)
	})

	it("★ 后端只回 snippet（不回 content）时仍能注入（真实接口就是 snippet）", async () => {
		fetchStub.resolves({
			ok: true,
			json: async () => ({ ok: true, data: [{ id: "s1", title: "切片", snippet: "列表支持切片" }] }),
		} as never)
		const block = await LLMWikiService.getInstance().recallForQuestion("列表切片")
		expect(block === null).to.equal(false)
		expect(block as string).to.include("教材#s1")
		expect(block as string).to.include("列表支持切片")
	})
})
