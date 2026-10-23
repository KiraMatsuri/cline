import { expect } from "chai"
import { LIST_WIKI_WEEKS_DESCRIPTION, READ_WIKI_CHUNK_DESCRIPTION, SEARCH_WIKI_DESCRIPTION } from "../mcp/wikiToolDescriptions"
import { WEB_SEARCH_DESCRIPTION, WEB_SEARCH_RESULT_HEADER } from "../mcp-web/webToolDescriptions"

describe("search_wiki 描述（v3：全量按相关度）", () => {
	it("★ 检索为空时的口径：可讲通用知识、须说明、不给完整可运行实现", () => {
		expect(SEARCH_WIKI_DESCRIPTION).to.include("返回 0 条")
		expect(SEARCH_WIKI_DESCRIPTION).to.include("课程资料中没有对应内容")
		expect(SEARCH_WIKI_DESCRIPTION).to.include("不要给出完整可运行实现")
	})

	it("★ 不得再出现按教学周划界 / 一次性拒答的旧口径", () => {
		const legacy = ["当前教学周", "只返回当前教学周之前（含）已发布的资料", "不要展开讲解", "标注所属周次"].filter((t) =>
			SEARCH_WIKI_DESCRIPTION.includes(t),
		)
		expect(legacy).to.deep.equal([])
	})

	it("★ 声明按相关度排序 + 标题命中优先", () => {
		expect(SEARCH_WIKI_DESCRIPTION).to.include("按相关度排序")
		expect(SEARCH_WIKI_DESCRIPTION).to.include("标题命中优先")
	})

	it("读取单条资料与列出分布的工具描述存在（三个只读工具都在）", () => {
		expect(READ_WIKI_CHUNK_DESCRIPTION).to.include("chunk_id")
		expect(LIST_WIKI_WEEKS_DESCRIPTION).to.include("资料库")
	})
})

describe("web_search 描述（provider 无关的联网检索工具）", () => {
	it("★ 声明「仅用于校验通用知识」与「以教材为准」", () => {
		expect(WEB_SEARCH_DESCRIPTION).to.include("仅用于")
		expect(WEB_SEARCH_DESCRIPTION).to.include("校验通用知识")
		expect(WEB_SEARCH_DESCRIPTION).to.include("以教材为准")
		// v3 起不再有教学周概念
		expect(WEB_SEARCH_DESCRIPTION.includes("教学周")).to.equal(false)
		expect(WEB_SEARCH_RESULT_HEADER.includes("教学周")).to.equal(false)
	})

	it("★ 必须告知失败时返回结构化错误、不得编造", () => {
		expect(WEB_SEARCH_DESCRIPTION).to.include("结构化错误")
		expect(WEB_SEARCH_DESCRIPTION).to.include("编造")
	})
})
