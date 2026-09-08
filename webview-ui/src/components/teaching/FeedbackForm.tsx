/**
 * =============================================================================
 *  FeedbackForm — 问题反馈全页表单（v2.9.2 增量）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【迁移背景】
 * v2.9.1 之前反馈为 LLM 设置页内的 ResponsiveModal 弹窗。LLM 设置视图是
 * 侧栏中的独立 webview，用户通常保持较小高度，高弹窗即使锁定可视视口
 * 也只能"顶格显示 + 内部滚动"，体验局促。
 *
 * 【本页定位】
 * 渲染在编辑器区 WebviewPanel（FeedbackPanelProvider 创建，窗口正中），
 * 高度/宽度充足，表单全页铺开无裁切 —— VS Code 表单类 UI 的标准范式
 * （同设置界面 / 快捷键编辑器）。
 *
 * 【数据流】
 *   提交 → postMessage({type:"wiki_command", command:"submitFeedback", ...})
 *     → FeedbackPanelProvider：附加插件版本 + 平台 → POST /api/v1/feedback
 *   成功 → 本页切换成功态 → 1.2s 后 postMessage closeFeedbackPanel 自动关面板
 *   失败 → 红字提示，已填内容保留
 *
 * =============================================================================
 */

import type { FC } from "react"
import { useEffect, useState } from "react"
import { getVsCodeApiInstance } from "@/config/platform.config"

// ============================================================================
//  类型与常量
// ============================================================================

/** VS Code API 抽象 */
interface VsCodeApi {
	postMessage(message: Record<string, unknown>): void
}

/** Extension → Webview 的响应 */
interface PanelResponse {
	command: string
	success: boolean
	data?: unknown
	error?: string
}

/** 反馈类型选项（与 teaching-server FEEDBACK_CATEGORIES 对齐） */
const FEEDBACK_CATEGORY_OPTIONS: { value: "bug" | "feature" | "other"; label: string; hint: string }[] = [
	{ value: "bug", label: "🐛 Bug 反馈", hint: "功能异常、报错、显示问题" },
	{ value: "feature", label: "💡 功能建议", hint: "希望新增或改进的功能" },
	{ value: "other", label: "📝 其他", hint: "使用疑问、体验反馈等" },
]

// ============================================================================
//  组件
// ============================================================================

const FeedbackForm: FC = () => {
	// ----- 状态 -----
	const [category, setCategory] = useState<"bug" | "feature" | "other">("bug")
	const [content, setContent] = useState<string>("")
	const [studentId, setStudentId] = useState<string>("")
	const [submitting, setSubmitting] = useState<boolean>(false)
	const [error, setError] = useState<string>("")
	const [done, setDone] = useState<boolean>(false)

	// ----- VS Code API -----
	const getVsCodeApi = (): VsCodeApi | null => {
		const api = getVsCodeApiInstance()
		if (!api) {
			console.warn("[FeedbackForm] VS Code API 不可用")
			return null
		}
		return api as VsCodeApi
	}

	// ----- 监听提交结果 -----
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const msg = event.data as PanelResponse
			if (msg?.command !== "submitFeedback") return
			setSubmitting(false)
			if (msg.success) {
				setDone(true)
				// 展示成功态 1.2s 后自动关闭面板
				setTimeout(() => {
					getVsCodeApi()?.postMessage({ type: "wiki_command", command: "closeFeedbackPanel" })
				}, 1200)
			} else {
				setError(msg.error ?? "提交失败，请稍后重试")
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	// ----- 提交 -----
	const onSubmit = () => {
		const text = content.trim()
		if (!text) {
			setError("请填写反馈内容")
			return
		}
		const api = getVsCodeApi()
		if (!api) {
			setError("VS Code API 不可用")
			return
		}
		setSubmitting(true)
		setError("")
		api.postMessage({
			type: "wiki_command",
			command: "submitFeedback",
			category,
			content: text,
			studentId: studentId.trim(),
		})
	}

	// ----- 关闭面板 -----
	const onClose = () => {
		getVsCodeApi()?.postMessage({ type: "wiki_command", command: "closeFeedbackPanel" })
	}

	// ----- 成功态 -----
	if (done) {
		return (
			<div style={styles.container}>
				<div style={styles.doneCard}>
					<div style={styles.doneIcon}>✅</div>
					<h2 style={styles.doneTitle}>反馈已提交</h2>
					<p style={styles.doneText}>感谢你的支持！我们会尽快处理，窗口即将自动关闭…</p>
				</div>
			</div>
		)
	}

	// ----- 表单态 -----
	return (
		<div style={styles.container}>
			<h2 style={styles.title}>📝 问题反馈</h2>
			<p style={styles.subtitle}>发现 bug 或有改进建议？告诉我们。反馈提交至教学服务器，开发者会尽快查看处理。</p>

			<label style={styles.label}>反馈类型</label>
			<div style={styles.categoryRow}>
				{FEEDBACK_CATEGORY_OPTIONS.map((opt) => (
					<button
						key={opt.value}
						onClick={() => setCategory(opt.value)}
						style={{
							...styles.button,
							...(category === opt.value ? styles.primaryButton : styles.secondaryButton),
							display: "flex",
							flexDirection: "column",
							alignItems: "flex-start",
							gap: 4,
							padding: "10px 14px",
							flex: 1,
						}}>
						<span>{opt.label}</span>
						<span style={{ fontSize: 11, fontWeight: 400, opacity: 0.8 }}>{opt.hint}</span>
					</button>
				))}
			</div>

			<label style={styles.label}>反馈内容 *</label>
			<textarea
				maxLength={5000}
				onChange={(e) => setContent(e.target.value)}
				placeholder={"请描述遇到的问题或建议。\nBug 请尽量说明：操作步骤 → 期望结果 → 实际结果"}
				rows={10}
				style={styles.textarea}
				value={content}
			/>
			<div style={styles.charCount}>{content.length}/5000</div>

			<label style={styles.label}>学号（选填）</label>
			<input
				maxLength={50}
				onChange={(e) => setStudentId(e.target.value)}
				placeholder="选填，便于我们回访澄清问题"
				style={styles.input}
				type="text"
				value={studentId}
			/>

			<p style={styles.privacyHint}>🔒 提交时自动附带插件版本与操作系统信息（仅用于定位问题），不收集其他数据。</p>

			{error && <div style={styles.errorNotice}>❌ {error}</div>}

			<div style={styles.buttonRow}>
				<button onClick={onClose} style={{ ...styles.button, ...styles.secondaryButton }}>
					取消
				</button>
				<button disabled={submitting} onClick={onSubmit} style={{ ...styles.button, ...styles.primaryButton }}>
					{submitting ? "提交中..." : "提交反馈"}
				</button>
			</div>
		</div>
	)
}

// ============================================================================
//  样式
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
	container: {
		padding: "28px 32px",
		maxWidth: 680,
		margin: "0 auto",
		color: "var(--vscode-foreground)",
		fontSize: 13,
	},
	title: { margin: "0 0 8px 0", fontSize: 20, fontWeight: 700 },
	subtitle: {
		margin: "0 0 22px 0",
		fontSize: 12,
		color: "var(--vscode-descriptionForeground)",
		lineHeight: 1.6,
	},
	label: { display: "block", marginBottom: 8, fontWeight: 600 },
	categoryRow: {
		display: "flex",
		gap: 10,
		marginBottom: 18,
	},
	button: {
		padding: "8px 18px",
		border: "none",
		borderRadius: 4,
		fontSize: 13,
		fontWeight: 600,
		cursor: "pointer",
	},
	primaryButton: {
		background: "var(--vscode-button-background)",
		color: "var(--vscode-button-foreground)",
	},
	secondaryButton: {
		background: "var(--vscode-button-secondaryBackground)",
		color: "var(--vscode-button-secondaryForeground)",
	},
	textarea: {
		width: "100%",
		padding: "10px 12px",
		background: "var(--vscode-input-background)",
		color: "var(--vscode-input-foreground)",
		border: "1px solid var(--vscode-input-border)",
		borderRadius: 4,
		fontSize: 13,
		fontFamily: "inherit",
		resize: "vertical",
		boxSizing: "border-box",
		lineHeight: 1.6,
	},
	input: {
		width: "100%",
		padding: "8px 12px",
		background: "var(--vscode-input-background)",
		color: "var(--vscode-input-foreground)",
		border: "1px solid var(--vscode-input-border)",
		borderRadius: 4,
		fontSize: 13,
		boxSizing: "border-box",
	},
	charCount: {
		textAlign: "right",
		fontSize: 11,
		color: "var(--vscode-descriptionForeground)",
		margin: "4px 0 16px 0",
	},
	privacyHint: {
		margin: "14px 0 0 0",
		fontSize: 11,
		color: "var(--vscode-descriptionForeground)",
		lineHeight: 1.5,
	},
	errorNotice: {
		marginTop: 14,
		padding: 10,
		borderRadius: 4,
		background: "var(--vscode-inputValidation-errorBackground, rgba(255,0,0,0.1))",
		color: "var(--vscode-errorForeground)",
		fontSize: 12,
	},
	buttonRow: {
		display: "flex",
		gap: 10,
		justifyContent: "flex-end",
		marginTop: 20,
	},
	doneCard: {
		textAlign: "center",
		padding: "60px 20px",
	},
	doneIcon: { fontSize: 48, marginBottom: 12 },
	doneTitle: { margin: "0 0 8px 0", fontSize: 18 },
	doneText: {
		margin: 0,
		fontSize: 12,
		color: "var(--vscode-descriptionForeground)",
	},
}

export default FeedbackForm
