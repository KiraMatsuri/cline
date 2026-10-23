import { expect } from "chai"
import {
	DEFAULT_ATTACHMENT_MAX_CHARS,
	describeAttachmentText,
	fetchAttachmentText,
	type AttachmentTextError,
	type AttachmentTextOk,
} from "../submission/attachmentText"

/**
 * P0-4 · 附件正文读取（纯函数层）
 *
 * 这一层的契约是「**永不抛异常**，失败也要能被面板渲染」——因为附件预览是最容易
 * 因为后端/网络/文件缺失而失败的一环，一旦抛出去，整个任务详情面板就白了。
 */
describe("fetchAttachmentText — 附件正文", () => {
	const okResp = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response
	const errResp = (status: number, body: unknown) => ({ ok: false, status, json: async () => body }) as unknown as Response

	it("★ 成功时取回正文与元信息", async () => {
		let calledUrl = ""
		const res = (await fetchAttachmentText("http://x:4001/", "a1", 7, {
			fetchImpl: (async (url: string) => {
				calledUrl = String(url)
				return okResp({ text: "# 指导书", chars: 4, truncated: false, mime: "text/markdown", original_name: "g.md" })
			}) as unknown as typeof fetch,
		})) as AttachmentTextOk
		expect(res.ok).to.equal(true)
		expect(res.text).to.equal("# 指导书")
		expect(res.originalName).to.equal("g.md")
		expect(calledUrl).to.equal("http://x:4001/api/v1/assignments/a1/attachments/7/text?maxChars=200000")
	})

	it("★ apiBase 末尾斜杠不会拼出双斜杠", async () => {
		let calledUrl = ""
		await fetchAttachmentText("http://x:4001///", "a1", 1, {
			fetchImpl: (async (url: string) => {
				calledUrl = String(url)
				return okResp({ text: "" })
			}) as unknown as typeof fetch,
		})
		expect(calledUrl.startsWith("http://x:4001/api/v1/assignments/a1/attachments/1/text")).to.equal(true)
	})

	it("★ 415 → unsupported=true（面板显示「可下载」而不是红条）", async () => {
		const res = (await fetchAttachmentText("http://x", "a1", 2, {
			fetchImpl: (async () => errResp(415, { code: "TEXT_UNSUPPORTED", message: "该附件类型无法解析为文本" })) as unknown as typeof fetch,
		})) as AttachmentTextError
		expect(res.ok).to.equal(false)
		expect(res.unsupported).to.equal(true)
		expect(res.code).to.equal("TEXT_UNSUPPORTED")
		expect(describeAttachmentText(res)).to.include("可下载查看")
	})

	it("★ 404 → ATTACHMENT_NOT_FOUND", async () => {
		const res = (await fetchAttachmentText("http://x", "a1", 3, {
			fetchImpl: (async () => errResp(404, { code: "ATTACHMENT_FILE_MISSING", message: "附件文件已丢失" })) as unknown as typeof fetch,
		})) as AttachmentTextError
		expect(res.ok).to.equal(false)
		expect(res.code).to.equal("ATTACHMENT_FILE_MISSING")
		expect(res.error).to.equal("附件文件已丢失")
	})

	it("★ 422 → TEXT_PARSE_FAILED", async () => {
		const res = (await fetchAttachmentText("http://x", "a1", 4, {
			fetchImpl: (async () => errResp(422, { code: "TEXT_PARSE_FAILED", message: "附件解析失败" })) as unknown as typeof fetch,
		})) as AttachmentTextError
		expect(res.code).to.equal("TEXT_PARSE_FAILED")
	})

	it("★ 其他非 2xx（500）→ HTTP_500 且不抛", async () => {
		const res = (await fetchAttachmentText("http://x", "a1", 5, {
			fetchImpl: (async () => errResp(500, { message: "服务器内部错误" })) as unknown as typeof fetch,
		})) as AttachmentTextError
		expect(res.ok).to.equal(false)
		expect(res.code).to.equal("HTTP_500")
	})

	it("★ 网络异常（ECONNREFUSED）→ NETWORK_ERROR 且带地址", async () => {
		const res = (await fetchAttachmentText("http://127.0.0.1:4001", "a1", 6, {
			fetchImpl: (async () => {
				throw new Error("fetch failed: ECONNREFUSED")
			}) as unknown as typeof fetch,
		})) as AttachmentTextError
		expect(res.code).to.equal("NETWORK_ERROR")
		expect(res.error).to.include("127.0.0.1:4001")
	})

	it("★ 缺参数时直接返回错误（不发请求）", async () => {
		let called = false
		const impl = (async () => {
			called = true
			return okResp({ text: "" })
		}) as unknown as typeof fetch
		const a = (await fetchAttachmentText("", "a1", 1, { fetchImpl: impl })) as AttachmentTextError
		const b = (await fetchAttachmentText("http://x", "", 1, { fetchImpl: impl })) as AttachmentTextError
		expect(a.code).to.equal("NO_API_BASE")
		expect(b.code).to.equal("BAD_REQUEST")
		expect(called).to.equal(false)
	})

	it("★ maxChars 进 query，且上限被夹到 1,000,000", async () => {
		let calledUrl = ""
		await fetchAttachmentText("http://x", "a1", 1, {
			maxChars: 5_000_000,
			fetchImpl: (async (url: string) => {
				calledUrl = String(url)
				return okResp({ text: "" })
			}) as unknown as typeof fetch,
		})
		expect(calledUrl.includes("maxChars=1000000")).to.equal(true)
	})

	it("★ 截断时 describeAttachmentText 提示「仅显示前 N 字」", async () => {
		const res: AttachmentTextOk = {
			ok: true,
			text: "x".repeat(10),
			chars: 10,
			truncated: true,
			mime: "text/markdown",
			originalName: "大文件.md",
		}
		expect(describeAttachmentText(res)).to.include("仅显示前 10 字")
	})

	it("★ 默认 maxChars 常量与服务端一致（200000）", () => {
		expect(DEFAULT_ATTACHMENT_MAX_CHARS).to.equal(200000)
	})
})
