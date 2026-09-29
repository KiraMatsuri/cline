/**
 * 验证 dist/mcp-wiki-server.js 与后端联调（JSON-RPC over stdio）
 *
 * 用法：
 *   cd d:\cline
 *   node esbuild.mjs
 *   SERVER=http://127.0.0.1:4001 WEEK=5 node scripts/verify-mcp-wiki-server.mjs
 *
 * 可选：MCP_RUNTIME 覆盖运行时（默认 process.execPath 即 node）。
 *   验证真实宿主链路时用：
 *   MCP_RUNTIME="C:\Users\<user>\AppData\Local\Programs\Microsoft VS Code\Code.exe"
 *   脚本会为子进程注入 ELECTRON_RUN_AS_NODE=1（对 node.exe 无副作用）。
 */
import { spawn } from "node:child_process"
import readline from "node:readline"

const SERVER = process.env.SERVER || "http://127.0.0.1:4001"
const WEEK = Number(process.env.WEEK || 5)
const RUNTIME = process.env.MCP_RUNTIME || process.execPath

let pass = 0
let fail = 0
const check = (name, cond, detail = "") => {
	if (cond) {
		pass++
		console.log(`  ✅ ${name}`)
	} else {
		fail++
		console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`)
	}
}

/**
 * 启动一个 MCP server 子进程并返回一个 JSON-RPC 调用器。
 * 刻意用 ELECTRON_RUN_AS_NODE=1：真实链路里 McpHub 就是这么拉起它的，
 * 而 node.exe 会忽略这个变量，因此同一个脚本两种运行时都能用。
 */
function connect(serverUrl, week) {
	const child = spawn(RUNTIME, ["dist/mcp-wiki-server.js", "--week", String(week), "--server", serverUrl], {
		cwd: process.cwd(),
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
		stdio: ["pipe", "pipe", "inherit"],
	})

	const pending = new Map()
	const rl = readline.createInterface({ input: child.stdout })
	rl.on("line", (line) => {
		try {
			const msg = JSON.parse(line)
			if (msg.id && pending.has(msg.id)) {
				pending.get(msg.id)(msg)
				pending.delete(msg.id)
			}
		} catch {
			/* 忽略非 JSON 行 */
		}
	})

	let idSeq = 1
	const rpc = (method, params, timeoutMs = 8000) =>
		new Promise((resolve) => {
			const id = idSeq++
			pending.set(id, resolve)
			child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
			setTimeout(() => {
				if (pending.has(id)) {
					pending.delete(id)
					resolve({ error: { message: "timeout" } })
				}
			}, timeoutMs)
		})

	const handshake = async () => {
		await rpc("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "verify", version: "0" },
		})
		child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n")
	}

	const close = () => {
		rl.close()
		child.kill()
	}

	return { rpc, handshake, close }
}

const toolPayload = (r) => {
	try {
		return JSON.parse(r?.result?.content?.[0]?.text ?? "{}")
	} catch {
		return {}
	}
}

console.log(`\n=== verify-mcp-wiki-server (week=${WEEK}, server=${SERVER}) ===`)
console.log(`    runtime = ${RUNTIME}\n`)

const main = connect(SERVER, WEEK)
await main.handshake()

// ---- tools/list ----
{
	const r = await main.rpc("tools/list", {})
	const names = (r.result?.tools ?? []).map((t) => t.name).sort()
	check(
		"暴露三个工具",
		JSON.stringify(names) === JSON.stringify(["list_wiki_weeks", "read_wiki_chunk", "search_wiki"]),
		JSON.stringify(names),
	)

	const allProps = (r.result?.tools ?? []).flatMap((t) => Object.keys(t.inputSchema?.properties ?? {}))
	check("★ 工具参数中不含任何周数字段", !allProps.some((p) => /week/i.test(p)), JSON.stringify(allProps))
}

// ---- search_wiki ----
let firstId = null
let futureId = null
{
	const r = await main.rpc("tools/call", { name: "search_wiki", arguments: { query: "" } })
	const payload = toolPayload(r)
	check("search_wiki 返回 ok", payload.ok === true, JSON.stringify(payload).slice(0, 120))
	// 先确认非空：否则下面的“不越界”断言会因为空数组而空跑通过（后端不可达时就会发生）
	check("search_wiki 返回非空（库中应有资料）", (payload.data ?? []).length > 0, `count=${payload.data?.length}`)
	const over = (payload.data ?? []).filter((d) => d.applicable_week > WEEK)
	check(`★ search_wiki 结果不越过第 ${WEEK} 周`, (payload.data ?? []).length > 0 && over.length === 0, `${over.length} 条越界`)
	firstId = payload.data?.[0]?.id ?? null
}

// ---- read_wiki_chunk ----
{
	if (firstId) {
		const r = await main.rpc("tools/call", { name: "read_wiki_chunk", arguments: { chunk_id: firstId } })
		const payload = toolPayload(r)
		check("read_wiki_chunk 取到内容", payload.ok === true && typeof payload.data?.content === "string")
	} else {
		console.log("  ⏭  库中无资料，跳过 read_wiki_chunk")
	}
	const r2 = await main.rpc("tools/call", { name: "read_wiki_chunk", arguments: { chunk_id: "__nope__" } })
	const p2 = toolPayload(r2)
	check(
		"不存在的 chunk → not_found_or_out_of_scope（spec §6）",
		p2.error === "not_found_or_out_of_scope",
		JSON.stringify(p2).slice(0, 140),
	)
}

// ---- list_wiki_weeks ----
{
	const r = await main.rpc("tools/call", { name: "list_wiki_weeks", arguments: {} })
	const payload = toolPayload(r)
	check("list_wiki_weeks 返回数组", Array.isArray(payload.data))
	check("list_wiki_weeks 返回非空", (payload.data ?? []).length > 0, `count=${payload.data?.length}`)
	const over = (payload.data ?? []).filter((w) => w.week > WEEK)
	check("★ 周数列表不越过当前周", (payload.data ?? []).length > 0 && over.length === 0)
}

// ---- ★ 边界判别力：同一关键词在不同 week 下结果集必须不同 ----
//
// 只断言“≤5 周”是不够的 —— 当后端不可达时返回空数组，该断言会**空跑通过**。
// 这里用 week=3 / week=18 两次请求互相夹逼，证明边界是真在过滤：
//   ① week=3 非空（否则下一条断言没意义）
//   ② week=18 存在 >3 周的条目（否则“week=3 无越界”平凡成立）
//   ③ 两次结果集不同（直接证明过滤生效）
{
	const QUERY = "函数"
	const w3 = connect(SERVER, 3)
	await w3.handshake()
	const p3 = toolPayload(await w3.rpc("tools/call", { name: "search_wiki", arguments: { query: QUERY, limit: 10 } }))
	w3.close()

	const w18 = connect(SERVER, 18)
	await w18.handshake()
	const p18 = toolPayload(await w18.rpc("tools/call", { name: "search_wiki", arguments: { query: QUERY, limit: 10 } }))
	w18.close()

	const maxOf = (p) => Math.max(0, ...(p.data ?? []).map((d) => d.applicable_week))
	const ids = (p) => JSON.stringify((p.data ?? []).map((d) => d.id))

	check(`week=3 检索 "${QUERY}" 非空`, (p3.data ?? []).length > 0, `count=${p3.data?.length}`)
	check(`week=18 结果中存在 >3 周的条目（证明库中有后续周资料）`, maxOf(p18) > 3, `max=${maxOf(p18)}`)
	check(`★ 同一关键词：week=3 时无越界条目`, (p3.data ?? []).every((d) => d.applicable_week <= 3))
	check(`★ 判别力：week=3 与 week=18 结果集不同`, ids(p3) !== ids(p18))

	futureId = p18.data?.[0]?.id ?? null
}

// ---- ★ 越界读取：真实存在的 chunk、但在当前周之前 → 必须按 spec §6 拒绝 ----
{
	if (futureId) {
		const r = await main.rpc("tools/call", { name: "read_wiki_chunk", arguments: { chunk_id: futureId } })
		const payload = toolPayload(r)
		check(
			`★ 越界读取真实 chunk（第 18 周）→ not_found_or_out_of_scope`,
			payload.error === "not_found_or_out_of_scope",
			JSON.stringify(payload).slice(0, 140),
		)
	} else {
		console.log("  ⏭  未能取得第 18 周的 chunk id，跳过越界读取断言")
	}
}

main.close()

// ---- 后端不可达时的容错 ----
{
	const bad = connect("http://127.0.0.1:59999", 5)
	await bad.handshake()
	const r = await bad.rpc("tools/call", { name: "search_wiki", arguments: { query: "a" } }, 9000)
	const payload = toolPayload(r)
	check("后端不可达 → 返回 error 而非崩溃", typeof payload.error === "string", JSON.stringify(payload).slice(0, 120))
	bad.close()
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`)

// 用 exitCode 而非 process.exit()：Node 24 + Windows 下若仍有未收敛的 stdio handle，
// process.exit() 会触发 libuv 断言崩溃（Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)），
// 使退出码变得不可用。让事件循环自然退出更稳。
process.exitCode = fail === 0 ? 0 : 1
