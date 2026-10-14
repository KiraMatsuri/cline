/**
 * G4 · P4 优先级综合测试（L2 层）—— **方言归一化的端到端判别力**
 *
 * 覆盖 plan-2 §0 的四类检查：正常路径 / 边界条件 / 回归 / 核心流程可跑通。
 * P4 范围：仅 F12（把模型的 DSML 方言归一化为规范 XML）。
 *
 * 与其他 G 门禁的区别（有意）：G0–G3 已各自复刻了「6 例监控/管理器统一模板」，
 * 本门禁**不**再复刻（避免第四份同义重复），而是只断言 F12 自身的判别力与接线不变量。
 *
 * ⚠️ **诚实声明**：④ 是**结构守卫（变更探测器）**，不是端到端验证 —— 它只证明"接线挂着"，
 * 真实运行行为需要 F5 手动用例 M14'（让模型复现方言回合，观察工具是否真实执行）。
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { parseAssistantMessageV2 } from "@core/assistant-message"
import { normalizeAssistantDialect } from "@core/assistant-message/dialectNormalize"
import { expect } from "chai"

const P = "\uFF5C"
const M = `${P}${P}DSML${P}${P}`

/** S1：实测 Task `1791721646283` msg#2（纯方言；原来 3 次全部解析失败 ⇒ M1 整轮作废） */
const S1 = [
	`<${M} calls>`,
	`<${M} invoke name="use_mcp_tool">`,
	`<${M} parameter name="server_name">wiki</${M} parameter>`,
	`<${M} parameter name="tool_name" string="true">list_wiki_weeks</${M} parameter>`,
	`<${M} parameter name="arguments">{}<` + `/${M} parameter>`,
	`</${M} invoke>`,
	`</${M} calls>`,
].join("\n")

/** S3：实测 Task `1791721915982` msg#8（半畸形：开标签 XML / 闭标签方言 / 缺 invoke 开标签） */
const S3 = [
	"我确认一下当前进度内可用的循环与条件语法资料。",
	"",
	"<use_mcp_tool>",
	`<server_name>wiki</${M} parameter>`,
	`<parameter name="tool_name">search_wiki</${M} parameter>`,
	`<${M} parameter name="arguments" string="true">{"query": "for 循环 遍历列表", "limit": 5}</${M} parameter>`,
	`</${M} invoke>`,
	`</${M} calls>`,
].join("\n")

/** S4：实测 Task `1791721915982` msg#6（方言包裹层 + 合法 XML 混排） */
const S4 = [
	`<${M} calls>`,
	"<use_mcp_tool>",
	"<server_name>wiki</server_name>",
	"<tool_name>read_wiki_chunk</tool_name>",
	"<arguments>",
	'{ "chunk_id": "textbook_python/6__chunk3" }',
	"</arguments>",
	"</use_mcp_tool>",
].join("\n")

interface ParsedToolUse {
	type: "tool_use"
	name: string
	params: Record<string, string>
	partial?: boolean
}
const toolUses = (text: string): ParsedToolUse[] =>
	parseAssistantMessageV2(text).filter((b) => b.type === "tool_use") as ParsedToolUse[]

describe("G4 · 优先级综合（方言归一化端到端）", () => {
	it("【G4-①】判别力：S1 归一化后**真的**产出 tool_use；不归一化则产不出", () => {
		// 反向对照 —— 证明改动有效，而不是"本来就通过"
		expect(toolUses(S1), "未归一化时不应解析出任何工具调用").to.have.length(0)

		const call = toolUses(normalizeAssistantDialect(S1)).find((t) => t.name === "use_mcp_tool")
		expect(call, "归一化后必须解析出 use_mcp_tool").to.not.equal(undefined)
		expect(call?.params.tool_name).to.equal("list_wiki_weeks")
		expect(call?.partial).to.equal(false)
	})

	it("【G4-②】回归：合法 XML / 普通正文在归一化前后**解析结果完全一致**", () => {
		const normal = [
			"我先看资料。",
			"<use_mcp_tool>",
			"<server_name>wiki</server_name>",
			"<tool_name>list_wiki_weeks</tool_name>",
			"<arguments>{}</arguments>",
			"</use_mcp_tool>",
		].join("\n")
		expect(normalizeAssistantDialect(normal)).to.equal(normal) // 恒等
		expect(parseAssistantMessageV2(normalizeAssistantDialect(normal))).to.deep.equal(parseAssistantMessageV2(normal))
	})

	it("【G4-③】三条真实样本全部可解析，且归一化结果不再含方言残渣", () => {
		for (const [label, sample, expectedTool] of [
			["S1", S1, "use_mcp_tool"],
			["S3", S3, "use_mcp_tool"],
			["S4", S4, "use_mcp_tool"],
		] as const) {
			const out = normalizeAssistantDialect(sample)
			expect(out, `${label} 不应残留全角竖线`).to.not.include(P)
			expect(
				toolUses(out).some((t) => t.name === expectedTool),
				`${label} 应解析出 ${expectedTool}`,
			).to.equal(true)
		}
	})

	it("【G4-④】结构守卫（**变更探测器**）：接线挂着，且**持久化副本不经归一化**", () => {
		const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")
		// 归一化只作用于 parseAssistantMessageV2 的输入
		expect(taskSrc).to.include("parseAssistantMessageV2(normalizeAssistantDialect(assistantMessage))")
		expect(taskSrc).to.include("normalizeAssistantDialect(assistantMessage)") // 传入的是完整原文
		// 写进 apiConversationHistory 的那份（assistantTextOnly）**不得**被归一化 —— 历史保留模型原文
		expect(taskSrc).to.include("assistantTextOnly += chunk.text")
		expect(taskSrc.includes("normalizeAssistantDialect(assistantTextOnly)")).to.equal(false)
	})

	it("【G4-⑤】边界：正文与 content 里的全角竖线一字不动；无名外壳不臆造工具调用", () => {
		const body = `<content>\nprint("${P}${P}")\n</content>`
		expect(normalizeAssistantDialect(body)).to.equal(body)

		const onlyWrap = `<${M} calls>\n</${M} calls>`
		expect(normalizeAssistantDialect(onlyWrap).trim()).to.equal("")
		expect(toolUses(normalizeAssistantDialect(onlyWrap))).to.have.length(0)
	})
})
