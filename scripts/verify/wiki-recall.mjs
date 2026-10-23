/**
 * 闸门：P0-3 预召回（扩展侧纯函数 × 真实教学端检索）
 *
 * 为什么不用单测替代：单测里 `buildRecallContext` 的输入是我手写的假片段，
 * 而这条链路的真实风险在**跨仓库**——扩展发出的 query / 参数是否和后端 SQL 对得上、
 * 命中后的字段名（id/title/content）是否一致。所以这里起一个真 teaching-server，
 * 塞真 chunk，走真 HTTP，再把返回喂给 buildRecallContext。
 *
 * 用法：node scripts/verify/wiki-recall.mjs
 * 退出码：0 全过 / 1 有失败
 *
 * 前置：D:\web-dashboard\teaching-server 已 npm install（用它的 sqlite/tsx）。
 */

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const CLINE_ROOT = path.resolve(import.meta.dirname, "..", "..")
const SERVER_ROOT = path.resolve("D:\\web-dashboard\\teaching-server")
const TMP = path.join(CLINE_ROOT, ".tmp-wiki-recall")
const DATA_DIR = path.join(TMP, "data")
const DB_PATH = path.join(DATA_DIR, "teaching_system.db")
const PORT = Number(process.env.WIKI_RECALL_PORT || 4142)
const BASE = `http://127.0.0.1:${PORT}`

// 直接 import 扩展侧的**生产实现**（Node 24 原生剥类型；该模块无 import，故可用）
const { pathToFileURL } = await import("node:url")
const { buildRecallContext } = await import(pathToFileURL(path.join(CLINE_ROOT, "src", "core", "teaching", "wikiPrompt.ts")).href)

let pass = 0
let fail = 0
const failures = []
function check(ok, label, detail = "") {
	if (ok) {
		pass++
		console.log(`  ok  ${label}`)
	} else {
		fail++
		failures.push(label)
		console.log(`  NOT OK  ${label}${detail ? ` — ${detail}` : ""}`)
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForHealth(child, timeoutMs = 60000) {
	const started = Date.now()
	while (Date.now() - started < timeoutMs) {
		if (child.exitCode !== null) throw new Error(`服务提前退出 code=${child.exitCode}`)
		try {
			const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) })
			if (res.ok) return
		} catch {
			// not up yet
		}
		await sleep(300)
	}
	throw new Error("等待 /api/health 超时")
}

async function seed() {
	const { createRequire } = await import("node:module")
	const requireFromServer = createRequire(path.join(SERVER_ROOT, "package.json"))
	const { open } = requireFromServer("sqlite")
	const sqlite3 = requireFromServer("sqlite3")
	const db = await open({ filename: DB_PATH, driver: sqlite3.Database })
	try {
		await db.exec("PRAGMA busy_timeout = 5000")
		const rows = [
			["w12_list_title", "列表推导式", "列表推导式是构造列表的简洁写法", 12, 0],
			["w12_list_body", "数据结构回顾", "列表 是最常用的序列；列表 支持切片", 12, 1],
			["w3_vars", "变量与类型", "整型 浮点 字符串 的声明与转换", 3, 0],
		]
		for (const [id, title, content, week, index] of rows) {
			await db.run(
				`INSERT INTO wiki_chunks (id, title, content, applicable_week, chunk_index, chunk_total)
				 VALUES (?, ?, ?, ?, ?, 1)`,
				id,
				title,
				content,
				week,
				index,
			)
		}
	} finally {
		await db.close()
	}
}

/** 复刻 LLMWikiService.recallForQuestion 的请求构造（同一份逻辑，改这里要同步改实现） */
async function search(query, limit = 8) {
	const url = `${BASE}/api/v1/wiki/search?q=${encodeURIComponent(query.slice(0, 300))}&limit=${Math.min(Math.max(limit, 1), 10)}`
	const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
	if (!res.ok) return { url, ok: false, items: [] }
	const body = await res.json()
	if (process.env.WIKI_RECALL_DEBUG) {
		console.log(`[dbg] ${url} -> count=${body?.count} keys=${Object.keys(body ?? {}).join(",")}`)
	}
	const items = (body?.data ?? [])
		.map((c) => ({ chunkId: c?.id ?? "", title: c?.title ?? "", content: (c?.content ?? c?.snippet ?? "").trim() }))
		.filter((c) => c.content.length > 0)
	return { url, ok: true, items, meta: body?.meta }
}

async function main() {
	fs.rmSync(TMP, { recursive: true, force: true })
	fs.mkdirSync(DATA_DIR, { recursive: true })
	const logFile = path.join(TMP, "server.log")
	const out = fs.openSync(logFile, "w")
	const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
		cwd: SERVER_ROOT,
		env: { ...process.env, DATA_DIR, PORT: String(PORT) },
		stdio: ["ignore", out, out],
	})

	try {
		await waitForHealth(child)
		await seed()

		// ---- 1) 命中路径：问「什么是列表推导式」 ----
		const hit = await search("什么是列表推导式")
		check(hit.ok, "① 检索请求成功", hit.url)
		check(hit.items.length >= 1, "① 有命中片段", `hits=${hit.items.length}`)
		check(hit.meta?.ordered_by === "relevance", "① 后端按相关度排序", JSON.stringify(hit.meta))
		check(!hit.url.includes("week"), "① 请求 URL 不含 week / max_week")

		const block = buildRecallContext(hit.items)
		check(block !== null, "① 命中时注入块非空")
		check((block ?? "").includes("## 参考教材片段（自动检索，可能不完整）"), "① 含标题行")
		check((block ?? "").includes("教材#w12_list_title"), "① 命中片段带 chunk_id")
		check((block ?? "").includes("列表推导式"), "① 片段含资料标题")
		check((block ?? "").includes("(教材: <chunk_id>)"), "① 含来源标注规则")

		// ---- 2) 未命中：问「今天天气怎么样」 ----
		const miss = await search("今天天气怎么样")
		check(miss.items.length === 0, "② 无关提问 0 命中（不会硬凑资料）", `hits=${miss.items.length}`)
		check(buildRecallContext(miss.items) === null, "② 0 命中时不注入（只保留索引）")

		// ---- 3) 预召回预算：注入长度远小于全文 ----
		const budgetBlock = buildRecallContext(hit.items)
		check((budgetBlock ?? "").length <= 2400, "③ 注入块在预算内", `len=${(budgetBlock ?? "").length}`)

		// ---- 4) 长提问被截断，不会被后端 414/400 打回 ----
		const longQ = "列表".repeat(600)
		const longRes = await search(longQ)
		check(longRes.ok, "④ 超长提问仍返回 200（query 截断生效）")

		// ---- 5) 通配符不返回全表（与后端注入防护一致） ----
		const wildcard = await search("%")
		check(wildcard.items.length === 0, "⑤ q='%' 不返回全表", `hits=${wildcard.items.length}`)
	} catch (e) {
		check(false, "闸门执行未抛异常", e instanceof Error ? e.message : String(e))
	} finally {
		child.kill()
		await sleep(500)
		fs.closeSync(out)
		fs.rmSync(TMP, { recursive: true, force: true })
	}

	console.log(`\n总计 ${pass + fail} 项断言：通过 ${pass}，失败 ${fail}`)
	if (fail > 0) {
		console.log(`失败项：\n- ${failures.join("\n- ")}`)
		process.exitCode = 1
	}
}

main()
