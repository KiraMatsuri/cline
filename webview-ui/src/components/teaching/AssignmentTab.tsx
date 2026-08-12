/**
 * =============================================================================
 *  AssignmentTab — 实验任务拉取与一键提交（Webview 侧边栏前端组件）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【功能说明】
 * 本组件是 VS Code 侧边栏中的"实验任务"选项卡，提供：
 * 1. 点击"获取任务"按钮，从后端拉取实验任务列表
 * 2. 展示任务列表，支持选中查看 Markdown 实验指导书
 * 3. 点击"一键提交实验结果至云端"按钮，提交代码 + 行为日志
 *
 * 【IPC 通信协议】
 * 本组件通过 acquireVsCodeApi().postMessage() 与插件后台通信：
 *
 *   Webview (AssignmentTab)                Extension (AssignmentManager)
 *   ───────────────────────                ────────────────────────────
 *   postMessage({ command: 'fetchAssignments' })
 *     ─────────────────────────────────────────▶  获取任务列表
 *   ◀─────────────────────────────────────────  { command, success, data }
 *   渲染任务列表
 *
 *   postMessage({ command: 'submitTask', payload: { assignmentId } })
 *     ─────────────────────────────────────────▶  读取日志 + POST 提交
 *   ◀─────────────────────────────────────────  { command, success, data }
 *   显示提交结果
 *
 *   postMessage({ command: 'openFile', payload: { filePath } })
 *     ─────────────────────────────────────────▶  在编辑器中打开文件
 *
 * 【与 Web 端的数据串联】
 *   本组件获取的任务数据来源于 teaching-server 的 assignments 表，
 *   与 Web 教师端 (AssignmentPublish.tsx) 共享同一数据源。
 *   提交时写入 submissions 表，最终在学情画像看板中聚合展示。
 *
 * =============================================================================
 */

import type { FC } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { getVsCodeApiInstance } from "@/config/platform.config"

// 【v2.3 改造】移除 AssignmentHeader（Wiki 进度感知区与其他按钮功能重复，已删除）
// import AssignmentHeader from "./AssignmentHeader"

// ============================================================================
//  类型定义
// ============================================================================

/** 实验任务 —— 与后端接口对齐 */
interface Assignment {
	id: string
	title: string
	week: number
	description?: string
	template_code?: string
	attachments?: Attachment[]
}

/** 附件信息 */
interface Attachment {
	id: number
	original_name: string
	file_size: number
	mime_type: string
}

/** Extension → Webview 的响应消息 */
interface AssignmentResponse {
	command: string
	success: boolean
	data?: unknown
	error?: string
}

/** VS Code API 的类型声明 */
interface VsCodeApi {
	postMessage(message: Record<string, unknown>): void
	getState(): Record<string, unknown> | undefined
	setState(state: Record<string, unknown>): void
}

// ============================================================================
//  工具函数
// ============================================================================

/**
 * 【重要】不要在这里再次调用 acquireVsCodeApi() —— VS Code Webview 全局只允许
 * 调用一次，platform.config.ts 在模块加载时已经调用过。
 *
 * 直接复用平台配置中导出的 vsCodeApi 实例。
 * 如果不在 Webview 环境（独立站 standalone 模式），返回 null，
 * 调用方应当容忍此情况。
 */
function getVsCodeApi(): VsCodeApi | null {
	const api = getVsCodeApiInstance()
	if (!api) {
		// 在 standalone 模式或开发环境裸跑时可能拿不到 API
		console.warn("[AssignmentTab] VS Code API 不可用，部分功能将不工作")
		return null
	}
	return api as VsCodeApi
}

/** 格式化文件大小 */
function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ============================================================================
//  样式常量（内联样式，避免额外 CSS 依赖）
// ============================================================================

const styles = {
	container: {
		display: "flex",
		flexDirection: "column" as const,
		height: "100%",
		padding: "12px",
		gap: "12px",
		overflowY: "auto" as const,
	},
	header: {
		fontSize: "16px",
		fontWeight: 700,
		color: "var(--vscode-sideBarTitle-foreground)",
		margin: 0,
		padding: "0 0 8px 0",
		borderBottom: "1px solid var(--vscode-panel-border)",
	},
	button: {
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		gap: "6px",
		width: "100%",
		padding: "10px 16px",
		border: "none",
		borderRadius: "6px",
		fontSize: "13px",
		fontWeight: 600,
		cursor: "pointer",
		transition: "opacity 0.15s",
	},
	primaryButton: {
		backgroundColor: "var(--vscode-button-background)",
		color: "var(--vscode-button-foreground)",
	},
	primaryButtonDisabled: {
		opacity: 0.5,
		cursor: "not-allowed",
	},
	dangerButton: {
		backgroundColor: "var(--vscode-errorForeground)",
		color: "#ffffff",
	},
	taskCard: {
		padding: "10px 12px",
		borderRadius: "6px",
		border: "1px solid var(--vscode-panel-border)",
		cursor: "pointer",
		transition: "background 0.15s",
	},
	taskCardSelected: {
		borderColor: "var(--vscode-focusBorder)",
		backgroundColor: "var(--vscode-list-activeSelectionBackground)",
		color: "var(--vscode-list-activeSelectionForeground)",
	},
	taskTitle: {
		fontSize: "13px",
		fontWeight: 600,
		margin: 0,
	},
	taskMeta: {
		fontSize: "11px",
		color: "var(--vscode-descriptionForeground)",
		marginTop: "4px",
	},
	badge: {
		display: "inlineBlock",
		padding: "1px 6px",
		borderRadius: "4px",
		fontSize: "10px",
		fontWeight: 600,
		backgroundColor: "var(--vscode-badge-background)",
		color: "var(--vscode-badge-foreground)",
	},
	descriptionBox: {
		padding: "10px 12px",
		borderRadius: "6px",
		border: "1px solid var(--vscode-panel-border)",
		fontSize: "12px",
		lineHeight: "1.6",
		maxHeight: "200px",
		overflowY: "auto" as const,
		whiteSpace: "pre-wrap" as const,
		fontFamily: "var(--vscode-editor-font-family)",
	},
	statusBar: {
		padding: "8px 12px",
		borderRadius: "6px",
		fontSize: "12px",
		fontWeight: 500,
	},
	statusSuccess: {
		backgroundColor: "var(--vscode-testing-iconPassed)",
		color: "#ffffff",
	},
	statusError: {
		backgroundColor: "var(--vscode-testing-iconFailed)",
		color: "#ffffff",
	},
	statusInfo: {
		backgroundColor: "var(--vscode-editorInfo-background)",
		color: "var(--vscode-editorInfo-foreground)",
	},
	emptyState: {
		textAlign: "center" as const,
		padding: "24px 12px",
		color: "var(--vscode-descriptionForeground)",
		fontSize: "12px",
	},
	spinner: {
		display: "inlineBlock",
		width: "14px",
		height: "14px",
		border: "2px solid var(--vscode-button-foreground)",
		borderTop: "2px solid transparent",
		borderRadius: "50%",
		animation: "spin 0.8s linear infinite",
	},
	link: {
		color: "var(--vscode-textLink-foreground)",
		cursor: "pointer",
		textDecoration: "underline",
		fontSize: "11px",
	},
	divider: {
		height: "1px",
		backgroundColor: "var(--vscode-panel-border)",
		margin: "4px 0",
	},
	inputGroup: {
		display: "flex",
		flexDirection: "column" as const,
		gap: "4px",
	},
	input: {
		padding: "6px 8px",
		borderRadius: "4px",
		border: "1px solid var(--vscode-input-border)",
		backgroundColor: "var(--vscode-input-background)",
		color: "var(--vscode-input-foreground)",
		fontSize: "12px",
		fontFamily: "inherit",
	},
	label: {
		fontSize: "11px",
		fontWeight: 600,
		color: "var(--vscode-descriptionForeground)",
	},
	attachmentItem: {
		fontSize: "11px",
		color: "var(--vscode-textLink-foreground)",
		cursor: "pointer",
		padding: "2px 0",
	},
}

// ============================================================================
//  AssignmentTab 组件
// ============================================================================

const AssignmentTab: FC = () => {
	/** VS Code API 实例 —— 用于与插件后台通信。
	 * 【v2.4.3 修复】必须先声明 useRef，因为下方 useState 的 lazy initializer
	 * 会引用 vscodeApiRef.current。如果声明在 useState 之后，React 19 / StrictMode
	 * 下会抛 "Cannot access 'vscodeApiRef' before initialization"，导致
	 * 整个组件渲染失败，侧边栏空白。
	 * 使用 useRef 包裹，避免每次重渲染都重新执行 getVsCodeApi()。 */
	const vscodeApiRef = useRef<VsCodeApi | null>(null)
	if (vscodeApiRef.current === null) {
		vscodeApiRef.current = getVsCodeApi()
	}
	const vscodeApi = vscodeApiRef.current

	// ----- 状态管理 -----
	const [assignments, setAssignments] = useState<Assignment[]>([])
	const [selectedTask, setSelectedTask] = useState<Assignment | null>(null)
	const [loading, setLoading] = useState(false)
	const [submitting, setSubmitting] = useState(false)
	const [statusMessage, setStatusMessage] = useState<{
		type: "success" | "error" | "info"
		text: string
	} | null>(null)

	// 学生信息表单状态
	const [studentId, setStudentId] = useState("")
	const [studentName, setStudentName] = useState("")
	const [classId, setClassId] = useState("")
	const [showStudentForm, setShowStudentForm] = useState(false)
	// 【v2.3 阶段4】学生工作区日志文件路径（JSONL），提交时附带。
	// 默认猜测常见路径（先后端从 .env 的 DASHBOARD_LOG_PATH 同步不好，
	// 所以前端用本地常见路径作为兜底）。
	const [logFilePath, setLogFilePath] = useState("")

	// 折叠/展开状态：实验任务列表和学生信息
	const [showTaskList, setShowTaskList] = useState(true)

	// 【v2.3 增量】学习进度（教学周数 1~18）。LLMWikiService.fetchWikiForWeek
	// 会按此周数在主对话 RAG 注入 Wiki 资料。此处放在底部紧凑控件，
	// 避免与"获取实验任务"按钮功能区视觉上重叠。
	const [currentWeek, setCurrentWeek] = useState<number>(() => {
		// 持久化：从 VS Code 全局状态恢复
		try {
			const saved = vscodeApiRef.current?.getState?.()
			const w = (saved as { teachingCurrentWeek?: number } | undefined)?.teachingCurrentWeek
			if (typeof w === "number" && w >= 1 && w <= 18) return w
		} catch {
			// 忽略状态读取异常
		}
		return 1
	})
	const onWeekChange = useCallback((week: number) => {
		setCurrentWeek(week)
		try {
			vscodeApiRef.current?.setState?.({ teachingCurrentWeek: week })
		} catch {
			// 状态写入失败不影响 UI
		}
	}, [])

	// ========================================================================
	//  消息监听：接收 Extension 后台发来的响应
	// ========================================================================

	/**
	 * 在组件挂载时注册 window.message 事件监听器。
	 * Extension 后台通过 webview.postMessage() 发送响应至此。
	 */
	useEffect(() => {
		/**
		 * 处理 Extension 后台的响应消息。
		 * 根据 command 字段分发到不同的处理逻辑。
		 */
		const handleMessage = (event: MessageEvent<AssignmentResponse>) => {
			const message = event.data

			switch (message.command) {
				case "fetchAssignments":
					if (message.success && Array.isArray(message.data)) {
						setAssignments(message.data as Assignment[])
						setStatusMessage({
							type: "success",
							text: `✅ 成功获取 ${(message.data as Assignment[]).length} 个实验任务`,
						})
					} else {
						setStatusMessage({
							type: "error",
							text: `❌ 获取任务失败: ${message.error || "未知错误"}`,
						})
					}
					setLoading(false)
					break

				case "submitTask":
					if (message.success) {
						const aiDep = (message.data as Record<string, unknown>)?.ai_dependency as number | undefined
						const aiDepText = typeof aiDep === "number" ? `${(aiDep * 100).toFixed(1)}%` : "未知"
						setStatusMessage({
							type: "success",
							text: `✅ 实验提交成功！AI依赖度: ${aiDepText}`,
						})
					} else {
						setStatusMessage({
							type: "error",
							text: `❌ 提交失败: ${message.error || "未知错误"}`,
						})
					}
					setSubmitting(false)
					break

				case "saveStudentInfo":
					if (message.success) {
						setStatusMessage({ type: "success", text: "✅ 学生信息已保存" })
						setShowStudentForm(false)
					} else {
						setStatusMessage({
							type: "error",
							text: `❌ 保存失败: ${message.error || "未知错误"}`,
						})
					}
					break

				// 【v2.3 增量】createOneFile 响应处理
				case "createOneFile":
					if (message.success) {
						const fileName = (message.data as { fileName?: string })?.fileName ?? ""
						setStatusMessage({
							type: "success",
							text: `✅ 已创建源码文件${fileName ? `「${fileName}」` : ""}`,
						})
					} else {
						// 失败也提示（失败由 handleCreateOneFile 内部已弹 warning，这里仅更新 statusBar）
						setStatusMessage({
							type: "error",
							text: `❌ 创建失败: ${message.error || "未知错误"}`,
						})
					}
					break
			}
		}

		// 注册全局消息监听器
		window.addEventListener("message", handleMessage)

		// 组件卸载时移除监听器，防止内存泄漏
		return () => {
			window.removeEventListener("message", handleMessage)
		}
	}, [])

	// ========================================================================
	//  ① 获取任务
	// ========================================================================

	/**
	 * 【IPC 消息：fetchAssignments】
	 * 向 Extension 后台发送"获取实验任务"请求。
	 *
	 * 消息流转：
	 *   AssignmentTab (Webview)
	 *     → postMessage({ command: 'fetchAssignments' })
	 *     → AssignmentManager.handleMessage()
	 *     → GET /api/v1/assignments
	 *     → 创建实验文件
	 *     → postMessage() 返回任务列表
	 */
	const handleFetchAssignments = useCallback(() => {
		if (!vscodeApi) return
		setLoading(true)
		setStatusMessage({ type: "info", text: "⏳ 正在获取实验任务..." })
		vscodeApi.postMessage({ type: "assignment_command", command: "fetchAssignments" })
	}, [vscodeApi])

	// ========================================================================
	//  ② 选中任务
	// ========================================================================

	/**
	 * 用户在任务列表中点击某个任务时触发。
	 * 将该任务设为选中状态，展示其 Markdown 实验指导书和附件列表。
	 */
	const handleSelectTask = useCallback((assignment: Assignment) => {
		setSelectedTask(assignment)
	}, [])

	// ========================================================================
	//  ②.b 【v2.3 增量】双击任务项 → 创建单个源码文件
	// ========================================================================

	/**
	 * 【IPC 消息：createOneFile】
	 * 向 Extension 后台发送"为单个任务创建源码文件"请求。
	 *
	 * 消息流转：
	 *   AssignmentTab (Webview)
	 *     → postMessage({ command: 'createOneFile', payload: { assignmentId } })
	 *     → AssignmentManager.handleCreateOneFile()
	 *     → 在当前工作区创建 ${assignment.id}_experiment.py
	 *     → postMessage() 返回创建结果
	 *
	 * 设计动机：v2.3 前 fetchAssignments 会一次性创建所有任务文件，
	 * 不利于"一个任务一个独立工作区"的学生；改为按需创建。
	 */
	const handleCreateOne = useCallback(
		(assignment: Assignment) => {
			if (!vscodeApi) return
			setStatusMessage({
				type: "info",
				text: `⏳ 正在为「${assignment.title}」创建源码文件...`,
			})
			vscodeApi.postMessage({
				type: "assignment_command",
				command: "createOneFile",
				payload: { assignmentId: assignment.id },
			})
		},
		[vscodeApi],
	)

	// ========================================================================
	//  ③ 一键提交
	// ========================================================================

	/**
	 * 【IPC 消息：submitTask】
	 * 向 Extension 后台发送"一键提交实验"请求。
	 *
	 * 消息流转：
	 *   AssignmentTab (Webview)
	 *     → postMessage({ command: 'submitTask', payload: { assignmentId } })
	 *     → AssignmentManager.handleMessage()
	 *     → ① 读取当前编辑器代码
	 *     → ② 读取 .cline-logs 行为日志
	 *     → ③ 读取已保存的学生信息
	 *     → ④ POST /api/v1/submissions
	 *     → ⑤ showInformationMessage 弹出成功提示
	 *     → postMessage() 返回提交结果
	 */
	const handleSubmitTask = useCallback(() => {
		if (!selectedTask) {
			setStatusMessage({ type: "error", text: "⚠️ 请先选择一个实验任务" })
			return
		}
		if (!vscodeApi) return

		setSubmitting(true)
		setStatusMessage({
			type: "info",
			text: `⏳ 正在提交实验「${selectedTask.title}」...`,
		})

		vscodeApi.postMessage({
			type: "assignment_command",
			command: "submitTask",
			payload: { assignmentId: selectedTask.id },
		})
	}, [selectedTask, vscodeApi])

	// ========================================================================
	//  ④ 保存学生信息
	// ========================================================================

	const handleSaveStudentInfo = useCallback(() => {
		if (!studentId.trim() || !studentName.trim() || !classId.trim()) {
			setStatusMessage({
				type: "error",
				text: "⚠️ 请完整填写学号、姓名和班级",
			})
			return
		}
		if (!vscodeApi) return

		vscodeApi.postMessage({
			type: "assignment_command",
			command: "saveStudentInfo",
			payload: {
				studentId: studentId.trim(),
				studentName: studentName.trim(),
				classId: classId.trim(),
			},
		})
	}, [studentId, studentName, classId, vscodeApi])

	// ========================================================================
	//  渲染
	// ========================================================================

	// 如果不在 Webview 环境（standalone / 浏览器开发），显示提示并阻断 IPC 调用
	if (vscodeApi === null) {
		return (
			<div style={{ padding: "16px", color: "var(--vscode-errorForeground)" }}>
				<h3>⚠️ VS Code API 不可用</h3>
				<p>本组件必须在 VS Code Webview 中运行。</p>
			</div>
		)
	}

	return (
		<div style={styles.container}>
			{/* ----- 标题栏（含返回按钮） ----- */}
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					padding: "0 0 8px 0",
					borderBottom: "1px solid var(--vscode-panel-border)",
				}}>
				<h3 style={{ ...styles.header, borderBottom: "none", padding: 0 }}>📋 实验任务</h3>
				<button
					onClick={() => {
						// 发送 postMessage 到 Extension，调用 navigateToChat() 关闭本视图
						if (!vscodeApi) return
						vscodeApi.postMessage({
							type: "assignment_command",
							command: "exitToChat",
						})
					}}
					style={{
						background: "transparent",
						border: "1px solid var(--vscode-panel-border)",
						color: "var(--vscode-foreground)",
						padding: "4px 10px",
						borderRadius: "4px",
						cursor: "pointer",
						fontSize: "12px",
						display: "flex",
						alignItems: "center",
						gap: "4px",
					}}
					title="返回 Cline 主对话面板">
					← 返回对话
				</button>
			</div>

			{/* ----- 【v2.3 改造】删除 Wiki 进度感知 Header（与其他按钮功能重复） ----- */}
			{/* 原 <AssignmentHeader /> 已移除。周数 Select 移至底部紧凑控件。 */}

			{/* ----- 状态栏（加载中 / 成功 / 失败反馈）----- */}
			{statusMessage && (
				<div
					style={{
						...styles.statusBar,
						...(statusMessage.type === "success"
							? styles.statusSuccess
							: statusMessage.type === "error"
								? styles.statusError
								: styles.statusInfo),
					}}>
					{statusMessage.text}
				</div>
			)}

			{/* ================================================================ */}
			{/*  操作按钮区域                                                    */}
			{/* ================================================================ */}

			{/* ----- 获取任务按钮 ----- */}
			<button
				disabled={loading}
				onClick={handleFetchAssignments}
				style={{
					...styles.button,
					...styles.primaryButton,
					...(loading ? styles.primaryButtonDisabled : {}),
				}}>
				{loading ? (
					<>
						<span style={styles.spinner} />
						正在获取...
					</>
				) : (
					"📥 获取实验任务"
				)}
			</button>

			{/* ----- 【v2.3 增量】双击提示文本 ----- */}
			{assignments.length > 0 && (
				<div
					style={{
						fontSize: 11,
						color: "var(--vscode-descriptionForeground)",
						marginTop: -4,
						marginBottom: 4,
						padding: "0 4px",
					}}>
					💡 双击实验任务以创建源码文件
				</div>
			)}

			{/* ================================================================ */}
			{/*  任务列表（可折叠）                                              */}
			{/* ================================================================ */}

			{assignments.length === 0 && !loading && (
				<div style={styles.emptyState}>
					<p>暂无实验任务数据</p>
					<p>请点击上方"获取实验任务"按钮从云端拉取</p>
				</div>
			)}

			{assignments.length > 0 && (
				<>
					{/* 折叠/展开头部 */}
					<div
						onClick={() => setShowTaskList(!showTaskList)}
						style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							padding: "4px 8px",
							cursor: "pointer",
							borderRadius: "4px",
							background: "var(--vscode-list-hoverBackground)",
						}}>
						<span
							style={{
								fontSize: "11px",
								color: "var(--vscode-descriptionForeground)",
								fontWeight: 600,
							}}>
							{showTaskList ? "▾" : "▸"} 共 {assignments.length} 个实验任务
						</span>
						<span
							style={{
								fontSize: "10px",
								color: "var(--vscode-textLink-foreground)",
							}}>
							{showTaskList ? "收起" : "展开"}
						</span>
					</div>

					{/* 任务列表（仅在展开时渲染） */}
					{showTaskList &&
						assignments.map((task) => (
							<div
								key={task.id}
								onClick={() => handleSelectTask(task)}
								// 【v2.3 增量】双击任务项 → 在当前工作区创建对应的源码文件
								onDoubleClick={() => handleCreateOne(task)}
								style={{
									...styles.taskCard,
									...(selectedTask?.id === task.id ? styles.taskCardSelected : {}),
									userSelect: "none", // 避免双击时误选中文本
								}}
								title="单击查看任务详情，双击创建源码文件">
								<p style={styles.taskTitle}>{task.title}</p>
								<div style={styles.taskMeta}>
									<span style={styles.badge}>第 {task.week} 周</span>
									<span style={{ marginLeft: "8px" }}>{task.id}</span>
								</div>
							</div>
						))}
				</>
			)}

			{/* ================================================================ */}
			{/*  选中任务的详情区域                                              */}
			{/* ================================================================ */}

			{selectedTask && (
				<>
					<div style={styles.divider} />

					{/* 任务标题 */}
					<div style={{ fontSize: "13px", fontWeight: 600 }}>
						{selectedTask.title}
						<span style={{ ...styles.badge, marginLeft: "8px" }}>第 {selectedTask.week} 周</span>
					</div>

					{/* 实验指导书（Markdown 文本） */}
					{selectedTask.description && (
						<>
							<div style={{ fontSize: "11px", fontWeight: 600, color: "var(--vscode-descriptionForeground)" }}>
								📖 实验指导书
							</div>
							<div style={styles.descriptionBox}>{selectedTask.description}</div>
						</>
					)}

					{/* 附件列表 */}
					{selectedTask.attachments && selectedTask.attachments.length > 0 && (
						<>
							<div style={{ fontSize: "11px", fontWeight: 600, color: "var(--vscode-descriptionForeground)" }}>
								📎 附件材料
							</div>
							{selectedTask.attachments.map((file) => (
								<div
									key={file.id}
									onClick={() => {
										if (!vscodeApi) return
										vscodeApi.postMessage({
											type: "assignment_command",
											command: "openFile",
											payload: { filePath: file.original_name },
										})
									}}
									style={styles.attachmentItem}
									title="单击在编辑器中打开（开发阶段需配合完整路径）">
									📄 {file.original_name} ({formatFileSize(file.file_size)})
								</div>
							))}
						</>
					)}

					{/* ----- 一键提交按钮 ----- */}
					<button
						disabled={submitting}
						onClick={handleSubmitTask}
						style={{
							...styles.button,
							...styles.primaryButton,
							...(submitting ? styles.primaryButtonDisabled : {}),
							marginTop: "8px",
						}}>
						{submitting ? (
							<>
								<span style={styles.spinner} />
								正在提交...
							</>
						) : (
							"🚀 一键提交实验结果至云端"
						)}
					</button>
				</>
			)}

			{/* ================================================================ */}
			{/*  学生信息配置（折叠区域）                                        */}
			{/* ================================================================ */}

			<div style={styles.divider} />

			{/* ----- 【v2.3 增量】底部紧凑：学习进度（教学周数）----- */}
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					padding: "4px 0",
				}}>
				<label
					htmlFor="teaching-week-select"
					style={{
						fontSize: 11,
						color: "var(--vscode-descriptionForeground)",
						fontWeight: 600,
					}}>
					📅 学习进度
				</label>
				<select
					id="teaching-week-select"
					onChange={(e) => onWeekChange(Number(e.target.value))}
					style={{
						flex: 1,
						padding: "3px 6px",
						background: "var(--vscode-input-background)",
						color: "var(--vscode-input-foreground)",
						border: "1px solid var(--vscode-input-border)",
						borderRadius: 3,
						fontSize: 11,
					}}
					value={currentWeek}>
					{Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
						<option key={w} value={w}>
							第 {w} 周
						</option>
					))}
				</select>
			</div>

			<div style={styles.divider} />

			<div
				onClick={() => setShowStudentForm(!showStudentForm)}
				style={{
					...styles.link,
					fontSize: "12px",
					fontWeight: 600,
					textDecoration: "none",
				}}>
				{showStudentForm ? "▾ 收起学生信息设置" : "▸ 学生信息设置"}
			</div>

			{showStudentForm && (
				<div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
					<div style={styles.inputGroup}>
						<label style={styles.label}>学号</label>
						<input
							onChange={(e) => setStudentId(e.target.value)}
							placeholder="2024001"
							style={styles.input}
							value={studentId}
						/>
					</div>
					<div style={styles.inputGroup}>
						<label style={styles.label}>姓名</label>
						<input
							onChange={(e) => setStudentName(e.target.value)}
							placeholder="张三"
							style={styles.input}
							value={studentName}
						/>
					</div>
					<div style={styles.inputGroup}>
						<label style={styles.label}>班级</label>
						<input
							onChange={(e) => setClassId(e.target.value)}
							placeholder="计科2101"
							style={styles.input}
							value={classId}
						/>
					</div>
					{/* 【v2.3 阶段4】日志路径输入：留空则走系统默认 */}
					<div style={styles.inputGroup}>
						<label style={styles.label}>
							📄 行为日志路径（可选）
						</label>
						<input
							onChange={(e) => setLogFilePath(e.target.value)}
							placeholder="D:/your-workspace/.cline-logs/student_interactions.log"
							style={{ ...styles.input, fontFamily: "var(--vscode-editor-font-family)" }}
							value={logFilePath}
						/>
						<div style={{ fontSize: 10, color: "var(--vscode-descriptionForeground)", marginTop: 2 }}>
							提交实验时附带此 JSONL 日志文件，看板可按学号/姓名/班级筛选。
							留空则不附带，由后端仅使用 raw_behavior_logs。
						</div>
					</div>
					<button onClick={handleSaveStudentInfo} style={{ ...styles.button, ...styles.primaryButton }}>
						💾 保存学生信息
					</button>
				</div>
			)}
		</div>
	)
}

export default AssignmentTab
