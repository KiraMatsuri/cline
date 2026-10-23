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
			// 后端在 404 等情况下会带结构化 reason（如 not_found_or_out_of_scope）。
			// 优先透传它：spec §6 约定越界读取返回 {"error":"not_found_or_out_of_scope"}，
			// 让模型能区分「资料未在当前教学进度内发布」与「后端真的报错了」。
			let reason: string | undefined
			try {
				const body = JSON.parse(text) as { reason?: unknown }
				if (typeof body?.reason === "string") {
					reason = body.reason
				}
			} catch {
				// 非 JSON 响应体（如 nginx 错误页）→ 退回状态码
			}
			return { error: reason ?? `http_${resp.status}`, detail: text.slice(0, 200) }
		}
		return JSON.parse(text)
	} catch (e) {
		return { error: "wiki_backend_unreachable", detail: e instanceof Error ? e.message : String(e) }
	} finally {
		clearTimeout(timer)
	}
}

export async function callSearchWiki(serverUrl: string, query: string, limit: number) {
	const q = encodeURIComponent(query.slice(0, 200))
	const lim = Math.min(Math.max(Math.floor(limit) || 5, 1), 10)
	// 【v3】不再带 week：后端按相关度检索全部已发布资料
	return getJson(`${serverUrl}/api/v1/wiki/search?q=${q}&limit=${lim}`)
}

export async function callReadChunk(serverUrl: string, chunkId: string) {
	return getJson(`${serverUrl}/api/v1/wiki/chunk?chunk_id=${encodeURIComponent(chunkId)}`)
}

export async function callListWeeks(serverUrl: string) {
	return getJson(`${serverUrl}/api/v1/wiki/weeks`)
}
