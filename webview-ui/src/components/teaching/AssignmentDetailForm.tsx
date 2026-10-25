/**
 * 实验任务详情面板（P1-2）
 *
 * 单一职责：把扩展推来的 `AssignmentDetailPayload` 渲染成可读的指导书 + 附件 + 模板，
 * 并提供「开始实验 / 继续实验」入口。所有业务判定都在扩展侧（`assignmentDetail.ts`），
 * 这里只做展示与消息转发。
 *
 * 渲染原则：描述与指导书一律 `white-space: pre-wrap` **纯文本**渲染，
 * 不接 Markdown 渲染器、不拼 HTML —— 任务描述由教师填写，可能是任意文本（含 `<script>`），
 * 面板是 Webview，一旦按 HTML 渲染就是注入漏洞（BN-19）。
 */

import type React from "react"
import { useCallback, useEffect, useState } from "react"
import { getVsCodeApiInstance } from "@/config/platform.config"

interface VsCodeApi {
	postMessage(message: Record<string, unknown>): void
}

interface DetailAttachment {
	id: number
	name: string
	size?: number
	mimeType?: string
	downloadUrl: string
	previewable: boolean
}

interface DetailPayload {
	id: string
	title: string
	week: number | null
	description: string
	descriptionTruncated: boolean
	templateCode: string
	attachments: DetailAttachment[]
	guideText: string
	guideTruncated: boolean
	guideSource: string | null
	guideNotice: string | null
	started: boolean
	experimentDir: string | null
	sessionActive: boolean
}

interface PanelResponse {
	command: string
	success?: boolean
	data?: unknown
	error?: string
}

const STYLES = {
	page: {
		padding: "24px 28px 40px",
		maxWidth: "980px",
		margin: "0 auto",
		color: "var(--vscode-foreground)",
		fontFamily: "var(--vscode-font-family)",
		fontSize: "13px",
		lineHeight: 1.6,
	} as React.CSSProperties,
	titleRow: { display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" } as React.CSSProperties,
	title: { fontSize: "20px", fontWeight: 600, margin: 0 } as React.CSSProperties,
	chip: {
		fontSize: "11px",
		padding: "1px 8px",
		borderRadius: "10px",
		border: "1px solid var(--vscode-panel-border, rgba(128,128,128,.4))",
		opacity: 0.85,
	} as React.CSSProperties,
	taskId: { fontSize: "11px", opacity: 0.55, marginTop: "4px" } as React.CSSProperties,
	section: {
		marginTop: "20px",
		border: "1px solid var(--vscode-panel-border, rgba(128,128,128,.28))",
		borderRadius: "8px",
		overflow: "hidden",
	} as React.CSSProperties,
	sectionHead: {
		padding: "8px 12px",
		background: "var(--vscode-editorWidget-background, rgba(128,128,128,.08))",
		fontWeight: 600,
		fontSize: "12px",
		display: "flex",
		justifyContent: "space-between",
		alignItems: "center",
		gap: "8px",
	} as React.CSSProperties,
	sectionBody: { padding: "12px", whiteSpace: "pre-wrap", wordBreak: "break-word" } as React.CSSProperties,
	muted: { fontSize: "11.5px", opacity: 0.65 } as React.CSSProperties,
	notice: {
		padding: "8px 10px",
		borderRadius: "6px",
		fontSize: "12px",
		background: "rgba(255, 193, 7, .12)",
		border: "1px solid rgba(255, 193, 7, .45)",
		marginBottom: "10px",
	} as React.CSSProperties,
	error: {
		padding: "8px 10px",
		borderRadius: "6px",
		fontSize: "12px",
		background: "rgba(244, 67, 54, .12)",
		border: "1px solid rgba(244, 67, 54, .45)",
		marginBottom: "10px",
	} as React.CSSProperties,
	attachmentRow: {
		display: "flex",
		alignItems: "center",
		gap: "10px",
		padding: "6px 0",
		borderBottom: "1px dashed var(--vscode-panel-border, rgba(128,128,128,.25))",
	} as React.CSSProperties,
	attachmentName: { flex: 1, wordBreak: "break-all" } as React.CSSProperties,
	pre: {
		margin: 0,
		padding: "10px 12px",
		background: "var(--vscode-textCodeBlock-background, rgba(128,128,128,.12))",
		borderRadius: "6px",
		fontFamily: "var(--vscode-editor-font-family, monospace)",
		fontSize: "12px",
		overflowX: "auto",
		whiteSpace: "pre",
	} as React.CSSProperties,
	footer: {
		marginTop: "24px",
		display: "flex",
		gap: "10px",
		alignItems: "center",
		position: "sticky",
		bottom: 0,
		padding: "12px 0",
		background: "var(--vscode-editor-background)",
	} as React.CSSProperties,
	primaryButton: {
		padding: "8px 18px",
		borderRadius: "4px",
		border: "none",
		cursor: "pointer",
		fontWeight: 600,
		fontSize: "13px",
		background: "var(--vscode-button-background)",
		color: "var(--vscode-button-foreground)",
	} as React.CSSProperties,
	secondaryButton: {
		padding: "8px 14px",
		borderRadius: "4px",
		cursor: "pointer",
		fontSize: "13px",
		background: "var(--vscode-button-secondaryBackground, rgba(128,128,128,.2))",
		color: "var(--vscode-button-secondaryForeground, var(--vscode-foreground))",
		border: "none",
	} as React.CSSProperties,
	dangerButton: {
		padding: "8px 14px",
		borderRadius: "4px",
		border: "none",
		cursor: "pointer",
		fontSize: "13px",
		fontWeight: 600,
		// 红色背景：结束实验是破坏性操作，必须与「提交实验」明显区分
		background: "var(--vscode-errorForeground, #d32f2f)",
		color: "#ffffff",
	} as React.CSSProperties,
	link: {
		fontSize: "12px",
		padding: "3px 10px",
		borderRadius: "4px",
		cursor: "pointer",
		border: "1px solid var(--vscode-button-background)",
		background: "transparent",
		color: "var(--vscode-button-background)",
	} as React.CSSProperties,
}

function formatBytes(size?: number): string {
	if (!size || size <= 0) {
		return ""
	}
	if (size < 1024) {
		return `${size} B`
	}
	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`
	}
	return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export default function AssignmentDetailForm(): React.ReactElement {
	const [payload, setPayload] = useState<DetailPayload | null>(null)
	const [error, setError] = useState<string>("")
	const [status, setStatus] = useState<string>("")
	const [busy, setBusy] = useState(false)
	const [templateOpen, setTemplateOpen] = useState(false)
	const [confirmingEnd, setConfirmingEnd] = useState(false)

	const getApi = useCallback((): VsCodeApi => getVsCodeApiInstance() as unknown as VsCodeApi, [])

	useEffect(() => {
		const api = getApi()
		const handler = (event: MessageEvent) => {
			const msg = event.data as PanelResponse | undefined
			if (!msg?.command) {
				return
			}
			if (msg.command === "loadDetail") {
				const data = (msg.data ?? null) as DetailPayload | null
				setPayload(data)
				setError("")
				return
			}
			if (msg.command === "openAttachment") {
				setBusy(false)
				setStatus(msg.success ? "已开始下载，完成后会在编辑器中打开" : "")
				setError(msg.success ? "" : (msg.error ?? "下载附件失败"))
				return
			}
			if (msg.command === "startExperiment") {
				setBusy(false)
				setStatus(msg.success ? "实验环境已就绪，正在打开模板…" : "")
				setError(msg.success ? "" : (msg.error ?? "开始实验失败"))
				return
			}
			if (msg.command === "submitExperiment") {
				setBusy(false)
				setStatus(msg.success ? "已打开思考题面板，答完题后确认上传" : "")
				setError(msg.success ? "" : (msg.error ?? "提交实验失败"))
				return
			}
			if (msg.command === "endExperiment") {
				setBusy(false)
				setConfirmingEnd(false)
				setStatus(msg.success ? "已结束实验模式" : "")
				setError(msg.success ? "" : (msg.error ?? "结束实验失败"))
				return
			}
		}
		window.addEventListener("message", handler)
		api.postMessage({ type: "assignment_command", command: "assignmentDetailReady" })
		return () => window.removeEventListener("message", handler)
	}, [getApi])

	const openAttachment = (id: number) => {
		setBusy(true)
		setError("")
		getApi().postMessage({ type: "assignment_detail_command", command: "openAttachment", attachmentId: id })
	}

	const startExperiment = () => {
		setBusy(true)
		setError("")
		setStatus("正在准备实验环境…")
		getApi().postMessage({ type: "assignment_detail_command", command: "startExperiment" })
	}

	const submitExperiment = () => {
		setBusy(true)
		setError("")
		setStatus("正在准备提交…")
		getApi().postMessage({ type: "assignment_detail_command", command: "submitExperiment" })
	}

	const endExperiment = () => {
		if (!confirmingEnd) {
			// 破坏性操作先内联确认一次，避免误点直接离开实验模式
			setConfirmingEnd(true)
			return
		}
		setBusy(true)
		setError("")
		getApi().postMessage({ type: "assignment_detail_command", command: "endExperiment" })
	}

	if (!payload) {
		return (
			<div style={STYLES.page}>
				{error ? <div style={STYLES.error}>{error}</div> : null}
				<div style={STYLES.muted}>正在加载任务详情…</div>
			</div>
		)
	}

	return (
		<div style={STYLES.page}>
			<div style={STYLES.titleRow}>
				<h1 style={STYLES.title}>{payload.title}</h1>
				{payload.week !== null ? <span style={STYLES.chip}>第 {payload.week} 周</span> : null}
				{payload.started ? <span style={STYLES.chip}>已开始实验</span> : null}
			</div>
			<div style={STYLES.taskId}>任务 ID：{payload.id}</div>

			{error ? <div style={{ ...STYLES.error, marginTop: "14px" }}>{error}</div> : null}
			{status ? <div style={{ ...STYLES.muted, marginTop: "10px" }}>{status}</div> : null}

			{payload.description ? (
				<div style={STYLES.section}>
					<div style={STYLES.sectionHead}>
						<span>任务要求</span>
						{payload.descriptionTruncated ? <span style={STYLES.muted}>描述过长，已截断</span> : null}
					</div>
					<div style={STYLES.sectionBody}>{payload.description}</div>
				</div>
			) : null}

			<div style={STYLES.section}>
				<div style={STYLES.sectionHead}>
					<span>实验指导 {payload.guideSource ? `（来自 ${payload.guideSource}）` : ""}</span>
					{payload.guideTruncated ? <span style={STYLES.muted}>正文过长，已截断</span> : null}
				</div>
				<div style={STYLES.sectionBody}>
					{payload.guideNotice ? <div style={STYLES.notice}>{payload.guideNotice}</div> : null}
					{payload.guideText ? (
						payload.guideText
					) : (
						<div style={STYLES.muted}>
							{payload.attachments.length > 0
								? "附件里没有可直接读取的指导书正文，请下载附件查看。"
								: "该任务没有上传指导书附件。"}
						</div>
					)}
				</div>
			</div>

			<div style={STYLES.section}>
				<div style={STYLES.sectionHead}>
					<span>附件</span>
					<span style={STYLES.muted}>{payload.attachments.length} 个</span>
				</div>
				<div style={{ ...STYLES.sectionBody, whiteSpace: "normal" }}>
					{payload.attachments.length === 0 ? (
						<div style={STYLES.muted}>无附件</div>
					) : (
						payload.attachments.map((a) => (
							<div key={a.id} style={STYLES.attachmentRow}>
								<span style={STYLES.attachmentName}>
									📎 {a.name} {formatBytes(a.size) ? <span style={STYLES.muted}>{formatBytes(a.size)}</span> : null}
								</span>
								<button type="button" style={STYLES.link} disabled={busy} onClick={() => openAttachment(a.id)}>
									下载
								</button>
							</div>
						))
					)}
				</div>
			</div>

			<div style={STYLES.section}>
				<div style={STYLES.sectionHead}>
					<span>模板代码</span>
					<button type="button" style={STYLES.link} onClick={() => setTemplateOpen((v) => !v)}>
						{templateOpen ? "收起" : "展开"}
					</button>
				</div>
				<div style={{ ...STYLES.sectionBody, whiteSpace: "normal" }}>
					{payload.templateCode.trim() ? (
						templateOpen ? (
							<pre style={STYLES.pre}>{payload.templateCode}</pre>
						) : (
							<div style={STYLES.muted}>共 {payload.templateCode.length} 字符，点击「展开」查看</div>
						)
					) : (
						<div style={STYLES.muted}>该任务没有预置模板，开始实验时会生成带 TODO 注释的空文件。</div>
					)}
				</div>
			</div>

			{payload.started && payload.experimentDir ? (
				<div style={{ ...STYLES.muted, marginTop: "14px" }}>实验目录：{payload.experimentDir}</div>
			) : null}

			<div style={STYLES.footer}>
				{payload.sessionActive ? (
					<>
						<button type="button" style={STYLES.primaryButton} disabled={busy} onClick={submitExperiment}>
							提交实验
						</button>
						{confirmingEnd ? (
							<>
								<span style={STYLES.muted}>确认结束实验？（实验目录与日志会保留）</span>
								<button type="button" style={STYLES.dangerButton} disabled={busy} onClick={endExperiment}>
									确认结束
								</button>
								<button type="button" style={STYLES.secondaryButton} onClick={() => setConfirmingEnd(false)}>
									取消
								</button>
							</>
						) : (
							<button type="button" style={STYLES.dangerButton} disabled={busy} onClick={endExperiment}>
								结束实验
							</button>
						)}
					</>
				) : (
					<button type="button" style={STYLES.primaryButton} disabled={busy} onClick={startExperiment}>
						{busy ? "处理中…" : payload.started ? "继续实验" : "开始实验"}
					</button>
				)}
				<button
					type="button"
					style={STYLES.secondaryButton}
					onClick={() => getApi().postMessage({ type: "assignment_detail_command", command: "closeAssignmentDetail" })}>
					关闭
				</button>
				{!payload.started && !payload.sessionActive ? (
					<span style={STYLES.muted}>开始实验会在工作区创建独立子文件夹，并把日志根切到该目录。</span>
				) : null}
			</div>
		</div>
	)
}
