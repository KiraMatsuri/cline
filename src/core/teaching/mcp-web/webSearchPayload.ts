/**
 * 【F8】结构化错误载荷（**纯函数**，可单测）。
 *
 * 为什么必须结构化且不抛错：工具失败**不得阻断对话**（规格 F8 硬要求）。
 * 模型看到结构化错误后应"承认检索不可用并基于已有知识作答"，而不是编造来源。
 */
export type WebSearchErrorCode = "backend_unreachable" | "endpoint_missing" | "timeout" | "bad_response"

export interface WebSearchErrorPayload {
	ok: false
	error: WebSearchErrorCode
	message: string
}

export function buildWebSearchError(code: WebSearchErrorCode, detail?: string): WebSearchErrorPayload {
	const messages: Record<WebSearchErrorCode, string> = {
		backend_unreachable: "外部检索服务不可达（教学后端未启动或网络不通）。",
		endpoint_missing: "教学后端未提供外部检索端点。",
		timeout: "外部检索超时。",
		bad_response: "外部检索返回了无法解析的响应。",
	}
	return { ok: false, error: code, message: detail ? `${messages[code]}（${detail}）` : messages[code] }
}

/**
 * 后端返回体的**形状校验**（纯函数）：只接受 { results: [{title, snippet, url}] }。
 *
 * 契约（D1：端点由教学后端提供，路径可配置）：
 *   成功 → 200 + `{ "results": [ { "title": string, "snippet": string, "url": string } ] }`
 * 任何不符（不是对象 / 缺 results / results 非数组 / 元素非对象 / 元素缺字符串字段）→ 返回 `null`，
 * 调用方据此返回 `bad_response`，**绝不**把畸形响应当成检索结果喂给模型。
 * 空数组是**合法**的（表示确实没检索到），返回 `[]` 而非 `null`。
 */
export function parseWebSearchResults(raw: unknown): Array<{ title: string; snippet: string; url: string }> | null {
	if (raw === null || typeof raw !== "object") {
		return null
	}
	const results = (raw as { results?: unknown }).results
	if (!Array.isArray(results)) {
		return null
	}
	const out: Array<{ title: string; snippet: string; url: string }> = []
	for (const item of results) {
		if (item === null || typeof item !== "object") {
			return null
		}
		const { title, snippet, url } = item as Record<string, unknown>
		if (typeof title !== "string" || typeof snippet !== "string" || typeof url !== "string") {
			return null
		}
		out.push({ title, snippet, url })
	}
	return out
}
