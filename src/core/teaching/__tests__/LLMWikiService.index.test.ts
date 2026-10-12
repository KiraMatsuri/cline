import { expect } from "chai"
import { LLMWikiService } from "../LLMWikiService"

describe("LLMWikiService.buildIndexGroups", () => {
	it("★【F4】按周聚合标题，且放行超过当前周的资料（索引全周可见）", () => {
		const svc = LLMWikiService.getInstance()
		// 直接注入内部缓存（测试用）
		;(svc as unknown as { _wikiCache: Map<string, unknown[]> })._wikiCache = new Map([
			["a", [{ id: "a", title: "列表", applicable_week: 3, content: "x" }]],
			["b", [{ id: "b", title: "装饰器", applicable_week: 9, content: "y" }]],
		])
		;(svc as unknown as { _currentWeek: number })._currentWeek = 5

		const groups = svc.buildIndexGroups()
		expect(groups.map((g) => g.week)).to.deep.equal([3, 9])
		expect(groups[0].titles).to.deep.equal(["列表"])
		expect(groups[1].titles).to.deep.equal(["装饰器"])
	})

	it("★ 同一周内标题去重，且周序升序", () => {
		const svc = LLMWikiService.getInstance()
		;(svc as unknown as { _wikiCache: Map<string, unknown[]> })._wikiCache = new Map([
			["b", [{ id: "b1", title: "装饰器", applicable_week: 5, content: "y" }]],
			["a", [{ id: "a1", title: "函数基础", applicable_week: 2, content: "x" }]],
			[
				"c",
				[
					{ id: "c1", title: "装饰器", applicable_week: 5, content: "z" },
					{ id: "c2", title: "函数进阶", applicable_week: 5, content: "w" },
				],
			],
		])
		;(svc as unknown as { _currentWeek: number })._currentWeek = 5

		const groups = svc.buildIndexGroups()
		expect(groups.map((g) => g.week)).to.deep.equal([2, 5])
		expect(groups[1].titles).to.deep.equal(["装饰器", "函数进阶"])
	})

	it("★ 只含元数据，不含正文（索引不得退化成全文注入）", () => {
		const svc = LLMWikiService.getInstance()
		const longContent = "正".repeat(5000)
		;(svc as unknown as { _wikiCache: Map<string, unknown[]> })._wikiCache = new Map([
			["a", [{ id: "a", title: "超长章节", applicable_week: 1, content: longContent }]],
		])
		;(svc as unknown as { _currentWeek: number })._currentWeek = 5

		const groups = svc.buildIndexGroups()
		expect(groups[0].titles).to.deep.equal(["超长章节"])
		expect(JSON.stringify(groups).includes(longContent)).to.equal(false)
	})

	it("★ 标题规范化：去换行、去 (i/n) 后缀、超长截断，且据此正确去重", () => {
		const svc = LLMWikiService.getInstance()
		;(svc as unknown as { _wikiCache: Map<string, unknown[]> })._wikiCache = new Map([
			[
				"a",
				[
					{ id: "a1", title: "第一章\n变量与类型 (1/3)", applicable_week: 1, content: "x" },
					{ id: "a2", title: "第一章\n变量与类型 (2/3)", applicable_week: 1, content: "y" },
					{ id: "a3", title: "第一章 变量与类型 (3/3)", applicable_week: 1, content: "z" },
					{ id: "a4", title: "超长".repeat(80), applicable_week: 1, content: "w" },
				],
			],
		])
		;(svc as unknown as { _currentWeek: number })._currentWeek = 5

		const groups = svc.buildIndexGroups()
		expect(groups).to.have.lengthOf(1)
		// 三个 chunk 规范化后是同一个标题 → 只剩一条；再加那条超长的
		expect(groups[0].titles).to.have.lengthOf(2)
		expect(groups[0].titles[0]).to.equal("第一章 变量与类型")
		expect(groups[0].titles[0]).to.not.include("\n")
		// 超长标题被截断（60 字 + 省略号）
		expect(groups[0].titles[1].length).to.be.at.most(61)
		expect(groups[0].titles[1].endsWith("…")).to.equal(true)
	})
})

describe("LLMWikiService.isWikiMcpAvailable", () => {
	it("可由 setWikiMcpAvailable 回写", () => {
		const svc = LLMWikiService.getInstance()
		svc.setWikiMcpAvailable(true)
		expect(svc.isWikiMcpAvailable()).to.equal(true)
		svc.setWikiMcpAvailable(false)
		expect(svc.isWikiMcpAvailable()).to.equal(false)
	})
})

describe("LLMWikiService.buildIndexGroups — 教材章节并入（v2.13）", () => {
	type Internals = {
		_wikiCache: Map<string, unknown[]>
		_textbookChapters: unknown[]
		_currentWeek: number
	}

	// 单例状态会跨用例残留，每个用例都显式写入三个字段（含收尾复位）
	const setInternals = (svc: LLMWikiService, wiki: Map<string, unknown[]>, tb: unknown[], week: number): void => {
		const internals = svc as unknown as Internals
		internals._wikiCache = wiki
		internals._textbookChapters = tb
		internals._currentWeek = week
	}

	it("★ 教材章节标题并入索引（未 publish-as-wiki 时至少可见章节目录）", () => {
		const svc = LLMWikiService.getInstance()
		setInternals(svc, new Map(), [{ id: "t1", title: "第1章 变量", applicable_week: 1, content: "教材正文" }], 5)

		const groups = svc.buildIndexGroups()
		expect(groups).to.deep.equal([{ week: 1, titles: ["第1章 变量"] }])
		// 只取标题，不得把教材正文带进索引
		expect(JSON.stringify(groups).includes("教材正文")).to.equal(false)

		setInternals(svc, new Map(), [], 1)
	})

	it("★【F4】教材章节与 wiki 标题跨来源去重，且不再被周数过滤", () => {
		const svc = LLMWikiService.getInstance()
		setInternals(
			svc,
			new Map([["a", [{ id: "a1", title: "第1章 变量 (1/2)", applicable_week: 1, content: "x" }]]]),
			[
				{ id: "t1", title: "第1章 变量 (2/2)", applicable_week: 1, content: "y" },
				{ id: "t2", title: "未来章节", applicable_week: 9, content: "z" },
			],
			5,
		)

		const groups = svc.buildIndexGroups()
		// 第 9 周章节不再被过滤（索引全周可见）；wiki 与教材同章（仅 (i/n) 后缀不同）合并为一条
		expect(groups).to.deep.equal([
			{ week: 1, titles: ["第1章 变量"] },
			{ week: 9, titles: ["未来章节"] },
		])

		setInternals(svc, new Map(), [], 1)
	})
})
