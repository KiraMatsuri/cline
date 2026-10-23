import { expect } from "chai"
import { buildRecallContext, MAX_RECALL_CHARS } from "../wikiPrompt"

/**
 * P0-3 · 预召回片段块（纯函数层）
 *
 * 这块的唯一风险是"把上下文吃光"与"误召回被硬凑成答案"，所以断言集中在
 * 预算、条数、去重、截断、以及规则段是否写清了"无关就别引用"。
 */
describe("buildRecallContext — 预召回片段块", () => {
	it("★ 没有有效片段 → null（调用方保持只注入索引）", () => {
		expect(buildRecallContext([]) === null).to.equal(true)
		expect(buildRecallContext([{ chunkId: "c1", title: "空", content: "   " }]) === null).to.equal(true)
	})

	it("★ 命中时按 [教材#id｜标题] 正文 的格式输出", () => {
		const block = buildRecallContext([{ chunkId: "c9", title: "循环", content: "for 循环的写法" }])
		expect(block as string).to.include("## 参考教材片段（自动检索，可能不完整）")
		expect(block as string).to.include("[教材#c9｜循环] for 循环的写法")
	})

	it("★ 必须写明：相关则以资料为准并标注来源；无关则不要强行引用", () => {
		const block = buildRecallContext([{ chunkId: "c1", title: "t", content: "c" }]) as string
		expect(block).to.include("必须以此为准")
		expect(block).to.include("(教材: <chunk_id>)")
		expect(block).to.include("不要强行引用")
	})

	it("★ 默认最多 3 条（多送也只取 3）", () => {
		const items = Array.from({ length: 6 }, (_, i) => ({ chunkId: `c${i}`, title: `t${i}`, content: `内容 ${i}` }))
		const block = buildRecallContext(items) as string
		expect(block.includes("教材#c0")).to.equal(true)
		expect(block.includes("教材#c2")).to.equal(true)
		expect(block.includes("教材#c3")).to.equal(false)
	})

	it("★ limit 可显式调小（该条之后的都不进上下文）", () => {
		const items = [
			{ chunkId: "a", title: "A", content: "aaa" },
			{ chunkId: "b", title: "B", content: "bbb" },
		]
		const block = buildRecallContext(items, { limit: 1 }) as string
		expect(block.includes("教材#a")).to.equal(true)
		expect(block.includes("教材#b")).to.equal(false)
	})

	it("★ 单条正文被截断到 500 字（防一条撑爆预算）", () => {
		const long = "字".repeat(1200)
		const block = buildRecallContext([{ chunkId: "c1", title: "长", content: long }]) as string
		const line = block.split("\n").find((l) => l.includes("教材#c1")) as string
		// [教材#c1｜长] + 500 字 + …
		expect(line.length <= 500 + 20).to.equal(true)
		expect(line.endsWith("…")).to.equal(true)
	})

	it("★ 预算总量不超过上限（默认 1600）", () => {
		const items = Array.from({ length: 3 }, (_, i) => ({
			chunkId: `c${i}`,
			title: `标题${i}`,
			content: "x".repeat(500),
		}))
		const block = buildRecallContext(items) as string
		expect(block.length < MAX_RECALL_CHARS + 400).to.equal(true)
	})

	it("★ 重复条目（同 chunkId + 同标题）只保留一条", () => {
		const dup = { chunkId: "c1", title: "同一条", content: "内容" }
		const block = buildRecallContext([dup, dup]) as string
		expect(block.split("教材#c1").length - 1).to.equal(1)
	})

	it("★ 空标题也能用（只有 chunk_id 时仍然可引用）", () => {
		const block = buildRecallContext([{ chunkId: 42, title: "", content: "正文" }]) as string
		expect(block).to.include("教材#42")
	})
})
