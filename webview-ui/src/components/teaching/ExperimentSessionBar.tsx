/**
 * 实验态横幅（Task5）
 *
 * 为什么放在聊天界面顶部而不是任务列表：学生点「开始实验」后主要停留在对话框里
 * 写代码/提问；「提交实验」「结束实验」是实验会话的两个唯一出口，必须随时可见。
 *
 * 状态来源是扩展侧会话文件（`.cline-logs/active-experiment.json`）的广播，而不是
 * 前端自己记：新建任务、返回对话、重载窗口后横幅都由 `getExperimentSession` 回填，
 * 避免出现「界面显示自由模式、后台仍是实验模式」的双份真相。
 */

import type React from "react"
import { useCallback, useEffect, useState } from "react"
import { getVsCodeApiInstance } from "@/config/platform.config"

interface VsCodeApi {
	postMessage(message: Record<string, unknown>): void
}

interface ExperimentSessionView {
	active: boolean
	assignmentId?: string
	assignmentTitle?: string
	logRoot?: string
}

const STYLES = {
	bar: {
		display: "flex",
		alignItems: "center",
		gap: "10px",
		padding: "8px 12px",
		margin: "6px 8px 0",
		borderRadius: "6px",
		border: "1px solid var(--vscode-panel-border, rgba(128,128,128,.35))",
		background: "var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.12))",
		fontSize: "12px",
		flexWrap: "wrap",
	} as React.CSSProperties,
	title: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
	spacer: { flex: 1 } as React.CSSProperties,
	primaryButton: {
		padding: "4px 12px",
		borderRadius: "3px",
		border: "none",
		cursor: "pointer",
		fontSize: "12px",
		fontWeight: 600,
		background: "var(--vscode-button-background)",
		color: "var(--vscode-button-foreground)",
	} as React.CSSProperties,
	dangerButton: {
		padding: "4px 12px",
		borderRadius: "3px",
		border: "none",
		cursor: "pointer",
		fontSize: "12px",
		fontWeight: 600,
		// 红色背景：结束实验是破坏性操作，必须和「提交实验」在视觉上区分开
		background: "var(--vscode-errorForeground, #d32f2f)",
		color: "#ffffff",
	} as React.CSSProperties,
	ghostButton: {
		padding: "4px 10px",
		borderRadius: "3px",
		border: "1px solid var(--vscode-panel-border, rgba(128,128,128,.4))",
		cursor: "pointer",
		fontSize: "12px",
		background: "transparent",
		color: "var(--vscode-foreground)",
	} as React.CSSProperties,
	error: { color: "var(--vscode-errorForeground, #d32f2f)", width: "100%" } as React.CSSProperties,
}

export default function ExperimentSessionBar() {
	const [session, setSession] = useState<ExperimentSessionView>({ active: false })
	const [busy, setBusy] = useState(false)
	const [confirmingEnd, setConfirmingEnd] = useState(false)
	const [error, setError] = useState("")

	const getApi = useCallback((): VsCodeApi | null => getVsCodeApiInstance() as unknown as VsCodeApi | null, [])

	useEffect(() => {
		const api = getApi()
		const handler = (event: MessageEvent) => {
			const msg = event.data as { command?: string; success?: boolean; error?: string; data?: unknown } | undefined
			if (!msg?.command) return
			if (msg.command === "getExperimentSession") {
				const view = (msg.data ?? { active: false }) as ExperimentSessionView
				setSession(view.active ? view : { active: false })
				setBusy(false)
				if (!view.active) setConfirmingEnd(false)
				return
			}
			if (msg.command === "submitExperiment" || msg.command === "endExperiment" || msg.command === "prepareSubmission") {
				setBusy(false)
				if (msg.success === false) setError(msg.error ?? "操作失败")
				return
			}
		}
		window.addEventListener("message", handler)
		api?.postMessage({ type: "assignment_command", command: "getExperimentSession" })
		return () => window.removeEventListener("message", handler)
	}, [getApi])

	if (!session.active) return null

	const submit = () => {
		setBusy(true)
		setError("")
		getApi()?.postMessage({ type: "assignment_command", command: "submitExperiment" })
	}

	const end = () => {
		if (!confirmingEnd) {
			setConfirmingEnd(true)
			return
		}
		setBusy(true)
		setError("")
		getApi()?.postMessage({ type: "assignment_command", command: "endExperiment" })
	}

	return (
		<div style={STYLES.bar}>
			<span style={STYLES.title}>🧪 实验进行中：{session.assignmentTitle ?? session.assignmentId ?? "未命名实验"}</span>
			<span style={STYLES.spacer} />
			<button type="button" style={STYLES.primaryButton} disabled={busy} onClick={submit}>
				提交实验
			</button>
			{confirmingEnd ? (
				<>
					<span>确认结束实验？（实验目录与日志会保留）</span>
					<button type="button" style={STYLES.dangerButton} disabled={busy} onClick={end}>
						确认结束
					</button>
					<button type="button" style={STYLES.ghostButton} onClick={() => setConfirmingEnd(false)}>
						取消
					</button>
				</>
			) : (
				<button type="button" style={STYLES.dangerButton} disabled={busy} onClick={end}>
					结束实验
				</button>
			)}
			{error ? <div style={STYLES.error}>{error}</div> : null}
		</div>
	)
}
