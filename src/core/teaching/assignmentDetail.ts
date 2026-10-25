/**
 * 任务详情载荷（P1-2）
 *
 * 「点任务 → 详情面板」的**纯数据层**：把一个 `Assignment`（可能来自缓存、也可能来自
 * `GET /api/v1/assignments`）+ 已解析的指导书正文，组装成面板要渲染的结构。
 *
 * 放在 teaching 下而不是 hosts/vscode 下，是因为面板（vscode 依赖）没法单测，
 * 而这里的分支恰恰是最容易出错的地方：附件缺 mime、指导书超长、任务被教师删了但缓存还在（BN-17）。
 */

/** 描述正文上限（面板里折叠显示，超过就截断并提示） */
export const MAX_DESCRIPTION_CHARS = 8000

/** 指导书正文上限（与服务端 `/text` 默认 maxChars 一致） */
export const MAX_GUIDE_CHARS = 200_000

/** 可直接预览正文的扩展名（与服务端 officeParser 支持面一致） */
const PREVIEWABLE_EXTENSIONS = [".md", ".markdown", ".txt", ".pdf", ".docx", ".doc", ".pptx", ".ppt"]

export interface DetailAttachmentInput {
	id: number
	name: string
	size?: number
	mimeType?: string
}

export interface DetailAttachment extends DetailAttachmentInput {
	/** 下载地址（相对 apiBase 的绝对路径，前端直接 href） */
	downloadUrl: string
	/** 能否在教学端解析成文本（不能就只给下载） */
	previewable: boolean
}

export interface AssignmentLike {
	id: string
	title: string
	week?: number
	description?: string
	template_code?: string
	attachments?: DetailAttachmentInput[]
}

export interface AssignmentDetailPayload {
	id: string
	title: string
	week: number | null
	description: string
	descriptionTruncated: boolean
	templateCode: string
	attachments: DetailAttachment[]
	/** 指导书正文（无指导书或解析失败时为 ""） */
	guideText: string
	guideTruncated: boolean
	/** 指导书来源附件名（面板显示「来自 xxx.md」） */
	guideSource: string | null
	/** 指导书解析失败/类型不支持时的说明（面板显示为提示条） */
	guideNotice: string | null
	/** 是否已开始实验（决定按钮文案「开始实验 / 继续实验」） */
	started: boolean
	/** 实验目录（已开始时） */
	experimentDir: string | null
	/** 是否有进行中的实验会话（决定面板显示「提交实验 / 结束实验」） */
	sessionActive: boolean
}

export function extensionOf(name: string): string {
	const idx = name.lastIndexOf(".")
	return idx >= 0 ? name.slice(idx).toLowerCase() : ""
}

/** 附件能否预览正文：看扩展名（mime 常常是 octet-stream，不可靠） */
export function isPreviewableAttachment(input: { name: string; mimeType?: string }): boolean {
	const ext = extensionOf(input.name ?? "")
	if (PREVIEWABLE_EXTENSIONS.includes(ext)) {
		return true
	}
	const mime = (input.mimeType ?? "").toLowerCase()
	return mime.startsWith("text/") || mime === "application/pdf"
}

export function downloadUrlFor(apiBase: string, assignmentId: string, attachmentId: number): string {
	const base = (apiBase ?? "").replace(/\/+$/, "")
	return `${base}/api/v1/assignments/${encodeURIComponent(assignmentId)}/attachments/${attachmentId}/download`
}

/** 按扩展名排序，让「指导书」优先于压缩包/图片 */
const GUIDE_PRIORITY: Record<string, number> = {
	".md": 0,
	".markdown": 0,
	".docx": 1,
	".doc": 2,
	".pdf": 3,
	".txt": 4,
	".pptx": 5,
	".ppt": 6,
}

/**
 * 选出「最像实验指导书」的附件：md > docx > doc > pdf > txt > pptx > ppt > 其他可预览项。
 * 返回 null 表示没有可解析的附件（面板只显示下载列表）。
 */
export function pickGuideAttachment(attachments: DetailAttachmentInput[]): DetailAttachmentInput | null {
	const candidates = (attachments ?? []).filter((a) => isPreviewableAttachment(a))
	if (candidates.length === 0) {
		return null
	}
	return [...candidates].sort((a, b) => {
		const pa = GUIDE_PRIORITY[extensionOf(a.name)] ?? 99
		const pb = GUIDE_PRIORITY[extensionOf(b.name)] ?? 99
		if (pa !== pb) {
			return pa - pb
		}
		return (a.id ?? 0) - (b.id ?? 0)
	})[0]
}

export interface BuildDetailInput {
	assignment: AssignmentLike | null | undefined
	apiBase: string
	/** 已取到的指导书正文（未取/失败传 undefined） */
	guide?: { text: string; truncated?: boolean; attachmentName?: string } | null
	/** 指导书取回失败时的说明（415/404/422 的中文短句） */
	guideNotice?: string | null
	/** 是否已开始实验 */
	started?: boolean
	experimentDir?: string | null
	/** 是否有进行中的实验会话（会话文件存在且属于本任务） */
	sessionActive?: boolean
}

/**
 * 组装面板载荷。
 *
 * 边界：
 *  - `assignment` 为 null（BN-17：教师删了任务但学生端缓存还在）→ 返回 `{error}`；
 *  - 描述/指导书超长 → 截断并置对应 `*Truncated`；
 *  - 无附件 → `attachments: []`、`guideText: ""`、`guideSource: null`；
 *  - 无模板 → `templateCode: ""`（面板仍允许开始实验，生成 TODO 模板）。
 */
export function buildAssignmentDetailPayload(
	input: BuildDetailInput,
): { ok: true; payload: AssignmentDetailPayload } | { ok: false; error: string } {
	const { assignment } = input
	if (!assignment) {
		return { ok: false, error: "未找到实验任务（可能已被教师删除）" }
	}
	if (!assignment.id) {
		return { ok: false, error: "实验任务缺少 id" }
	}

	const rawDescription = (assignment.description ?? "").trim()
	const descriptionTruncated = rawDescription.length > MAX_DESCRIPTION_CHARS
	const description = descriptionTruncated ? `${rawDescription.slice(0, MAX_DESCRIPTION_CHARS)}\n\n…（描述过长，已截断）` : rawDescription

	const attachments: DetailAttachment[] = (assignment.attachments ?? []).map((a) => ({
		id: a.id,
		name: a.name,
		size: a.size,
		mimeType: a.mimeType,
		downloadUrl: downloadUrlFor(input.apiBase, assignment.id, a.id),
		previewable: isPreviewableAttachment(a),
	}))

	const rawGuide = (input.guide?.text ?? "").trim()
	const guideTruncated = input.guide?.truncated === true || rawGuide.length > MAX_GUIDE_CHARS
	const guideText = rawGuide.length > MAX_GUIDE_CHARS ? rawGuide.slice(0, MAX_GUIDE_CHARS) : rawGuide

	return {
		ok: true,
		payload: {
			id: assignment.id,
			title: assignment.title ?? assignment.id,
			week: typeof assignment.week === "number" ? assignment.week : null,
			description,
			descriptionTruncated,
			templateCode: assignment.template_code ?? "",
			attachments,
			guideText,
			guideTruncated,
			guideSource: guideText ? (input.guide?.attachmentName ?? null) : null,
			guideNotice: input.guideNotice ?? null,
			started: input.started === true,
			experimentDir: input.experimentDir ?? null,
			sessionActive: input.sessionActive === true,
		},
	}
}
