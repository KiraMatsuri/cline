/**
 * =============================================================================
 *  ThinkingQuestionsForm — 提交前思考题答题页（v2.13 增量）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【位置】渲染在编辑器区 WebviewPanel（ThinkingQuestionsPanelProvider 创建），
 * 与 FeedbackForm 同一范式：高度充足、全页铺开、答案框多行不局促。
 *
 * 【数据流】
 *   点击上传 → 扩展本地收集代码/日志/运行痕迹 → 生成 3~5 道思考题
 *     → 打开本面板（此时**还没有上传任何东西**）
 *   学生答完 → postMessage({command:"confirmAnswers", answers})
 *     → Provider 校验 → AssignmentManager.confirmSubmission → 一次 multipart 上传
 *   成功 → 成功态 → 1.5s 后自动关面板；失败 → 红字提示，答案保留可重试
 *
 * 设计文档：docs/design/teaching-submission-bundle-design.md §7
 * =============================================================================
 */

import type { FC } from "react"
import { useEffect, useMemo, useState } from "react"
import { getVsCodeApiInstance } from "@/config/platform.config"

// ============================================================================
//  类型与常量
// ============================================================================

interface VsCodeApi {
	postMessage(message: Record<string, unknown>): void
}

/** 与扩展侧 bundleTypes.ts 的 BundleQuestion 对齐（只取本页要用的字段） */
interface QuestionView {
	seq: number
	question: string
	intent?: string
	difficulty?: "easy" | "medium" | "hard"
	hint?: string
}

/** 扩展 → 本页的载荷（对应 ThinkingQuestionsPayload） */
interface QuestionsPayload {
	assignmentId: string
	assignmentTitle: string
	assignmentDescription?: string
	questions: QuestionView[]
	codeFiles: { relPath: string; sizeBytes: number }[]
	logPath: string | null
	logLineCount: number
	runTraceCount: number
	generatedBy: "llm" | "template" | "mixed"
	questionWarning?: string
	questionCountReason?: string
	submittedAt: string
	/** 已打码的敏感信息处数（BN-11） */
	redactionHits?: number
	/** 内容取自编辑器缓冲区、磁盘未保存的文件（BN-16） */
	unsavedFiles?: string[]
	/** 出题实际使用的 provider / 模型（来自 Cline 自带设置；缺省表示本次是通用题） */
	llmProvider?: string
	llmModel?: string
}

interface PanelResponse {
	command?: string
	success?: boolean
	data?: unknown
	error?: string
	uploading?: boolean
}

const MAX_ANSWER_LENGTH = 2000

const DIFFICULTY_LABEL: Record<"easy" | "medium" | "hard", string> = {
	easy: "基础",
	medium: "进阶",
	hard: "拓展",
}

// ============================================================================
//  组件
// ============================================================================

const ThinkingQuestionsForm: FC = () => {
	const [payload, setPayload] = useState<QuestionsPayload | null>(null)
	const [answers, setAnswers] = useState<Record<number, string>>({})
	const [submitting, setSubmitting] = useState<boolean>(false)
	const [uploading, setUploading] = useState<boolean>(false)
	const [error, setError] = useState<string>("")
	const [done, setDone] = useState<boolean>(false)
	const [resultText, setResultText] = useState<string>("")

	const getVsCodeApi = (): VsCodeApi | null => {
		const api = getVsCodeApiInstance()
		if (!api) {
			console.warn("[ThinkingQuestionsForm] VS Code API 不可用")
			return null
		}
		return api as VsCodeApi
	}

	// ----- 握手：告诉扩展「面板已就绪，请推载荷」 -----
	useEffect(() => {
		getVsCodeApi()?.postMessage({ type: "thinking_command", command: "ready" })
	}, [])

	// ----- 监听扩展回推 -----
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const msg = event.data as PanelResponse
			if (!msg || typeof msg.command !== "string") return

			if (msg.command === "loadQuestions") {
				if (msg.success && msg.data) {
					setPayload(msg.data as QuestionsPayload)
					setAnswers({})
					setError("")
				} else {
					setError(msg.error ?? "无法加载思考题，请回到任务列表重新点击上传")
				}
				return
			}

			if (msg.command === "confirmAnswers") {
				// 扩展收到确认后先回一条 uploading 占位，避免学生误以为没反应
				if (msg.uploading) {
					setUploading(true)
					return
				}
				setSubmitting(false)
				setUploading(false)
				if (msg.success) {
					const data = msg.data as { revision?: number; metrics?: { ai_dependency?: number } } | undefined
					const revision = typeof data?.revision === "number" ? `（第 ${data.revision} 版）` : ""
					const aiDep =
						typeof data?.metrics?.ai_dependency === "number"
							? `｜AI 依赖度 ${Math.round(data.metrics.ai_dependency * 100)}%`
							: ""
					setResultText(`代码、日志与思考题答案已上传${revision}${aiDep}`)
					setDone(true)
					setTimeout(() => {
						getVsCodeApi()?.postMessage({ type: "thinking_command", command: "cancelThinkingQuestions" })
					}, 1500)
				} else {
					setError(msg.error || "上传失败，请稍后重试")
				}
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	// ----- 是否全部作答 -----
	const allAnswered = useMemo(() => {
		if (!payload) return false
		return payload.questions.every((q) => (answers[q.seq] ?? "").trim().length > 0)
	}, [payload, answers])

	const answeredCount = useMemo(() => {
		if (!payload) return 0
		return payload.questions.filter((q) => (answers[q.seq] ?? "").trim().length > 0).length
	}, [payload, answers])

	const onConfirm = () => {
		if (!payload) return
		if (!allAnswered) {
			setError("请把每道题都答完再提交")
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
			type: "thinking_command",
			command: "confirmAnswers",
			answers: payload.questions.map((q) => ({ seq: q.seq, answer: (answers[q.seq] ?? "").trim() })),
		})
	}

	const onCancel = () => {
		getVsCodeApi()?.postMessage({ type: "thinking_command", command: "cancelThinkingQuestions" })
	}

	// ----- 成功态 -----
	if (done) {
		return (
			<div style={styles.container}>
				<div style={styles.doneCard}>
					<div style={styles.doneIcon}>✅</div>
					<h2 style={styles.doneTitle}>提交完成</h2>
					<p style={styles.doneText}>{resultText || "已提交至教学服务器"}，窗口即将自动关闭…</p>
				</div>
			</div>
		)
	}

	// ----- 载荷未到 -----
	if (!payload) {
		return (
			<div style={styles.container}>
				<h2 style={styles.title}>💭 提交前思考题</h2>
				<p style={styles.subtitle}>{error ? `❌ ${error}` : "正在准备题目与提交材料…"}</p>
			</div>
		)
	}

	// ----- 答题态 -----
	return (
		<div style={styles.container}>
			<h2 style={styles.title}>💭 提交前思考题</h2>
			<p style={styles.subtitle}>
				实验任务：<strong>{payload.assignmentTitle}</strong>（{payload.assignmentId}）
				<br />
				请先回答下面 {payload.questions.length}{" "}
				道题。点「确认提交」后，你的代码文件、行为日志与这些答案才会一并上传到教学服务器。
			</p>

			<div style={styles.chipRow}>
				<span style={styles.chip}>📄 代码文件 {payload.codeFiles.length} 个</span>
				<span style={styles.chip}>🧾 日志 {payload.logLineCount} 行</span>
				<span style={styles.chip}>▶️ 运行痕迹 {payload.runTraceCount} 条</span>
				<span style={styles.chip}>
					{payload.generatedBy === "llm"
						? "🧠 模型出题"
						: payload.generatedBy === "mixed"
							? "🧠+🧩 混合出题"
							: "🧩 通用题"}
				</span>
				{payload.llmProvider ? (
					<span style={styles.chip} title="出题使用的模型与 API Key 直接取自 Cline 设置，无需另外填写">
						🤖 {payload.llmProvider}
						{payload.llmModel ? ` · ${payload.llmModel}` : ""}
					</span>
				) : null}
				<span style={styles.chip}>
					已答 {answeredCount}/{payload.questions.length}
				</span>
				{payload.redactionHits ? <span style={styles.chip}>🔒 已打码 {payload.redactionHits} 处</span> : null}
				{payload.unsavedFiles && payload.unsavedFiles.length > 0 ? (
					<span style={styles.chip}>💾 未保存 {payload.unsavedFiles.length} 个（取编辑器内容）</span>
				) : null}
			</div>

			{payload.questionCountReason && <p style={styles.reasonLine}>题数说明：{payload.questionCountReason}</p>}

			{payload.questionWarning && <p style={styles.warnNotice}>⚠️ {payload.questionWarning}</p>}

			{payload.logPath === null && (
				<p style={styles.warnNotice}>⚠️ 没有找到行为日志文件，本次将只上传代码与答案（不影响提交）。</p>
			)}

			{payload.redactionHits ? (
				<p style={styles.reasonLine}>
					🔒 检测到 {payload.redactionHits} 处疑似密钥/口令，已在本地替换为 ***REDACTED***
					后再上传（原文不会离开你的电脑）。
				</p>
			) : null}

			{payload.unsavedFiles && payload.unsavedFiles.length > 0 ? (
				<p style={styles.reasonLine}>
					💾 以下文件还没保存到磁盘，本次提交使用编辑器里的当前内容：
					{payload.unsavedFiles.map((file) => ` ${file}`).join("、")}
				</p>
			) : null}

			{payload.questions.map((question) => {
				const value = answers[question.seq] ?? ""
				return (
					<div key={question.seq} style={styles.questionCard}>
						<div style={styles.questionHeader}>
							<span style={styles.seqBadge}>{question.seq}</span>
							<span style={styles.questionText}>{question.question}</span>
							{question.difficulty && (
								<span style={styles.difficultyBadge}>{DIFFICULTY_LABEL[question.difficulty]}</span>
							)}
						</div>
						{question.hint && <p style={styles.hint}>💡 {question.hint}</p>}
						<textarea
							maxLength={MAX_ANSWER_LENGTH}
							onChange={(e) => setAnswers((prev) => ({ ...prev, [question.seq]: e.target.value }))}
							placeholder="写下你的思路、遇到的问题和判断依据…"
							rows={4}
							style={styles.textarea}
							value={value}
						/>
						<div style={styles.charCount}>
							{value.length}/{MAX_ANSWER_LENGTH}
						</div>
					</div>
				)
			})}

			{error && <div style={styles.errorNotice}>❌ {error}</div>}

			<div style={styles.buttonRow}>
				<button disabled={submitting} onClick={onCancel} style={{ ...styles.button, ...styles.secondaryButton }}>
					取消
				</button>
				<button
					disabled={submitting || !allAnswered}
					onClick={onConfirm}
					style={{
						...styles.button,
						...styles.primaryButton,
						...(submitting || !allAnswered ? styles.disabledButton : {}),
					}}>
					{submitting ? (uploading ? "上传中..." : "提交中...") : "确认提交"}
				</button>
			</div>
		</div>
	)
}

// ============================================================================
//  样式（与 FeedbackForm 保持一致：内联 + VS Code 主题变量）
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
	container: {
		padding: "28px 32px",
		maxWidth: 860,
		margin: "0 auto",
		color: "var(--vscode-foreground)",
		fontSize: 13,
	},
	title: { margin: "0 0 8px 0", fontSize: 20, fontWeight: 700 },
	subtitle: {
		margin: "0 0 16px 0",
		fontSize: 12,
		color: "var(--vscode-descriptionForeground)",
		lineHeight: 1.7,
	},
	chipRow: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 },
	reasonLine: {
		margin: "0 0 12px 0",
		fontSize: 11,
		color: "var(--vscode-descriptionForeground)",
	},
	chip: {
		padding: "3px 10px",
		borderRadius: 12,
		fontSize: 11,
		background: "var(--vscode-badge-background)",
		color: "var(--vscode-badge-foreground)",
	},
	questionCard: {
		border: "1px solid var(--vscode-panel-border)",
		borderRadius: 6,
		padding: "14px 16px",
		marginBottom: 14,
		background: "var(--vscode-editorWidget-background)",
	},
	questionHeader: { display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8 },
	seqBadge: {
		flexShrink: 0,
		width: 22,
		height: 22,
		borderRadius: 11,
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		fontSize: 12,
		fontWeight: 700,
		background: "var(--vscode-button-background)",
		color: "var(--vscode-button-foreground)",
	},
	questionText: { flex: 1, fontWeight: 600, lineHeight: 1.7 },
	difficultyBadge: {
		flexShrink: 0,
		padding: "1px 8px",
		borderRadius: 10,
		fontSize: 11,
		border: "1px solid var(--vscode-panel-border)",
		color: "var(--vscode-descriptionForeground)",
	},
	hint: { margin: "0 0 8px 32px", fontSize: 11, color: "var(--vscode-descriptionForeground)" },
	textarea: {
		width: "100%",
		padding: "10px 12px",
		borderRadius: 4,
		border: "1px solid var(--vscode-input-border, transparent)",
		background: "var(--vscode-input-background)",
		color: "var(--vscode-input-foreground)",
		fontSize: 13,
		fontFamily: "inherit",
		lineHeight: 1.6,
		resize: "vertical",
		boxSizing: "border-box",
	},
	charCount: {
		marginTop: 4,
		textAlign: "right",
		fontSize: 11,
		color: "var(--vscode-descriptionForeground)",
	},
	warnNotice: {
		margin: "0 0 14px 0",
		padding: "8px 12px",
		borderRadius: 4,
		fontSize: 12,
		background: "var(--vscode-inputValidation-warningBackground)",
		border: "1px solid var(--vscode-inputValidation-warningBorder)",
	},
	errorNotice: {
		margin: "10px 0",
		padding: "8px 12px",
		borderRadius: 4,
		fontSize: 12,
		background: "var(--vscode-inputValidation-errorBackground)",
		border: "1px solid var(--vscode-inputValidation-errorBorder)",
	},
	buttonRow: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 },
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
	disabledButton: { opacity: 0.5, cursor: "not-allowed" },
	doneCard: {
		maxWidth: 560,
		margin: "60px auto",
		padding: "32px",
		borderRadius: 8,
		textAlign: "center",
		border: "1px solid var(--vscode-panel-border)",
		background: "var(--vscode-editorWidget-background)",
	},
	doneIcon: { fontSize: 44, marginBottom: 12 },
	doneTitle: { margin: "0 0 10px 0", fontSize: 18, fontWeight: 700 },
	doneText: { margin: 0, fontSize: 13, color: "var(--vscode-descriptionForeground)", lineHeight: 1.7 },
}

export default ThinkingQuestionsForm
