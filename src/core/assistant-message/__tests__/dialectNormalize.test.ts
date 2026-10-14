import { expect } from "chai"
import { parseAssistantMessageV2 } from ".."
import { normalizeAssistantDialect } from "../dialectNormalize"

/**
 * 【F12】方言（DSML）归一化。
 *
 * 样本**全部取自真实日志**（`%APPDATA%\Code\User\globalStorage\shiinamatsuri.student-teaching-assistant-edu\tasks\`）：
 *   - S1 = Task `1791721646283` msg#2/4/6（纯方言，三次全部解析失败 ⇒ M1 整轮作废）
 *   - S2 = Task `1791721915982` msg#6（方言包裹层 + 合法 XML **混排**，缺 `calls` 闭合）
 *   - S3 = Task `1791721915982` msg#8（半畸形：开标签是 XML、闭标签是方言，且缺 `invoke` 开标签）
 *   - S4 = Task `1791721915982` msg#4（正文 + 方言块，属性带 `string="false"`）
 * `P` = 全角竖线 U+FF5C（方言标记的唯一入口特征）。
 */
const P = "\uFF5C"
const M = `${P}${P}DSML${P}${P}`

const S1 = [
	`<${M} calls>`,
	`<${M} invoke name="use_mcp_tool">`,
	`<${M} parameter name="server_name">wiki</${M} parameter>`,
	`<${M} parameter name="tool_name" string="true">list_wiki_weeks</${M} parameter>`,
	`<${M} parameter name="arguments">{}<` + `/${M} parameter>`,
	`</${M} invoke>`,
	`</${M} calls>`,
].join("\n")

const S2 = [
	`<${M} calls>`,
	"<use_mcp_tool>",
	"<server_name>wiki</server_name>",
	"<tool_name>read_wiki_chunk</tool_name>",
	"<arguments>",
	"{",
	'  "chunk_id": "textbook_python/6__chunk3"',
	"}",
	"</arguments>",
	"</use_mcp_tool>",
].join("\n")

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

const S4 = [
	"我读取一下第 4 周关于列表排序的资料块，确认可用的基础语法。",
	"",
	`<${M} calls>`,
	`<${M} invoke name="use_mcp_tool">`,
	`<${M} parameter name="server_name" string="true">wiki</${M} parameter>`,
	`<${M} parameter name="tool_name" string="true">read_wiki_chunk</${M} parameter>`,
	`<${M} parameter name="arguments" string="false">{"chunk_id": "textbook_python/6__chunk3"}</${M} parameter>`,
	`</${M} invoke>`,
	`</${M} calls>`,
].join("\n")

/** 取出解析结果里的工具调用（断言判别力用，避免"真空通过"） */
interface ParsedToolUse {
	type: "tool_use"
	name: string
	params: Record<string, string>
	partial?: boolean
}
const toolUses = (text: string): ParsedToolUse[] =>
	parseAssistantMessageV2(text).filter((b) => b.type === "tool_use") as ParsedToolUse[]

describe("F12 · 方言归一化", () => {
	it("★ 恒等变换：正常正文与合法 XML 一字不改", () => {
		const ok = "我先看资料。\n<use_mcp_tool>\n<server_name>wiki</server_name>\n</use_mcp_tool>"
		expect(normalizeAssistantDialect(ok)).to.equal(ok)
	})

	it("★ 逐字节恒等：文本含全角竖线但不是方言（例如 content 正文）", () => {
		const body = `<content>\nprint("${P}${P}")\n</content>`
		expect(normalizeAssistantDialect(body)).to.equal(body)
		// 全角竖线但一个标签都不含标记 ⇒ 不得改写任何东西
		expect(normalizeAssistantDialect(`普通说明 ${P} 而已`)).to.equal(`普通说明 ${P} 而已`)
	})

	it("★ 空串 / 无标记文本 → 原样返回", () => {
		expect(normalizeAssistantDialect("")).to.equal("")
		expect(normalizeAssistantDialect("普通正文")).to.equal("普通正文")
	})

	it("★ 实测样本 S1：纯方言 → 规范 XML，且不再含全角竖线", () => {
		const out = normalizeAssistantDialect(S1)
		expect(out).to.include("<use_mcp_tool>")
		expect(out).to.include("<server_name>wiki</server_name>")
		expect(out).to.include("<tool_name>list_wiki_weeks</tool_name>")
		expect(out).to.include("<arguments>{}</arguments>")
		expect(out).to.include("</use_mcp_tool>")
		expect(out).to.not.include(P)
	})

	it("★ 判别力（端到端）：S1 归一化后**真的**产出 tool_use；不归一化则产不出", () => {
		// 反向对照：证明改动有效，而不是"本来就通过"
		expect(toolUses(S1)).to.have.length(0)
		expect(toolUses(S1).some((t) => t.name === "use_mcp_tool")).to.equal(false)

		const parsed = parseAssistantMessageV2(normalizeAssistantDialect(S1))
		const call = parsed.find((b) => b.type === "tool_use" && b.name === "use_mcp_tool")
		expect(call, "归一化后必须能解析出 use_mcp_tool").to.not.equal(undefined)
		expect((call as { params: Record<string, string> }).params.tool_name).to.equal("list_wiki_weeks")
		expect((call as { params: Record<string, string> }).params.server_name).to.equal("wiki")
		expect((call as { partial?: boolean }).partial).to.equal(false)
	})

	it("★ 实测样本 S2：方言包裹层 + 合法 XML 混排 → 剥掉包裹层，XML 块保持可解析", () => {
		const out = normalizeAssistantDialect(S2)
		expect(out).to.not.include(P)
		expect(out.trim().startsWith("<use_mcp_tool>")).to.equal(true)
		expect(toolUses(out).some((t) => t.name === "use_mcp_tool")).to.equal(true)
	})

	it("★ 实测样本 S3：半畸形（开标签 XML、闭标签方言、缺 invoke 开标签）→ 全参数可解析", () => {
		const out = normalizeAssistantDialect(S3)
		expect(out).to.not.include(P)
		expect(out).to.include("我确认一下当前进度内可用的循环与条件语法资料。") // 正文一字不动
		const call = toolUses(out).find((t) => t.name === "use_mcp_tool") as { params: Record<string, string> } | undefined
		expect(call, "S3 必须能解析出工具调用").to.not.equal(undefined)
		expect(call?.params.server_name).to.equal("wiki")
		expect(call?.params.tool_name).to.equal("search_wiki")
		expect(call?.params.arguments).to.equal(`{"query": "for 循环 遍历列表", "limit": 5}`)
	})

	it("★ 实测样本 S4：正文 + 方言块（属性含 string）→ 参数值与 JSON 逐字保留", () => {
		const out = normalizeAssistantDialect(S4)
		expect(out).to.not.include(P)
		const call = toolUses(out).find((t) => t.name === "use_mcp_tool") as { params: Record<string, string> } | undefined
		expect(call).to.not.equal(undefined)
		expect(call?.params.tool_name).to.equal("read_wiki_chunk")
		expect(call?.params.arguments).to.equal(`{"chunk_id": "textbook_python/6__chunk3"}`)
	})

	it("★ 不得凭空造出工具调用：只有包裹层 / 无名外壳时 → 不产出标签", () => {
		const onlyWrap = `<${M} calls>\n</${M} calls>`
		expect(normalizeAssistantDialect(onlyWrap).trim()).to.equal("")
		const namelessInvoke = `<${M} calls>\n<${M} invoke>\n</${M} calls>`
		expect(normalizeAssistantDialect(namelessInvoke).trim()).to.equal("")
		// 未知工具名同样不得产出标签（`foo` 不是任何工具）
		const unknown = `<${M} calls>\n<${M} invoke name="foo_bar">\n</${M} calls>`
		expect(normalizeAssistantDialect(unknown).trim()).to.equal("")
	})

	it("★ 方言区域外的孤立闭合标记不得提前闭合正常块（防截断学生文件内容）", () => {
		const body = [
			"<write_to_file>",
			"<path>a.txt</path>",
			"<content>hello</content>",
			`</${M} invoke>`, // 孤立残渣（实测有此类尾部残留）
			"</write_to_file>",
		].join("\n")
		const out = normalizeAssistantDialect(body)
		// 残渣被丢弃，且**没有**在 content 之前插入 </write_to_file>
		expect(out).to.include("<write_to_file>")
		expect(out.indexOf("</write_to_file>")).to.be.greaterThan(out.indexOf("<content>"))
		expect(out).to.equal(body.replace(`\n</${M} invoke>`, ""))
	})
})
