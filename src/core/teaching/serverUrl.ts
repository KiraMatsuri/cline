/**
 * =============================================================================
 *  serverUrl — 教学服务器地址的**唯一**归一化入口 + 失败原因可读化
 * =============================================================================
 *
 * 【为什么需要】
 * 所有教学相关请求都是「配置里的 base 地址 + 固定路径」拼出来的：
 *   - 测试连接 / 实验任务 / wiki 检索 / 反馈 / MCP（`/api/v1/...`）
 * 学生在「服务器设置」里填 `http://47.120.74.204/`（带尾斜杠）时，若某个调用点忘了
 * 去尾斜杠，就会拼出 `http://47.120.74.204//api/v1/...`：
 *   nginx/Express 不认双斜杠路径 → 返回 404 HTML → `resp.json()` 抛
 *   `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`（2026-10-25 线上问题）。
 *
 * 之前只有 AssignmentManager 自己写了 normalizeApiBase，其余调用点各写 `trim()`，
 * 于是「实验任务能用、测试连接却报 JSON 语法错误」。这里收敛成一个纯函数，各点共用。
 *
 * 【纯函数】不 import vscode / fs，便于单测与在 MCP 子进程里复用。
 */

/** 未配置时的兜底地址（与 package.json `clineTeaching.serverUrl` 默认值一致） */
export const DEFAULT_SERVER_URL = "http://localhost:4001"

/**
 * 归一化服务器地址：去首尾空白 + 去掉**所有**结尾斜杠。
 *
 * @param rawUrl 配置里的原始值（可能为空、带空白、带多个尾斜杠）
 * @param fallback 归一化后为空时返回的兜底值；MCP 注册场景允许传 "" 表示“未配置”
 */
export function normalizeServerUrl(rawUrl: string | null | undefined, fallback: string = DEFAULT_SERVER_URL): string {
	const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : ""
	if (!trimmed) {
		return fallback
	}
	// `"///"` 这种只由斜杠组成的输入会归一成空串 —— 那不是可用地址，直接兜底
	const stripped = trimmed.replace(/\/+$/, "")
	return stripped || fallback
}

/**
 * 判断响应体是否像 HTML（SPA 回退页 / 网关错误页 / Express 默认 404）。
 * 只看开头，避免把正文里出现的 `<` 误判。
 */
export function looksLikeHtml(text: string): boolean {
	return /^\s*<(!doctype\s+html|html|head|body)/i.test(text)
}

export interface TestConnectionFailureInput {
	/** 归一化后的服务器地址（用于提示用户当前配置） */
	serverUrl: string
	/** HTTP 状态码（有响应时） */
	status?: number
	/** 响应头 Content-Type（有响应时） */
	contentType?: string | null
	/** 响应体原文（有响应时） */
	body?: string
	/** fetch 抛出的异常（网络层 / 其它） */
	error?: unknown
}

/**
 * 把「测试连接」失败转成一句可执行的中文提示。
 *
 * 为什么放在纯函数里：这段文案的正确性（HTML / 非 JSON / 网络错误三分支）是
 * 本次线上问题的关键，需要单测钉住，而不是埋在 provider 的 catch 里。
 */
export function describeTestConnectionFailure(input: TestConnectionFailureInput): string {
	if (input.error !== undefined) {
		const rawMsg = input.error instanceof Error ? input.error.message : String(input.error)
		const isNetworkError =
			/fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|socket hang up/i.test(
				rawMsg,
			)
		if (isNetworkError) {
			return `无法连接教学服务器 ${input.serverUrl}，请检查「服务器设置」中的地址与网络`
		}
		return `请求后端失败: ${rawMsg}`
	}

	const body = input.body ?? ""
	if (body.trim() && looksLikeHtml(body)) {
		const contentType = input.contentType ?? "未提供 Content-Type"
		const status = typeof input.status === "number" ? input.status : "?"
		return (
			`服务器返回了网页而不是 JSON（HTTP ${status}；Content-Type: ${contentType}）。` +
			`请检查「服务器设置」里的地址（当前：${input.serverUrl}）：` +
			`1) 去掉结尾斜杠；2) 确认指向教学后端（/api/v1/*），而不是前端页面地址。`
		)
	}

	if (body.trim()) {
		// 非 JSON 又不是 HTML：截断展示，避免把大段文本塞进 toast
		const snippet = body.length > 200 ? `${body.slice(0, 200)}…` : body
		const status = typeof input.status === "number" ? `HTTP ${input.status}，` : ""
		return `请求后端失败：响应不是合法 JSON（${status}${snippet.replace(/\s+/g, " ")}）`
	}

	const status = typeof input.status === "number" ? `HTTP ${input.status}` : "响应为空"
	return `请求后端失败: ${status}`
}
