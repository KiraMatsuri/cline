/**
 * wiki-mcp-server — 课程资料检索的 MCP server（stdio）（v2.13）
 *
 * 职责（单一）：把插件注入的 currentWeek 拼到检索请求上，转发给教学后端。
 * 它**不做**回答生成、**不做**边界判定（边界由后端 SQL 强制）。
 *
 * 启动：node dist/mcp-wiki-server.js --week 5 --server http://host:4001
 * 设计文档：docs/design/wiki-mcp-retrieval-design.md
 *
 * ⚠️ stdio 传输下 **stdout 是协议通道**：任何调试输出都必须走 stderr，
 *    否则会污染 JSON-RPC 流导致客户端解析失败。
 * ⚠️ 这里刻意不使用顶层 await：构建产物是 CJS（esbuild format: "cjs"），
 *    顶层 await 在 CJS 下不被支持。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { parseMcpArgs } from "./mcp/args"
import { callListWeeks, callReadChunk, callSearchWiki } from "./mcp/wikiBackend"

const { week, serverUrl } = parseMcpArgs(process.argv.slice(2))

const server = new Server({ name: "wiki", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "search_wiki",
			description:
				"在课程资料库中按关键词检索。只返回当前教学周之前（含）已发布的资料。若返回 0 条，说明该知识点尚未在当前教学进度内发布 —— 此时不要展开讲解其具体用法，应告知其所属周次并给出当前进度内的相关基础。",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "检索关键词，如 '列表' '函数'" },
					limit: { type: "number", description: "最多返回条数，默认 5，最大 10" },
				},
				required: ["query"],
			},
		},
		{
			name: "read_wiki_chunk",
			description: "读取某个资料块的完整内容。仅当该资料在当前教学周或更早发布时才可读取。",
			inputSchema: {
				type: "object",
				properties: { chunk_id: { type: "string", description: "search_wiki 返回的 id" } },
				required: ["chunk_id"],
			},
		},
		{
			name: "list_wiki_weeks",
			description: "列出当前可访问的教学周及其资料数量。",
			inputSchema: { type: "object", properties: {} },
		},
	],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const name = req.params.name
	const args = (req.params.arguments ?? {}) as Record<string, unknown>

	try {
		if (!serverUrl) {
			return { content: [{ type: "text", text: JSON.stringify({ error: "wiki_backend_not_configured" }) }] }
		}
		if (name === "search_wiki") {
			const r = await callSearchWiki(serverUrl, week, String(args.query ?? ""), Number(args.limit ?? 5))
			return { content: [{ type: "text", text: JSON.stringify(r) }] }
		}
		if (name === "read_wiki_chunk") {
			const r = await callReadChunk(serverUrl, week, String(args.chunk_id ?? ""))
			return { content: [{ type: "text", text: JSON.stringify(r) }] }
		}
		if (name === "list_wiki_weeks") {
			const r = await callListWeeks(serverUrl, week)
			return { content: [{ type: "text", text: JSON.stringify(r) }] }
		}
		return { content: [{ type: "text", text: JSON.stringify({ error: `unknown_tool: ${name}` }) }] }
	} catch (e) {
		// 工具失败不得中断学生对话：返回结构化错误，模型可继续作答
		return {
			content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }],
		}
	}
})

async function main(): Promise<void> {
	await server.connect(new StdioServerTransport())
}

main().catch((e) => {
	// stdout 是协议通道，只能写 stderr
	process.stderr.write(`[wiki-mcp] 启动失败: ${e instanceof Error ? e.message : String(e)}\n`)
	process.exit(1)
})
