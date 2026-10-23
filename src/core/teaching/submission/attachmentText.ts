/**
 * 附件正文读取（P0-4）
 *
 * 任务详情面板要**直接展示**实验指导书正文，因此需要把「附件」变成「文本」。
 * 解析发生在教学端（`GET /api/v1/assignments/:id/attachments/:fileId/text`，
 * md/txt/pdf/docx/pptx，复用 officeParser），扩展侧只负责取回与降级。
 *
 * 为什么单独成一个模块：面板与看板都要用它，而 `AssignmentManager` 依赖 vscode，
 * 纯函数在这里才可单测（vscode 环境下的失败路径没法用 mocha 覆盖）。
 */

/** 服务端默认截断长度（超过即 truncated=true） */
export const DEFAULT_ATTACHMENT_MAX_CHARS = 200_000

export interface AttachmentTextOk {
	ok: true
	text: string
	chars: number
	truncated: boolean
	mime: string | null
	originalName: string | null
}

export interface AttachmentTextError {
	ok: false
	/** 给用户看的短句（面板直接显示） */
	error: string
	/** 机器可判的稳定代号：TEXT_UNSUPPORTED / ATTACHMENT_NOT_FOUND / TEXT_PARSE_FAILED / … */
	code?: string
	/** 类型不支持：面板应显示「无法预览，可下载」而不是报错红条 */
	unsupported?: boolean
}

export interface FetchAttachmentTextOptions {
	maxChars?: number
	timeoutMs?: number
	fetchImpl?: typeof fetch
}

const NETWORK_ERROR = /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|aborted/i

/**
 * 读取附件正文；**任何失败都返回结构化错误，不抛异常**（面板据此降级为「可下载」）。
 */
export async function fetchAttachmentText(
	apiBase: string,
	assignmentId: string,
	attachmentId: string | number,
	opts: FetchAttachmentTextOptions = {},
): Promise<AttachmentTextOk | AttachmentTextError> {
	const base = (apiBase ?? "").trim().replace(/\/+$/, "")
	if (!base) return { ok: false, error: "未配置服务器地址", code: "NO_API_BASE" }
	if (!assignmentId) return { ok: false, error: "缺少任务 id", code: "BAD_REQUEST" }
	if (attachmentId === undefined || attachmentId === null || `${attachmentId}` === "") {
		return { ok: false, error: "缺少附件 id", code: "BAD_REQUEST" }
	}

	const maxChars = Math.max(1, Math.min(opts.maxChars ?? DEFAULT_ATTACHMENT_MAX_CHARS, 1_000_000))
	const url = `${base}/api/v1/assignments/${encodeURIComponent(assignmentId)}/attachments/${encodeURIComponent(
		String(attachmentId),
	)}/text?maxChars=${maxChars}`

	const fetchImpl = opts.fetchImpl ?? fetch
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000)

	try {
		const resp = await fetchImpl(url, { method: "GET", signal: controller.signal })
		if (resp.ok) {
			const body = (await resp.json()) as {
				text?: string
				chars?: number
				truncated?: boolean
				mime?: string | null
				original_name?: string | null
			}
			const text = typeof body.text === "string" ? body.text : ""
			return {
				ok: true,
				text,
				chars: typeof body.chars === "number" ? body.chars : text.length,
				truncated: body.truncated === true,
				mime: body.mime ?? null,
				originalName: body.original_name ?? null,
			}
		}

		let code: string | undefined
		let message = ""
		try {
			const errBody = (await resp.json()) as { code?: string; message?: string }
			code = errBody?.code
			message = errBody?.message ?? ""
		} catch {
			// 非 JSON 错误体：按状态码兜底
		}

		if (resp.status === 415 || code === "TEXT_UNSUPPORTED") {
			return {
				ok: false,
				code: code ?? "TEXT_UNSUPPORTED",
				unsupported: true,
				error: message || "该附件类型无法解析为文本，请下载后查看",
			}
		}
		if (resp.status === 404) {
			return {
				ok: false,
				code: code ?? "ATTACHMENT_NOT_FOUND",
				error: message || "附件不存在或文件已丢失",
			}
		}
		if (resp.status === 422 || code === "TEXT_PARSE_FAILED") {
			return { ok: false, code: code ?? "TEXT_PARSE_FAILED", error: message || "附件解析失败，请下载后查看" }
		}
		return { ok: false, code: code ?? `HTTP_${resp.status}`, error: message || `服务器返回错误 (HTTP ${resp.status})` }
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		return {
			ok: false,
			code: "NETWORK_ERROR",
			error: NETWORK_ERROR.test(msg)
				? `无法连接服务器（${base}）：${msg}`
				: `读取附件失败：${msg}`,
		}
	} finally {
		clearTimeout(timer)
	}
}

/** 面板上展示用的一行摘要（截断时带提示，避免用户以为指导书就这么短） */
export function describeAttachmentText(result: AttachmentTextOk | AttachmentTextError): string {
	if (!result.ok) {
		return result.unsupported ? `${result.error}（可下载查看）` : result.error
	}
	const name = result.originalName ? `「${result.originalName}」` : "附件"
	const suffix = result.truncated ? `（仅显示前 ${result.chars} 字）` : ""
	return `${name} 正文 ${result.chars} 字${suffix}`
}
