/**
 * wiki-mcp-server — 课程资料检索的 MCP server（stdio）（v3：去周数）
 *
 * 职责（单一）：把检索请求转发给教学后端，后端按**相关度**在**全部已发布资料**中检索。
 * 它**不做**回答生成、**不做**边界判定。资料是否对当前提问有用，交给模型按召回结果自行判断。
 *
 * 启动：node dist/mcp-wiki-server.js --server http://host:4001
 * 设计文档：docs/design/teaching-modes-and-behavior-metrics-design.md §3
 *
 * 【v3 变更】不再有 `--week` / `--week-file`：
 *   - 「第 x 周」已从学生端整体移除，检索范围不再随周推进而放宽 —— 一开始就是全部；
 *   - 旧的周状态文件（`teaching-week.json`）**不再被读取**，也不主动删除（不动学生文件）。
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
import { LIST_WIKI_WEEKS_DESCRIPTION, READ_WIKI_CHUNK_DESCRIPTION, SEARCH_WIKI_DESCRIPTION } from "./mcp/wikiToolDescriptions"

const { serverUrl } = parseMcpArgs(process.argv.slice(2))

const server = new Server({ name: "wiki", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "search_wiki",
			description: SEARCH_WIKI_DESCRIPTION,
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
			description: READ_WIKI_CHUNK_DESCRIPTION,
			inputSchema: {
				type: "object",
				properties: { chunk_id: { type: "string", description: "search_wiki 返回的 id" } },
				required: ["chunk_id"],
			},
		},
		{
			name: "list_wiki_weeks",
			description: LIST_WIKI_WEEKS_DESCRIPTION,
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
			const r = await callSearchWiki(serverUrl, String(args.query ?? ""), Number(args.limit ?? 5))
			return { content: [{ type: "text", text: JSON.stringify(r) }] }
		}
		if (name === "read_wiki_chunk") {
			const r = await callReadChunk(serverUrl, String(args.chunk_id ?? ""))
			return { content: [{ type: "text", text: JSON.stringify(r) }] }
		}
		if (name === "list_wiki_weeks") {
			const r = await callListWeeks(serverUrl)
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
