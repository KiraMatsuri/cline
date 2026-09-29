/**
 * 教学后端 REST 调用封装（纯函数，便于单测）（v2.13）
 *
 * ⚠️ 本文件会被打包进 MCP stdio server —— 一个**独立进程**，进程内没有 vscode API。
 * 按 `.clinerules/network.md`，扩展代码不得直接使用全局 `fetch`，必须用 `@/shared/net`
 * 的代理感知封装。这里遵从该约定：
 *   - `@/shared/net` 只依赖 `undici`，不 import vscode，因此可在独立进程中使用；
 *   - 它在非 standalone 构建下会回落到全局 `fetch`（见其 `IS_STANDALONE` 分支），
 *     对本进程是行为等价的零成本替换。
 */

import { fetch } from "@/shared/net"

const TIMEOUT_MS = 5_000

async function getJson(url: string): Promise<unknown> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
	try {
		const resp = await fetch(url, { signal: ctrl.signal })
		const text = await resp.text()
		if (!resp.ok) {
			return { error: `http_${resp.status}`, detail: text.slice(0, 200) }
		}
		return JSON.parse(text)
	} catch (e) {
		return { error: "wiki_backend_unreachable", detail: e instanceof Error ? e.message : String(e) }
	} finally {
		clearTimeout(timer)
	}
}

export async function callSearchWiki(serverUrl: string, week: number, query: string, limit: number) {
	const q = encodeURIComponent(query.slice(0, 200))
	const lim = Math.min(Math.max(Math.floor(limit) || 5, 1), 10)
	return getJson(`${serverUrl}/api/v1/wiki/search?week=${week}&q=${q}&limit=${lim}`)
}

export async function callReadChunk(serverUrl: string, week: number, chunkId: string) {
	return getJson(`${serverUrl}/api/v1/wiki/chunk?chunk_id=${encodeURIComponent(chunkId)}&week=${week}`)
}

export async function callListWeeks(serverUrl: string, week: number) {
	return getJson(`${serverUrl}/api/v1/wiki/weeks?week=${week}`)
}
