import { expect } from "chai"
import { buildWikiSystemPrompt } from "../wikiPrompt"

const opts = {
	index: ["列表与字典", "函数基础", "装饰器"],
	mcpAvailable: true,
}

describe("buildWikiSystemPrompt（v3：去周数）", () => {
	it("★ 必须包含认知边界约束段", () => {
		const s = buildWikiSystemPrompt(opts)
		expect(s).to.include("认知边界约束")
		expect(s).to.include("search_wiki")
	})

	it("★ 不再出现「第 N 周 / 进度内 / 超纲」这类教学进度口径", () => {
		const s = buildWikiSystemPrompt(opts)
		expect(s.includes("周")).to.equal(false)
		expect(s.includes("超纲")).to.equal(false)
		expect(s.includes("进度")).to.equal(false)
	})

	it("★ 检索为空时的口径：可讲通用知识、须说明、不给完整可运行实现", () => {
		const s = buildWikiSystemPrompt(opts)
		expect(s).to.include("课程资料中没有对应内容")
		expect(s).to.include("不给完整可运行实现")
		// 旧版"一律拒答 / 按周分档"的指令必须彻底消失
		expect(s.includes("不要一律拒答")).to.equal(false)
		expect(s.includes("【A 在进度内】")).to.equal(false)
	})

	it("包含资料索引标题，且不含正文", () => {
		const s = buildWikiSystemPrompt(opts)
		expect(s).to.include("资料索引")
		expect(s).to.include("列表与字典")
		expect(s).to.include("装饰器")
		expect(s.length).to.be.lessThan(3000)
		// ★ 下界：防止"返回空串"也算通过（空跑陷阱）
		expect(s.length).to.be.greaterThan(200)
	})

	it("MCP 不可用时给出状态声明", () => {
		const s = buildWikiSystemPrompt({ ...opts, mcpAvailable: false })
		expect(s).to.include("当前不可用")
	})

	it("★ MCP 不可用时仍保留认知边界约束（不得随全文一起去掉）", () => {
		const s = buildWikiSystemPrompt({ ...opts, mcpAvailable: false })
		expect(s).to.include("认知边界约束")
	})

	it("索引为空时给出占位而非崩掉", () => {
		const s = buildWikiSystemPrompt({ ...opts, index: [] })
		expect(s).to.include("资料库暂无资料")
	})

	it("★ 索引过长时被截断并显式标注省略数，不得退化成全文注入", () => {
		const huge = Array.from({ length: 400 }, (_, i) => `很长的标题名称编号${i}`.repeat(3))
		const s = buildWikiSystemPrompt({ ...opts, index: huge })
		expect(s).to.include("未列出")
		expect(s).to.include("可用 search_wiki 检索")
		expect(s.length).to.be.lessThan(4000)
	})

	it("★ 索引按传入顺序输出（服务端已按周升序组织）", () => {
		const s = buildWikiSystemPrompt({ index: ["甲", "乙", "丙"], mcpAvailable: true })
		const ia = s.indexOf("- 甲")
		const ib = s.indexOf("- 乙")
		const ic = s.indexOf("- 丙")
		expect(ia).to.be.lessThan(ib)
		expect(ib).to.be.lessThan(ic)
	})

	it("★ 空白标题被跳过，不会产生空 `- ` 行", () => {
		const s = buildWikiSystemPrompt({ index: ["  ", "", "变量"], mcpAvailable: true })
		expect(s).to.include("- 变量")
		expect(s.includes("- \n")).to.equal(false)
	})
})
