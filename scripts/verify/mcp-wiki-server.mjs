/**
 * 闸门：MCP wiki server 的 stdio 协议契约（v3 去周数）
 *
 * 为什么要单独跑：`mcp-wiki-server.ts` 是 stdio 入口，import 它会真的启动一个进程，
 * 所以单测只能断言到 description 文本；"工具是否真的注册上、参数 schema 里还有没有 week、
 * 后端不可达时是否返回结构化错误而不是崩掉" 只有把进程拉起来才测得到。
 *
 * 用法：node scripts/verify/mcp-wiki-server.mjs
 * 退出码：0 全通过 / 1 有失败
 *
 * 依赖：先 `node esbuild.mjs` 产出 dist/mcp-wiki-server.js。
 */

import { spawn } from "node:child_process"
import { createServer } from "node:http"
import path from "node:path"

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..")
const SERVER_JS = path.join(REPO_ROOT, "dist", "mcp-wiki-server.js")

let pass = 0
let fail = 0
const failures = []

function check(ok, label, detail) {
	if (ok) {
		pass++
		console.log(`  ok  ${label}`)
	} else {
		fail++
		failures.push(label)
		console.log(`  NOT OK  ${label}${detail ? ` — ${detail}` : ""}`)
	}
}

function eq(actual, expected, label) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	check(ok, label, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// ---------------------------------------------------------------------------
// 1. 后端 stub：模拟教学端 /api/v1/wiki/*
// ---------------------------------------------------------------------------
const stub = createServer((req, res) => {
	const url = new URL(req.url, "http://127.0.0.1")
	res.setHeader("content-type", "application/json; charset=utf-8")
	if (url.pathname === "/api/v1/wiki/search") {
		const q = url.searchParams.get("q") ?? ""
		// 关键断言点：请求里不得出现 max_week / week
		const leaked = [...url.searchParams.keys()].filter((k) => k === "week" || k === "max_week")
		res.end(
			JSON.stringify({
				ok: true,
				count: 1,
				data: [{ id: "c1", title: `命中:${q}`, content: "正文", applicable_week: 9 }],
				leaked_week_params: leaked,
			}),
		)
		return
	}
	if (url.pathname === "/api/v1/wiki/chunk") {
		res.end(JSON.stringify({ ok: true, data: { id: url.searchParams.get("chunk_id"), content: "全文" } }))
		return
	}
	if (url.pathname === "/api/v1/wiki/weeks") {
		res.end(JSON.stringify({ ok: true, count: 1, data: [{ week: 3, count: 2 }] }))
		return
	}
	res.statusCode = 404
	res.end(JSON.stringify({ reason: "not_found_or_out_of_scope" }))
})

// ---------------------------------------------------------------------------
// 2. MCP 客户端（最小 JSON-RPC over stdio）
// ---------------------------------------------------------------------------
class McpClient {
	constructor(proc) {
		this.proc = proc
		this.buffer = ""
		this.nextId = 1
		this.pending = new Map()
		this.stderr = ""
		proc.stdout.setEncoding("utf-8")
		proc.stdout.on("data", (chunk) => this._onData(chunk))
		proc.stderr.setEncoding("utf-8")
		proc.stderr.on("data", (chunk) => {
			this.stderr += chunk
		})
	}

	_onData(chunk) {
		this.buffer += chunk
		// 按行切分（MCP stdio 是 newline-delimited JSON）
		let idx = this.buffer.indexOf("\n")
		while (idx >= 0) {
			const line = this.buffer.slice(0, idx).trim()
			this.buffer = this.buffer.slice(idx + 1)
			if (line) {
				try {
					const msg = JSON.parse(line)
					if (msg.id != null && this.pending.has(msg.id)) {
						const { resolve, reject } = this.pending.get(msg.id)
						this.pending.delete(msg.id)
						if (msg.error) reject(new Error(JSON.stringify(msg.error)))
						else resolve(msg.result)
					}
				} catch {
					// 非协议输出（不该有）：忽略
				}
			}
			idx = this.buffer.indexOf("\n")
		}
	}

	request(method, params = {}) {
		const id = this.nextId++
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
		const p = new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject })
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id)
					reject(new Error(`timeout: ${method}`))
				}
			}, 5000)
		})
		this.proc.stdin.write(payload)
		return p
	}

	async notify(method, params = {}) {
		this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
	}
}

function textOf(result) {
	const block = result?.content?.[0]
	return block && block.type === "text" ? block.text : ""
}

async function main() {
	// 先起 stub
	await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve))
	const port = stub.address().port
	const serverUrl = `http://127.0.0.1:${port}`

	// 再起 MCP server 子进程（只传 --server，模拟 v3 的真实启动参数）
	const proc = spawn(process.execPath, [SERVER_JS, "--server", serverUrl], {
		stdio: ["pipe", "pipe", "pipe"],
	})
	const client = new McpClient(proc)
	const exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)))

	try {
		// ---- 1) 握手 ----
		const init = await client.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "gate", version: "1.0.0" },
		})
		check(!!init?.serverInfo, "initialize 返回 serverInfo", JSON.stringify(init?.serverInfo))
		eq(init?.serverInfo?.name, "wiki", "serverInfo.name = wiki")
		await client.notify("notifications/initialized")

		// ---- 2) 工具清单 ----
		const list = await client.request("tools/list")
		const names = (list?.tools ?? []).map((t) => t.name)
		eq(names, ["search_wiki", "read_wiki_chunk", "list_wiki_weeks"], "注册了三个只读工具")

		const searchTool = list.tools.find((t) => t.name === "search_wiki")
		const searchProps = Object.keys(searchTool?.inputSchema?.properties ?? {})
		eq(searchProps, ["query", "limit"], "search_wiki 参数只有 query/limit（无 week）")
		eq(searchTool?.inputSchema?.required, ["query"], "search_wiki 必填 query")
		check(
			!JSON.stringify(list.tools).includes("max_week"),
			"工具 schema 里没有 max_week 残留",
			JSON.stringify(list.tools).slice(0, 200),
		)
		check(
			!Object.keys(searchTool?.inputSchema?.properties ?? {}).includes("week"),
			"search_wiki 没有 week 参数",
		)

		// ---- 3) search_wiki 正常路径 ----
		const r1 = await client.request("tools/call", { name: "search_wiki", arguments: { query: "列表", limit: 3 } })
		const body1 = JSON.parse(textOf(r1))
		eq(body1.ok, true, "search_wiki 回包 ok=true")
		eq(body1.data?.[0]?.title, "命中:列表", "query 透传到后端")
		eq(body1.leaked_week_params, [], "转发给后端的请求不带 week/max_week")

		// ---- 4) limit 夹取（后端收到的 limit 应在 1..10） ----
		const r2 = await client.request("tools/call", { name: "search_wiki", arguments: { query: "x", limit: 999 } })
		check(textOf(r2).includes("命中:x"), "limit 超上限仍能正常返回")

		// ---- 5) 缺 query 不崩：返回结构化结果而不是崩溃 ----
		const r3 = await client.request("tools/call", { name: "search_wiki", arguments: {} })
		const body3 = textOf(r3)
		check(typeof body3 === "string" && body3.length > 0, "缺 query 时仍返回文本结果（不崩溃）")

		// ---- 6) read_wiki_chunk / list_wiki_weeks ----
		const r4 = await client.request("tools/call", { name: "read_wiki_chunk", arguments: { chunk_id: "c1" } })
		eq(JSON.parse(textOf(r4)).data?.content, "全文", "read_wiki_chunk 透传 chunk_id")
		const r5 = await client.request("tools/call", { name: "list_wiki_weeks", arguments: {} })
		eq(JSON.parse(textOf(r5)).count, 1, "list_wiki_weeks 返回统计")

		// ---- 7) 未知工具 → 结构化错误 ----
		const r6 = await client.request("tools/call", { name: "nope", arguments: {} })
		check(textOf(r6).includes("unknown_tool"), "未知工具返回结构化错误")

		// ---- 8) 后端不可达 → 结构化错误（不得抛栈/崩溃） ----
		const deadProc = spawn(process.execPath, [SERVER_JS, "--server", "http://127.0.0.1:1"], {
			stdio: ["pipe", "pipe", "pipe"],
		})
		const deadClient = new McpClient(deadProc)
		try {
			await deadClient.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "gate", version: "1.0.0" },
			})
			await deadClient.notify("notifications/initialized")
			const rd = await deadClient.request("tools/call", { name: "search_wiki", arguments: { query: "x" } })
			check(textOf(rd).includes("wiki_backend_unreachable"), "后端不可达时返回 wiki_backend_unreachable")
		} finally {
			deadProc.kill()
		}

		// ---- 9) 不带 --server → 结构化错误，不崩 ----
		const bareProc = spawn(process.execPath, [SERVER_JS], { stdio: ["pipe", "pipe", "pipe"] })
		const bareClient = new McpClient(bareProc)
		try {
			await bareClient.request("initialize", {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "gate", version: "1.0.0" },
			})
			await bareClient.notify("notifications/initialized")
			const rb = await bareClient.request("tools/call", { name: "search_wiki", arguments: { query: "x" } })
			check(textOf(rb).includes("wiki_backend_not_configured"), "缺 --server 时返回 wiki_backend_not_configured")
		} finally {
			bareProc.kill()
		}
	} catch (e) {
		check(false, "闸门执行未抛异常", e instanceof Error ? e.message : String(e))
	} finally {
		proc.kill()
		await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
		stub.close()
	}

	// stdout 只留给结果汇总（子进程已 kill）
	console.log(`\n总计 ${pass + fail} 项断言：通过 ${pass}，失败 ${fail}`)
	if (fail > 0) {
		console.log(`失败项：\n- ${failures.join("\n- ")}`)
		process.exitCode = 1
	}
}

main()
