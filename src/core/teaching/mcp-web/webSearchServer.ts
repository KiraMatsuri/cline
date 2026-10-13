/**
 * web-search-mcp-server — 联网检索的 MCP server（stdio）（F8）
 *
 * 职责（单一）：把 `web_search` 工具调用转发给**教学后端**的检索端点，并把结果格式化为纯文本。
 * 它**不做**回答生成、**不做**内容安全判定（由后端集中管控）。
 *
 * 启动：node dist/mcp-web-search-server.js --server http://host:4001 [--endpoint /api/v1/web-search]
 *
 * ── D1/D2 取舍（本任务实现 D1）──────────────────────────────────────────────
 * D1（本任务实现）：MCP server 调**教学后端**的检索端点（`GET {server}{endpoint}?q=…&limit=…`）。
 *   理由：与本项目既有原则一致 —— **API Key 归属教师、内容安全与成本集中在后端管控**
 *   （参照 v1.0.5 起"后端 llm-env 拒绝 apiKey、永不覆盖教师密钥"的既有做法）。
 * D2（备选，本任务不做）：MCP server 直连第三方搜索 API（Tavily/SerpAPI/Bing…），key 放插件设置。
 *   缺点：key 与学生身份/课堂场景解耦、内容安全在客户端、需新引第三方依赖。
 *
 * ⚠️ **后端端点在 `d:\cline` 仓库之外，尚未实现** ⇒ 端点缺失/不可达/超时/响应畸形时必须返回
 *    **结构化错误 JSON** 且**不阻断对话**（这正是规格 F8 的硬要求）。端点路径做成**可配置参数**
 *    （`--endpoint`，缺省 `/api/v1/web-search`），将来后端落地或换成第三方 API 时无需改扩展代码。
 *
 * ── 后续跟进 ────────────────────────────────────────────────────────────────
 * 本任务**只暴露 `web_search` 一个工具**。`web_fetch`（抓取任意 URL）有 SSRF 面，**本任务不做**，
 * 留待后续在**后端侧**做白名单/域名校验后再开放。
 *
 * ⚠️ stdio 传输下 **stdout 是协议通道**：任何调试输出都必须走 stderr
 *    （`console.error` / `process.stderr.write`），否则会污染 JSON-RPC 流导致客户端解析失败。
 * ⚠️ 这里刻意不使用顶层 await：构建产物是 CJS（esbuild format: "cjs"），顶层 await 在 CJS 下不被支持。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { fetch } from "@/shared/net"
import { parseMcpArgs } from "../mcp/args"
import { buildWebSearchError, parseWebSearchResults } from "./webSearchPayload"
import { WEB_SEARCH_DESCRIPTION, WEB_SEARCH_RESULT_HEADER } from "./webToolDescriptions"

/** 缺省检索端点（可被 `--endpoint` 覆盖，见文件头 D1 说明） */
const DEFAULT_ENDPOINT = "/api/v1/web-search"
/** 8s 超时：外部检索慢时就该放弃，绝不拖住学生对话 */
const TIMEOUT_MS = 8_000
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10

/** `--endpoint` 的极简解析（`parseMcpArgs` 不认识它）：归一化为以 `/` 开头 */
function parseEndpointArg(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--endpoint") {
			const raw = String(args[i + 1] ?? "").trim()
			if (!raw) {
				return undefined
			}
			return raw.startsWith("/") ? raw : `/${raw}`
		}
	}
	return undefined
}

const argv = process.argv.slice(2)
// 复用既有 MCP 参数解析：`--server` 与（可选的）`--week-file` 语义完全一致。
// 本 server 用不到 `--week`，不传时 parseMcpArgs 会得 1，无副作用。
const { serverUrl } = parseMcpArgs(argv)
const endpoint = parseEndpointArg(argv) ?? DEFAULT_ENDPOINT

const server = new Server({ name: "web-search", version: "1.0.0" }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "web_search",
			description: WEB_SEARCH_DESCRIPTION,
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "检索关键词（用于校验通用知识，非课程资料）" },
					limit: { type: "number", description: "最多返回条数，默认 5，最大 10" },
				},
				required: ["query"],
			},
		},
	],
}))

/** MCP 文本返回的统一包装 */
function text(s: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: s }] }
}

/** 把后端条目格式化为纯文本：每条给出 标题/摘要/链接，并在开头加外部资料声明 */
function formatResults(results: Array<{ title: string; snippet: string; url: string }>): string {
	if (results.length === 0) {
		return `${WEB_SEARCH_RESULT_HEADER}\n（未检索到相关外部资料）`
	}
	const blocks = results.map((r, i) => `${i + 1}. 标题：${r.title}\n   摘要：${r.snippet}\n   链接：${r.url}`)
	return `${WEB_SEARCH_RESULT_HEADER}\n\n${blocks.join("\n\n")}`
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const name = req.params.name
	const args = (req.params.arguments ?? {}) as Record<string, unknown>

	try {
		if (name !== "web_search") {
			return text(JSON.stringify(buildWebSearchError("bad_response", `unknown_tool: ${name}`)))
		}
		if (!serverUrl) {
			// 未配置后端地址：工具存在但不可用 —— 结构化错误，不阻断对话
			return text(JSON.stringify(buildWebSearchError("backend_unreachable", "未配置 --server")))
		}

		const query = String(args.query ?? "").trim()
		const rawLimit = Math.floor(Number(args.limit ?? DEFAULT_LIMIT))
		const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : DEFAULT_LIMIT, 1), MAX_LIMIT)
		const url = `${serverUrl}${endpoint}?q=${encodeURIComponent(query)}&limit=${limit}`

		const ctrl = new AbortController()
		const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
		try {
			const resp = await fetch(url, { signal: ctrl.signal })
			if (!resp.ok) {
				// 404 → 后端尚无该端点（D1 的前提缺失）；其余非 2xx → 响应不可用
				const code = resp.status === 404 ? "endpoint_missing" : "bad_response"
				return text(JSON.stringify(buildWebSearchError(code, `http_${resp.status}`)))
			}

			let body: unknown
			try {
				body = JSON.parse(await resp.text())
			} catch (e) {
				return text(JSON.stringify(buildWebSearchError("bad_response", e instanceof Error ? e.message : String(e))))
			}

			const results = parseWebSearchResults(body)
			if (results === null) {
				return text(JSON.stringify(buildWebSearchError("bad_response", "响应形状不符合契约")))
			}
			return text(formatResults(results))
		} catch (e) {
			// 超时由 AbortController 触发，表现为 AbortError；据此区分 timeout 与不可达
			const code = ctrl.signal.aborted ? "timeout" : "backend_unreachable"
			return text(JSON.stringify(buildWebSearchError(code, e instanceof Error ? e.message : String(e))))
		} finally {
			clearTimeout(timer)
		}
	} catch (e) {
		// 工具失败不得中断学生对话：返回结构化错误，模型可继续作答
		return text(JSON.stringify(buildWebSearchError("bad_response", e instanceof Error ? e.message : String(e))))
	}
})

async function main(): Promise<void> {
	await server.connect(new StdioServerTransport())
}

main().catch((e) => {
	// stdout 是协议通道，只能写 stderr
	process.stderr.write(`[web-search-mcp] 启动失败: ${e instanceof Error ? e.message : String(e)}\n`)
	process.exit(1)
})
