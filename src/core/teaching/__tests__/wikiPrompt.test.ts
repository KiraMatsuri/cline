import { expect } from "chai"
import { buildWikiSystemPrompt } from "../wikiPrompt"

const opts = {
	week: 5,
	index: [
		{ week: 3, titles: ["列表与字典", "函数基础"] },
		{ week: 5, titles: ["装饰器"] },
	],
	mcpAvailable: true,
}

describe("buildWikiSystemPrompt", () => {
	it("★ 必须包含认知边界约束段", () => {
		const s = buildWikiSystemPrompt(opts)
		expect(s).to.include("认知边界约束")
		expect(s).to.include("严禁使用超出第 5 周")
	})

	it("★ 必须包含「检索为空时不得展开讲解」规则", () => {
		const s = buildWikiSystemPrompt(opts)
		expect(s).to.include("检索结果为空")
		expect(s).to.include("不要展开讲解")
	})

	it("包含资料索引且不含全文", () => {
		const s = buildWikiSystemPrompt(opts)
		expect(s).to.include("列表与字典")
		expect(s).to.include("资料索引")
		expect(s).to.include("第 3 周")
		// 索引模式不得塞入大段正文
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
		expect(s).to.include("严禁使用超出第 5 周")
	})

	it("★ week 越界被 clamp（不泄露后续周）", () => {
		const s = buildWikiSystemPrompt({ ...opts, week: 99 })
		expect(s).to.include("严禁使用超出第 18 周")
		// 索引仍应在（其周次 3/5 都 ≤ 18）
		expect(s).to.include("第 3 周")
	})

	it("索引为空时给出占位而非崩掉", () => {
		const s = buildWikiSystemPrompt({ ...opts, index: [] })
		expect(s).to.include("暂无资料")
	})

	it("★ 索引过长时被截断，不得退化成全文注入", () => {
		const huge = Array.from({ length: 400 }, (_, i) => ({
			week: (i % 18) + 1,
			titles: [`很长的标题名称编号${i}`.repeat(3)],
		}))
		const s = buildWikiSystemPrompt({ ...opts, index: huge })
		expect(s).to.include("后续索引已省略")
		expect(s.length).to.be.lessThan(4000)
	})
})
