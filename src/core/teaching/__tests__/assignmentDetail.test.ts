import { expect } from "chai"
import {
	buildAssignmentDetailPayload,
	downloadUrlFor,
	extensionOf,
	isPreviewableAttachment,
	MAX_DESCRIPTION_CHARS,
	MAX_GUIDE_CHARS,
	pickGuideAttachment,
} from "../assignmentDetail"

/**
 * P1-2 · 任务详情载荷
 *
 * 面板本身依赖 vscode 无法单测，但「渲染什么」全在这里决定：
 *   - 任务被教师删掉（缓存还在）→ 必须给出可读错误，而不是空白面板（BN-17）；
 *   - 附件下载 404（BN-18）→ 载荷只管拼 URL，404 由面板提示，URL 必须可点；
 *   - 描述含 Markdown 表格（BN-19）→ 这里原样透传，面板按**纯文本**渲染，不做 HTML 注入。
 */
describe("assignmentDetail — 任务详情载荷", () => {
	const assignment = {
		id: "task_week2_loop",
		title: "循环与列表",
		week: 2,
		description: "请实现一个统计列表的脚本。",
		template_code: "# TODO: 在这里写代码\n",
		attachments: [
			{ id: 11, name: "实验指导书.docx", size: 20480, mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
			{ id: 12, name: "数据.csv", size: 1024, mimeType: "text/csv" },
			{ id: 13, name: "示例程序.zip", size: 4096, mimeType: "application/zip" },
		],
	}

	it("★ 基本字段齐全（id/title/week/description/templateCode）", () => {
		const res = buildAssignmentDetailPayload({ assignment, apiBase: "http://127.0.0.1:4001" })
		expect(res.ok).to.equal(true)
		if (!res.ok) return
		expect(res.payload.id).to.equal("task_week2_loop")
		expect(res.payload.title).to.equal("循环与列表")
		expect(res.payload.week).to.equal(2)
		expect(res.payload.templateCode).to.include("TODO")
		expect(res.payload.description).to.include("统计列表")
	})

	it("★ 附件项含 id/name/size/downloadUrl/previewable", () => {
		const res = buildAssignmentDetailPayload({ assignment, apiBase: "http://127.0.0.1:4001" })
		if (!res.ok) throw new Error("应成功")
		const [docx, csv, zip] = res.payload.attachments
		expect(docx.downloadUrl).to.equal("http://127.0.0.1:4001/api/v1/assignments/task_week2_loop/attachments/11/download")
		expect(csv.previewable).to.equal(true)
		expect(zip.previewable).to.equal(false)
		expect(res.payload.attachments.length).to.equal(3)
	})

	it("★ 指导书正文与来源附件名一起返回", () => {
		const res = buildAssignmentDetailPayload({
			assignment,
			apiBase: "http://x",
			guide: { text: "# 实验指导书\n第一步…", attachmentName: "实验指导书.docx" },
		})
		if (!res.ok) throw new Error("应成功")
		expect(res.payload.guideText).to.include("第一步")
		expect(res.payload.guideSource).to.equal("实验指导书.docx")
		expect(res.payload.guideTruncated).to.equal(false)
	})

	it("★ BN-17：任务不存在 → 可读错误（不是空白面板）", () => {
		const res = buildAssignmentDetailPayload({ assignment: null, apiBase: "http://x" })
		expect(res.ok).to.equal(false)
		if (res.ok) return
		expect(res.error).to.include("未找到实验任务")
	})

	it("★ 无附件 → attachments=[] 且 guideText 为空、无来源", () => {
		const res = buildAssignmentDetailPayload({
			assignment: { ...assignment, attachments: [] },
			apiBase: "http://x",
		})
		if (!res.ok) throw new Error("应成功")
		expect(res.payload.attachments).to.deep.equal([])
		expect(res.payload.guideText).to.equal("")
		expect(res.payload.guideSource).to.equal(null)
	})

	it("★ 无模板 → templateCode 为空串（面板仍可开始实验）", () => {
		const res = buildAssignmentDetailPayload({
			assignment: { ...assignment, template_code: undefined },
			apiBase: "http://x",
		})
		if (!res.ok) throw new Error("应成功")
		expect(res.payload.templateCode).to.equal("")
	})

	it("★ 指导书解析失败 → guideNotice 透传、guideText 为空", () => {
		const res = buildAssignmentDetailPayload({
			assignment,
			apiBase: "http://x",
			guide: null,
			guideNotice: "该附件类型无法解析为文本，请下载后查看",
		})
		if (!res.ok) throw new Error("应成功")
		expect(res.payload.guideText).to.equal("")
		expect(res.payload.guideNotice).to.include("无法解析")
	})

	it("★ 描述超 8000 字 → 截断并标记 descriptionTruncated", () => {
		const long = "说".repeat(MAX_DESCRIPTION_CHARS + 500)
		const res = buildAssignmentDetailPayload({ assignment: { ...assignment, description: long }, apiBase: "http://x" })
		if (!res.ok) throw new Error("应成功")
		expect(res.payload.descriptionTruncated).to.equal(true)
		expect(res.payload.description.length).to.be.lessThan(MAX_DESCRIPTION_CHARS + 100)
	})

	it("★ 指导书超 200k 字 → 截断并标记 guideTruncated", () => {
		const long = "步".repeat(MAX_GUIDE_CHARS + 10)
		const res = buildAssignmentDetailPayload({ assignment, apiBase: "http://x", guide: { text: long, truncated: false } })
		if (!res.ok) throw new Error("应成功")
		expect(res.payload.guideTruncated).to.equal(true)
		expect(res.payload.guideText.length).to.equal(MAX_GUIDE_CHARS)
	})

	it("★ BN-19：描述里的 Markdown/HTML 原样透传（渲染层按纯文本处理，不在此转义）", () => {
		const desc = "| 列 | 值 |\n|---|---|\n| a | 1 |\n<script>alert(1)</script>"
		const res = buildAssignmentDetailPayload({ assignment: { ...assignment, description: desc }, apiBase: "http://x" })
		if (!res.ok) throw new Error("应成功")
		expect(res.payload.description).to.include("<script>")
	})

	it("★ started=true 时给出实验目录（按钮文案由前端决定）", () => {
		const res = buildAssignmentDetailPayload({
			assignment,
			apiBase: "http://x",
			started: true,
			experimentDir: "D:\\ws\\experiments\\task_week2_loop",
		})
		if (!res.ok) throw new Error("应成功")
		expect(res.payload.started).to.equal(true)
		expect(res.payload.experimentDir).to.include("experiments")
	})

	it("★ pickGuideAttachment：md > docx > doc > pdf > txt，zip 不参与", () => {
		const picked = pickGuideAttachment([
			{ id: 1, name: "a.zip" },
			{ id: 2, name: "b.txt" },
			{ id: 3, name: "c.md" },
			{ id: 4, name: "d.docx" },
		])
		expect(picked?.name).to.equal("c.md")
		const onlyDocx = pickGuideAttachment([
			{ id: 5, name: "x.pdf" },
			{ id: 6, name: "y.docx" },
		])
		expect(onlyDocx?.name).to.equal("y.docx")
		expect(pickGuideAttachment([{ id: 7, name: "z.zip" }])).to.equal(null)
		expect(pickGuideAttachment([])).to.equal(null)
	})

	it("★ extensionOf / isPreviewableAttachment 边界", () => {
		expect(extensionOf("无扩展名")).to.equal("")
		expect(extensionOf("A.MD")).to.equal(".md")
		expect(isPreviewableAttachment({ name: "x.MD" })).to.equal(true)
		expect(isPreviewableAttachment({ name: "x.csv", mimeType: "text/csv" })).to.equal(true)
		expect(isPreviewableAttachment({ name: "x", mimeType: "application/pdf" })).to.equal(true)
		expect(isPreviewableAttachment({ name: "x.exe", mimeType: "application/octet-stream" })).to.equal(false)
	})

	it("★ downloadUrlFor 会去掉 apiBase 末尾斜杠并编码 id", () => {
		expect(downloadUrlFor("http://x:4001/", "a b", 3)).to.equal(
			"http://x:4001/api/v1/assignments/a%20b/attachments/3/download",
		)
		expect(downloadUrlFor("", "a", 1)).to.equal("/api/v1/assignments/a/attachments/1/download")
	})
})
