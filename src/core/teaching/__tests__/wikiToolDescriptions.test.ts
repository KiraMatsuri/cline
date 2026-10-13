import { expect } from "chai"
import { SEARCH_WIKI_DESCRIPTION } from "../mcp/wikiToolDescriptions"
import { WEB_SEARCH_DESCRIPTION } from "../mcp-web/webToolDescriptions"

describe("F4 · search_wiki 描述（防旧拒答文本回潮）", () => {
	it("★ 必须给出「仍可讲解 + 标注周次 + 补前置 + 不给完整实现」的口径", () => {
		expect(SEARCH_WIKI_DESCRIPTION).to.include("仍可讲解")
		expect(SEARCH_WIKI_DESCRIPTION).to.include("标注所属周次")
		expect(SEARCH_WIKI_DESCRIPTION).to.include("前置基础")
		expect(SEARCH_WIKI_DESCRIPTION).to.include("不要给出完整可运行实现")
	})

	it("★ 不得再出现「不要展开讲解」这类一次性拒答指令", () => {
		expect(SEARCH_WIKI_DESCRIPTION).to.not.include("不要展开讲解")
	})

	it("★ 保留「只返回当前教学周之前（含）已发布的资料」的检索边界声明", () => {
		expect(SEARCH_WIKI_DESCRIPTION).to.include("只返回当前教学周之前（含）已发布的资料")
	})
})

describe("F8 · web_search 描述（provider 无关的联网检索工具）", () => {
	it("★【F8】web_search 描述必须声明「仅用于校验通用知识」与「以教材/当前周为准」", () => {
		expect(WEB_SEARCH_DESCRIPTION).to.include("仅用于")
		expect(WEB_SEARCH_DESCRIPTION).to.include("校验通用知识")
		expect(WEB_SEARCH_DESCRIPTION).to.include("以教材与当前教学周为准")
	})

	it("★【F8】web_search 描述必须告知失败时返回结构化错误、不得编造", () => {
		expect(WEB_SEARCH_DESCRIPTION).to.include("结构化错误")
		expect(WEB_SEARCH_DESCRIPTION).to.include("编造")
	})
})
