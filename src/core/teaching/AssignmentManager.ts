/**
 * =============================================================================
 *  AssignmentManager — 实验任务拉取与一键提交模块（插件后台核心类）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 1. 从后端 API 获取实验任务列表，创建本地实验文件
 * 2. 读取 Cline 本地行为日志（.cline-logs），计算学情指标
 * 3. 通过 HTTP POST 将学生代码 + 行为日志提交至云端后端
 * 4. 与 Webview 前端通过 postMessage 进行 IPC 双向通信
 *
 * 【IPC 消息协议】
 * ┌─────────────────────────┐          ┌─────────────────────────┐
 * │   Webview (AssignmentTab)│          │  Extension (AssignmentManager) │
 * │                         │ postMessage│                         │
 * │  command: 'fetchAssignments' │──────▶│  GET /api/assignments   │
 * │                         │          │  创建本地实验文件        │
 * │  command: 'submitTask'  │──────▶│  读取 .cline-logs         │
 * │                         │          │  POST /api/submissions   │
 * │  command: 'openFile'    │──────▶│  vscode.window.showTextDocument│
 * └─────────────────────────┘          └─────────────────────────┘
 *
 * 【与 Web 端的数据串联】
 *   AssignmentManager 调用的 API 路径与 Web 教师端 (AssignmentPublish.tsx)
 *   共享同一个后端 teaching-server，数据库 assignments / submissions 表
 *   通过 assignment_id 字段关联，最终在学情画像看板中聚合展示。
 *
 * =============================================================================
 */

import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { ensureStudentLogFile } from "./workspaceLogPath"

// ============================================================================
//  类型定义
// ============================================================================

/** 实验任务 —— 与后端 Assignment 接口对齐 */
export interface Assignment {
	id: string // 任务唯一标识，如 "task_week5_oop"
	title: string // 实验任务名称
	week: number // 教学周数
	description?: string // Markdown 格式实验指导书
	template_code?: string // 初始模板代码
	attachments?: Attachment[]
}

/** 附件信息 */
export interface Attachment {
	id: number
	assignment_id: string
	original_name: string
	file_size: number
	mime_type: string
}

/** 学生信息 — 可持久化到 VS Code 全局状态中 */
export interface StudentInfo {
	studentId: string
	studentName: string
	classId: string
	/** 【v2.3 阶段4】学生工作区日志文件路径（JSONL），可空 */
	logFilePath?: string
}

/** 提交请求体 —— POST /api/v1/submissions */
export interface SubmissionPayload {
	assignment_id: string
	student_id: string
	student_name: string
	class_id: string
	code_snapshot: string
	raw_behavior_logs: unknown
	/** 【v2.3 阶段4】学生工作区日志文件路径（绝对路径，后端按 JSONL 读取） */
	log_file_path?: string
	/** 【v2.3 阶段4】提交时间戳 ISO 8601 */
	submitted_at?: string
}

/** Webview → Extension 的 IPC 消息协议 */
export interface AssignmentMessage {
	command: "fetchAssignments" | "createOneFile" | "submitTask" | "openFile" | "saveStudentInfo" | "exitToChat" | "queryAutoLogPath"
	payload?: Record<string, unknown>
}

/** Extension → Webview 的响应消息协议 */
export interface AssignmentResponse {
	command: string
	success: boolean
	data?: unknown
	error?: string
	/** 【v2.3 增量】createOneFile 等需要回传任务标识时附带 */
	assignmentId?: string
}

// ============================================================================
//  AssignmentManager 类
// ============================================================================

/**
 * 【方案 B — 通过 setApiBase 注入 API 地址】
 *
 * 配置优先级（从高到低）：
 * 1. 通过 setApiBase() 显式注入（优先级最高）
 * 2. VS Code 用户/工作区配置 `teaching.apiBase`（用户在 Settings UI 中设置）
 * 3. 构造函数参数 apiBase 默认值（兜底）
 *
 * 推荐的调用方式：
 *   在插件 activate() 中创建 AssignmentManager 时，从 VS Code 配置加载：
 *     const manager = new AssignmentManager();
 *     manager.refreshApiBaseFromConfig();
 *   这样用户在 Settings 中改 teaching.apiBase 后，下次拉取/提交即生效。
 *
 * 同时支持监听配置变更：
 *   manager.dispose() 会取消监听。
 */
export class AssignmentManager {
	/** 后端 API 基础地址（运行时可被 setApiBase 覆盖） */
	private apiBase: string

	/** 默认 API 地址兜底值 —— 修改 teaching.apiBase 配置即可生效 */
	private static readonly DEFAULT_API_BASE = "http://localhost:4001"

	/** VS Code 配置节 section */
	public static readonly CONFIG_SECTION = "teaching"
	public static readonly CONFIG_API_BASE = "apiBase"

	/** 配置变更订阅 disposable，用于 dispose() 解绑 */
	private configWatcherDisposable: vscode.Disposable | null = null

	/**
	 * 【v2.3 增量】已拉取的实验任务缓存（id → Assignment）。
	 * 双击任务项触发 `createOneFile` 时优先查找本缓存，避免每次双击都重新请求后端。
	 */
	private cachedAssignmentsById: Map<string, Assignment> = new Map()

	constructor(apiBase?: string) {
		// 若调用方未传值，使用默认兜底；后续可通过 refreshApiBaseFromConfig 或 setApiBase 覆盖
		this.apiBase = apiBase ?? AssignmentManager.DEFAULT_API_BASE
	}

	/**
	 * 从 VS Code 配置中读取 teaching.apiBase 并应用。
	 * 应在插件 activation 时调用一次，之后可用 listenConfigChanges() 监听后续变更。
	 */
	public refreshApiBaseFromConfig(): void {
		const config = vscode.workspace.getConfiguration(AssignmentManager.CONFIG_SECTION)
		const fromConfig = config.get<string>(AssignmentManager.CONFIG_API_BASE)
		if (typeof fromConfig === "string" && fromConfig.trim()) {
			this.apiBase = fromConfig.trim()
		}
	}

	/**
	 * 启动对 teaching.apiBase 配置变更的监听，变更时自动同步。
	 * 必须在插件 activation 阶段调用。
	 */
	public listenConfigChanges(): void {
		if (this.configWatcherDisposable) {
			return // 已订阅，幂等保护
		}
		this.configWatcherDisposable = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration(`${AssignmentManager.CONFIG_SECTION}.${AssignmentManager.CONFIG_API_BASE}`)) {
				const oldUrl = this.apiBase
				this.refreshApiBaseFromConfig()
				console.log(`[AssignmentManager] API base 由 ${oldUrl} 更新为 ${this.apiBase}`)
			}
		})
	}

	/**
	 * 更新 API 地址（优先级最高，覆盖 setApiBaseFromConfig 的结果）。
	 * @returns void
	 */
	public setApiBase(url: string): void {
		if (!url || typeof url !== "string") {
			throw new Error("setApiBase: URL 必须是非空字符串")
		}
		this.apiBase = url.trim()
	}

	/**
	 * 读取当前生效的 API 地址（用于诊断 / Webview 展示）。
	 */
	public getApiBase(): string {
		return this.apiBase
	}

	/**
	 * 释放资源。卸载插件时调用。
	 */
	public dispose(): void {
		this.configWatcherDisposable?.dispose()
		this.configWatcherDisposable = null
		this.workspaceOpenWatcherDisposable?.dispose()
		this.workspaceOpenWatcherDisposable = null
	}

	// ========================================================================
	//  【v2.5】自动日志路径 —— 监听工作区打开
	// ========================================================================

	/** workspace 打开事件订阅 disposable */
	private workspaceOpenWatcherDisposable: vscode.Disposable | null = null

	/**
	 * 启动对 vscode.workspace.onDidChangeWorkspaceFolders 的监听。
	 * 每次工作区集合变化时（即用户打开/关闭文件夹），
	 * 在第一个工作区根目录下自动创建 student_interactions.log（不存在时），
	 * 并通过 postMessage 通知 Webview 端自动填入 logFilePath。
	 *
	 * 必须由插件主进程在 activate() 阶段调用。
	 */
	public startWatchingWorkspaceOpen(): void {
		if (this.workspaceOpenWatcherDisposable) {
			return // 已订阅，幂等保护
		}
		// 启动时立即检测当前工作区
		this.handleWorkspaceChange()
		// 监听后续变化
		this.workspaceOpenWatcherDisposable = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			this.handleWorkspaceChange()
		})
	}

	/**
	 * 自动处理工作区变化：
	 *   1. 取第一个工作区根目录
	 *   2. 在该目录下创建 .cline-logs/student_interactions.log（不存在时）
	 *   3. 通过 cacheLastAutoLogPath 记忆 + 通知 Webview
	 */
	private handleWorkspaceChange(): void {
		const result = ensureStudentLogFile()
		if (result) {
			this.cachedAutoLogPath = result.path
			this.cachedAutoLogPathCreated = result.created
			// 通知 Webview 端（如果有的话）
			this.notifyWebviewOfAutoLogPath(result.path, result.created)
		} else {
			this.cachedAutoLogPath = null
			this.cachedAutoLogPathCreated = false
		}
	}

	/** 最近一次自动检测到的工作区日志路径 */
	private cachedAutoLogPath: string | null = null
	private cachedAutoLogPathCreated: boolean = false

	/**
	 * 通知 Webview 端自动日志路径已就绪（仅在有 listeners 时）。
	 */
	private notifyWebviewOfAutoLogPath(path: string, created: boolean): void {
		// 通过自定义消息广播给所有 webview
		// webview 端通过 window.addEventListener('message') 接收
		try {
			// 不直接调用 webview.postMessage（没有 webview 引用）
			// 我们让 Webview 主动来请求最新路径（queryAutoLogPath）
		} catch {
			// 忽略
		}
		Logger.log(
			`[AssignmentManager] 工作区日志路径: ${path}（${created ? "新建" : "已存在"}）`,
		)
	}

	/**
	 * 返回最近一次自动检测到的日志路径。
	 * 给 Webview 端通过 IPC 调用。
	 */
	public queryAutoLogPath(): { path: string | null; created: boolean } {
		return {
			path: this.cachedAutoLogPath,
			created: this.cachedAutoLogPathCreated,
		}
	}

	// ========================================================================
	//  ① IPC 消息分发入口
	// ========================================================================

	/**
	 * Webview 前端发送的消息统一由此方法分发处理。
	 * 在 VscodeWebviewProvider.handleWebviewMessage 的 switch 分支中调用。
	 *
	 * 调用示例（在 VscodeWebviewProvider 中）：
	 * ```ts
	 * case "assignment_command": {
	 *   await this.assignmentManager.handleMessage(message, postMessageToWebview);
	 *   break;
	 * }
	 * ```
	 */
	public async handleMessage(message: AssignmentMessage, postMessage: (response: AssignmentResponse) => void): Promise<void> {
		const payload = (message.payload ?? {}) as Record<string, unknown>
		try {
			switch (message.command) {
				case "fetchAssignments":
					await this.handleFetchAssignments(postMessage)
					break

				case "createOneFile": {
					const assignmentId = typeof payload["assignmentId"] === "string" ? (payload["assignmentId"] as string) : ""
					await this.handleCreateOneFile({ assignmentId }, postMessage)
					break
				}

				case "submitTask": {
					const assignmentId = typeof payload["assignmentId"] === "string" ? (payload["assignmentId"] as string) : ""
					await this.handleSubmitTask({ assignmentId }, postMessage)
					break
				}

				case "openFile": {
					const filePath = typeof payload["filePath"] === "string" ? (payload["filePath"] as string) : ""
					await this.handleOpenFile({ filePath }, postMessage)
					break
				}

				case "saveStudentInfo": {
					const studentInfo = this.parseStudentInfo(payload)
					if (!studentInfo) {
						postMessage({
							command: message.command,
							success: false,
							error: "学生信息字段不完整或类型错误",
						})
						return
					}
					await this.handleSaveStudentInfo(studentInfo, postMessage)
					break
				}

				case "exitToChat":
					await this.handleExitToChat(postMessage)
					break

				case "queryAutoLogPath":
					postMessage({
						command: "queryAutoLogPath",
						success: true,
						data: this.queryAutoLogPath(),
					})
					break

				default:
					postMessage({
						command: String(message.command ?? "unknown"),
						success: false,
						error: `未知命令: ${String(message.command ?? "")}`,
					})
			}
		} catch (error) {
			postMessage({
				command: String(message.command ?? "unknown"),
				success: false,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	/**
	 * 安全解析学生信息字段，避免对未知字段使用 double-cast 强转。
	 * 返回 null 表示字段缺失或类型不匹配。
	 */
	private parseStudentInfo(payload: Record<string, unknown>): StudentInfo | null {
		const studentId = payload["studentId"]
		const studentName = payload["studentName"]
		const classId = payload["classId"]
		if (typeof studentId !== "string" || typeof studentName !== "string" || typeof classId !== "string") {
			return null
		}
		const trimmed: StudentInfo = {
			studentId: studentId.trim(),
			studentName: studentName.trim(),
			classId: classId.trim(),
		}
		if (!trimmed.studentId || !trimmed.studentName || !trimmed.classId) {
			return null
		}
		// 【v2.3 阶段4】可选：学生工作区日志文件路径
		const logFilePath = payload["logFilePath"]
		if (typeof logFilePath === "string" && logFilePath.trim()) {
			trimmed.logFilePath = logFilePath.trim()
		}
		return trimmed
	}

	// ========================================================================
	//  ② fetchAssignments — 获取任务列表 & 创建本地实验文件
	// ========================================================================

	/**
	 * 【IPC 消息流转】
	 * Webview 侧边栏 → postMessage({ command: 'fetchAssignments' })
	 *                 → AssignmentManager.handleFetchAssignments()
	 *                 → GET http://localhost:3000/api/v1/assignments
	 *                 → 创建 ${assignment.id}_experiment.py 并写入 template_code
	 *                 → 返回任务列表到 Webview（不自动创建文件，由学生双击触发）
	 */
	private async handleFetchAssignments(postMessage: (response: AssignmentResponse) => void): Promise<void> {
		try {
			// ----- 调用后端 API 获取任务列表 -----
			const response = await fetch(`${this.apiBase}/api/v1/assignments`, {
				method: "GET",
				headers: { "Content-Type": "application/json" },
			})

			if (!response.ok) {
				throw new Error(`后端 API 返回错误: HTTP ${response.status}`)
			}

			const result = (await response.json()) as {
				ok: boolean
				data: Assignment[]
			}

			if (!result.ok || !Array.isArray(result.data)) {
				throw new Error("后端返回数据格式异常")
			}

			const assignments: Assignment[] = result.data

			// 【v2.3 改造】不再自动创建实验文件 —— 改为由学生在列表中双击任务项触发
			// 避免"一个任务一个独立工作区"的学生打开多个工作区时文件散落各处

			// 填充缓存，供双击 createOneFile 时快速查找
			this.cachedAssignmentsById.clear()
			for (const a of assignments) {
				this.cachedAssignmentsById.set(a.id, a)
			}

			// ----- 通知 Webview 更新任务列表 -----
			postMessage({
				command: "fetchAssignments",
				success: true,
				data: assignments,
			})

			vscode.window.showInformationMessage(
				`📋 成功获取 ${assignments.length} 个实验任务。\n💡 双击某个任务项可创建对应的源码文件到当前工作区。`,
			)
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(`❌ 获取实验任务失败: ${msg}`)
			postMessage({
				command: "fetchAssignments",
				success: false,
				error: msg,
			})
		}
	}

	/**
	 * 【v2.3 增量】双击实验任务项时触发 —— 在当前工作区创建单个任务的源码文件。
	 * 由 Webview 通过 `createOneFile` 命令调用。失败仅弹 warning，不抛出。
	 */
	private async handleCreateOneFile(
		payload: { assignmentId: string },
		postMessage: (response: AssignmentResponse) => void = () => {},
	): Promise<void> {
		try {
			const { assignmentId } = payload
			if (!assignmentId) {
				throw new Error("缺少 assignmentId 参数")
			}

			// ----- 校验工作区是否打开 -----
			const workspaceFolders = vscode.workspace.workspaceFolders
			if (!workspaceFolders || workspaceFolders.length === 0) {
				const errMsg = "未检测到打开的工作区"
				vscode.window.showErrorMessage("❌ 请先打开一个工作区（文件夹），才能创建实验文件。")
				postMessage({
					command: "createOneFile",
					success: false,
					assignmentId,
					error: errMsg,
				})
				return
			}

			const workspaceRoot = workspaceFolders[0].uri.fsPath

			// 优先用本地缓存列表查找；缓存为空时再拉一次后端
			let assignment = this.cachedAssignmentsById.get(assignmentId)
			if (!assignment) {
				assignment = await this.fetchAssignmentById(assignmentId)
				if (assignment) {
					this.cachedAssignmentsById.set(assignmentId, assignment)
				}
			}
			if (!assignment) {
				throw new Error(`未找到任务 ${assignmentId}，请先点击「获取实验任务」拉取列表`)
			}

			// 调用底层方法（沿用 fs.existsSync 跳过 + writeFileSync + 打开编辑器逻辑）
			await this.createExperimentFile(workspaceRoot, assignment)

			// 成功反馈（不打扰型，提示已由 createExperimentFile 内部的 showTextDocument 提供）
			postMessage({
				command: "createOneFile",
				success: true,
				assignmentId,
				data: { fileName: `${assignment.id.replace(/[^a-zA-Z0-9_-]/g, "_")}_experiment.py` },
			})
		} catch (error) {
			// 单文件创建失败：按决策 4.A 弹 warning 而非抛错，不打断列表
			const msg = error instanceof Error ? error.message : String(error)
			vscode.window.showWarningMessage(`⚠️ 创建实验文件失败: ${msg}`)
			postMessage({
				command: "createOneFile",
				success: false,
				assignmentId: payload.assignmentId,
				error: msg,
			})
		}
	}

	/**
	 * 从后端 API 拉取单个任务详情。失败时返回 undefined（不抛错）。
	 */
	private async fetchAssignmentById(assignmentId: string): Promise<Assignment | undefined> {
		try {
			const response = await fetch(`${this.apiBase}/api/v1/assignments`, {
				method: "GET",
				headers: { "Content-Type": "application/json" },
			})
			if (!response.ok) return undefined
			const result = (await response.json()) as { ok: boolean; data: Assignment[] }
			if (!result.ok || !Array.isArray(result.data)) return undefined
			return result.data.find((a) => a.id === assignmentId) ?? undefined
		} catch {
			return undefined
		}
	}

	/**
	 * 在工作区根目录创建单个实验文件。
	 * 文件名规则：${assignment.id}_experiment.py
	 * 如果文件已存在则跳过（不覆盖学生已有代码）。
	 *
	 * 如果文件写入或打开失败，会抛出 Error，由调用方统一处理。
	 */
	private async createExperimentFile(workspaceRoot: string, assignment: Assignment): Promise<void> {
		// ----- 文件名安全校验：过滤非法字符 -----
		const safeId = assignment.id.replace(/[^a-zA-Z0-9_-]/g, "_")
		if (!safeId) {
			throw new Error(`非法任务ID: ${assignment.id}`)
		}
		const fileName = `${safeId}_experiment.py`
		const filePath = path.join(workspaceRoot, fileName)

		// ----- 安全校验：文件已存在则跳过，避免覆盖学生代码 -----
		if (fs.existsSync(filePath)) {
			return
		}

		// ----- 写入 template_code，无 template_code 时写入注释占位 -----
		const content =
			assignment.template_code || `# ${assignment.title}\n# 任务ID: ${assignment.id}\n# 请在此处编写你的实验代码\n`

		try {
			fs.writeFileSync(filePath, content, "utf-8")
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			throw new Error(`写入文件失败: ${msg}`)
		}

		// ----- 在 VS Code 编辑器中打开该文件 -----
		try {
			const document = await vscode.workspace.openTextDocument(filePath)
			await vscode.window.showTextDocument(document, { preview: false })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			throw new Error(`打开文件失败: ${msg}`)
		}
	}

	// ========================================================================
	//  ③ openFile — 在编辑器中打开指定文件
	// ========================================================================

	/**
	 * Webview 中的"打开文件"操作。
	 * 接收文件路径，在 VS Code 编辑器中聚焦打开。
	 */
	private async handleOpenFile(
		payload: { filePath: string },
		postMessage: (response: AssignmentResponse) => void,
	): Promise<void> {
		try {
			const { filePath } = payload
			if (!filePath) {
				throw new Error("未提供文件路径")
			}
			if (!fs.existsSync(filePath)) {
				throw new Error(`文件不存在: ${filePath}`)
			}

			const document = await vscode.workspace.openTextDocument(filePath)
			await vscode.window.showTextDocument(document, { preview: false })

			postMessage({ command: "openFile", success: true })
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(`❌ 无法打开文件: ${msg}`)
			postMessage({ command: "openFile", success: false, error: msg })
		}
	}

	// ========================================================================
	//  ④ submitTask — 一键提交实验结果至云端
	// ========================================================================

	/**
	 * 【IPC 消息流转】
	 * Webview 侧边栏 → postMessage({ command: 'submitTask', payload: { assignmentId } })
	 *                 → AssignmentManager.handleSubmitTask()
	 *                 → ① 读取当前实验文件最新代码 => code_snapshot
	 *                 → ② 读取 .cline-logs/tasks/{taskId}/task_metadata.json => raw_behavior_logs
	 *                 → ③ 读取已保存的学生信息
	 *                 → ④ POST /api/v1/submissions 发送至云端
	 *                 → ⑤ 弹出成功提示
	 */
	private async handleSubmitTask(
		payload: { assignmentId: string },
		postMessage: (response: AssignmentResponse) => void,
	): Promise<void> {
		try {
			const { assignmentId } = payload

			if (!assignmentId) {
				throw new Error("缺少 assignmentId 参数")
			}

			// ----- ① 获取当前实验文件的代码快照 -----
			const codeSnapshot = await this.getCurrentEditorCode()
			if (codeSnapshot === null) {
				// getCurrentEditorCode 已在内部弹出错误提示
				postMessage({
					command: "submitTask",
					success: false,
					error: "无法获取编辑器中的代码，请确保已打开实验文件",
				})
				return
			}

			// ----- ② 读取 Cline 本地行为日志 -----
			const rawBehaviorLogs = this.readClineLogs(assignmentId)

			// ----- ③ 获取已保存的学生信息 -----
			const studentInfo = await this.loadStudentInfo()
			if (!studentInfo) {
				vscode.window.showErrorMessage('❌ 请先在设置中填写学生信息（学号、姓名、班级）。\n点击左侧"设置"按钮进行配置。')
				postMessage({
					command: "submitTask",
					success: false,
					error: "学生信息未配置",
				})
				return
			}

			// ----- ④ 构造提交 Payload -----
			const submissionPayload: SubmissionPayload = {
				assignment_id: assignmentId,
				student_id: studentInfo.studentId,
				student_name: studentInfo.studentName,
				class_id: studentInfo.classId,
				code_snapshot: codeSnapshot,
				raw_behavior_logs: rawBehaviorLogs,
				// 【v2.3 阶段4】学生工作区日志路径（可空）
				log_file_path: studentInfo.logFilePath ?? undefined,
				submitted_at: new Date().toISOString(),
			}

			// ----- ⑤ POST 提交至云端后端 -----
			const response = await fetch(`${this.apiBase}/api/v1/submissions`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(submissionPayload),
			})

			if (!response.ok) {
				const errorBody = await response.text()
				throw new Error(`服务器返回错误 (HTTP ${response.status}): ${errorBody}`)
			}

			const result = (await response.json()) as {
				ok: boolean
				message?: string
				data?: { ai_dependency?: number; metric_gaming_score?: number; user_edit_count?: number }
			}

			if (result.ok) {
				// ----- ⑥ 提交成功，弹出提示（安全格式化 ai_dependency）-----
				const aiDep = typeof result.data?.ai_dependency === "number" ? result.data.ai_dependency : null
				const aiDepText = aiDep !== null ? `${(aiDep * 100).toFixed(1)}%` : "未知"

				vscode.window.showInformationMessage(`✅ 实验「${assignmentId}」提交成功！AI依赖度: ${aiDepText}`)

				postMessage({
					command: "submitTask",
					success: true,
					data: result.data,
				})
			} else {
				throw new Error(result.message || "提交失败")
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(`❌ 提交实验失败: ${msg}`)
			postMessage({
				command: "submitTask",
				success: false,
				error: msg,
			})
		}
	}

	// ========================================================================
	//  ⑤ 辅助方法
	// ========================================================================

	/**
	 * 获取当前 VS Code 活动编辑器中可见的代码内容。
	 * 优先获取当前激活的文件内容，若无活动编辑器则返回 null。
	 */
	private async getCurrentEditorCode(): Promise<string | null> {
		const editor = vscode.window.activeTextEditor
		if (!editor) {
			vscode.window.showWarningMessage("⚠️ 未检测到打开的编辑器，请先打开实验文件。")
			return null
		}

		// 获取当前文档完整文本内容
		const document = editor.document
		try {
			return document.getText()
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			vscode.window.showErrorMessage(`❌ 读取编辑器内容失败: ${msg}`)
			return null
		}
	}

	/**
	 * 读取 Cline 本地行为日志文件。
	 *
	 * 【日志路径规则】
	 * 跨平台兼容路径：${clineLogsDir}/tasks/${taskId}/task_metadata.json
	 * 其中 clineLogsDir 默认在 ~/.cline-logs 或指定环境变量 CLINE_LOG_DIR。
	 *
	 * 【兜底逻辑】
	 * ① 优先读取 taskId 对应的日志
	 * ② 若文件不存在，读取按 mtime 排序的最新任务日志
	 * ③ 若均不存在，返回空对象并弹出警告
	 */
	private readClineLogs(taskId: string): unknown {
		// 尝试多个可能的 Cline 日志根目录
		const possibleRoots = this.getPossibleClineLogRoots()

		for (const rootDir of possibleRoots) {
			// 尝试读取指定 taskId 的日志
			const taskLogPath = path.join(rootDir, "tasks", taskId, "task_metadata.json")
			const parsedTaskLog = this.tryReadJson(taskLogPath)
			if (parsedTaskLog !== undefined) {
				return parsedTaskLog
			}

			// 兜底：读取 tasks 目录下按 mtime 排序的最新日志
			const tasksDir = path.join(rootDir, "tasks")
			if (fs.existsSync(tasksDir)) {
				const latestLog = this.readLatestTaskLog(tasksDir)
				if (latestLog !== undefined) {
					return latestLog
				}
			}
		}

		// 所有路径均未找到日志文件
		// 【端到端开发模式】返回保底 demo 数据，避免后端收到空 logs 导致指标全为 0。
		// 待 D:\cline\.cline-logs\ 真实采集链路实现后，可移除此分支。
		vscode.window.showWarningMessage(
			`⚠️ 未找到 Cline 行为日志（已尝试 ${possibleRoots.length} 个日志目录）。\n` +
				`已自动填入 demo 行为日志用于演示。请实现 student-analytics 模块后即可自动接入真实数据。`,
		)

		return {
			source: "fallback",
			taskId,
			generatedAt: new Date().toISOString(),
			events: [
				{ ts: new Date().toISOString(), eventType: "task_start", role: "user", category: "other" },
				{ ts: new Date().toISOString(), eventType: "turn_message", role: "user", category: "code_generation" },
				{ ts: new Date().toISOString(), eventType: "turn_message", role: "assistant", category: "code_generation" },
				{ ts: new Date().toISOString(), eventType: "code_edit", role: "user", category: "refactoring" },
				{ ts: new Date().toISOString(), eventType: "adoption_infer", role: "user", category: "other", adoptionStatus: "adopted" },
				{ ts: new Date().toISOString(), eventType: "adoption_infer", role: "user", category: "other", adoptionStatus: "adopted" },
			],
		}
	}

	/**
	 * 尝试读取并解析 JSON 文件。失败返回 undefined（不抛错）。
	 */
	private tryReadJson(filePath: string): unknown | undefined {
		if (!fs.existsSync(filePath)) {
			return undefined
		}
		try {
			return JSON.parse(fs.readFileSync(filePath, "utf-8"))
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			console.warn(`[AssignmentManager] 日志文件解析失败 (${filePath}): ${msg}`)
			return undefined
		}
	}

	/**
	 * 在 tasks 目录下读取 mtime 最新的 task_metadata.json。
	 * 返回 undefined 表示未找到。
	 */
	private readLatestTaskLog(tasksDir: string): unknown | undefined {
		type FolderInfo = { name: string; mtimeMs: number }
		let folders: FolderInfo[] = []
		try {
			folders = fs
				.readdirSync(tasksDir, { withFileTypes: true })
				.filter((d) => d.isDirectory())
				.map((d) => {
					const fullPath = path.join(tasksDir, d.name)
					let mtimeMs = 0
					try {
						mtimeMs = fs.statSync(fullPath).mtimeMs
					} catch {
						// 无法读取时使用 0 兜底
						mtimeMs = 0
					}
					return { name: d.name, mtimeMs }
				})
		} catch {
			return undefined
		}

		// 按 mtime 降序排序，最新修改的排最前
		folders.sort((a, b) => b.mtimeMs - a.mtimeMs)

		for (const folder of folders) {
			const metaPath = path.join(tasksDir, folder.name, "task_metadata.json")
			const parsed = this.tryReadJson(metaPath)
			if (parsed !== undefined) {
				return parsed
			}
		}
		return undefined
	}

	/**
	 * 获取所有可能存放 Cline 日志的根目录路径。
	 * 跨平台兼容：Windows / macOS / Linux。
	 */
	private getPossibleClineLogRoots(): string[] {
		const roots: string[] = []

		// ① 环境变量 CLIne_LOG_DIR
		const envLogDir = process.env["CLINE_LOG_DIR"]
		if (envLogDir) {
			roots.push(envLogDir)
		}

		// ② Windows: D:\.cline-logs（用户指定的物理路径）
		if (process.platform === "win32") {
			roots.push("D:\\.cline-logs")
		}

		// ③ 用户家目录 ~/.cline-logs（跨平台通用）
		const homeDir = process.env["HOME"] || process.env["USERPROFILE"] || ""
		if (homeDir) {
			roots.push(path.join(homeDir, ".cline-logs"))
		}

		// ④ 常见 Cline 配置路径
		if (process.platform === "win32") {
			const appData = process.env["APPDATA"] || ""
			if (appData) {
				roots.push(path.join(appData, "Cline", ".cline-logs"))
				roots.push(path.join(appData, "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "logs"))
			}
		}

		return roots
	}

	// ========================================================================
	//  ⑥ 学生信息持久化
	// ========================================================================

	/**
	 * 保存学生信息到 VS Code 全局配置中。
	 * 信息包括：学号、姓名、班级。
	 * Webview 中的"设置"页面调用此方法进行持久化。
	 *
	 * 【注意】
	 * 原代码错误地将 `vscode.commands.executeCommand('setContext', ...)` 用于保存对象，
	 * 这与 API 设计不一致（setContext 用于 UI 上下文标志）。现改为仅写入配置。
	 */
	public async saveStudentInfo(info: StudentInfo): Promise<void> {
		await vscode.workspace.getConfiguration("teaching").update("studentInfo", info, vscode.ConfigurationTarget.Global)
	}

	/**
	 * 加载已持久化的学生信息。
	 * 优先从 VS Code 配置中读取，若未配置则返回 null。
	 *
	 * 严格校验字段存在且为非空字符串，防止配置文件被手动篡改导致异常。
	 */
	private async loadStudentInfo(): Promise<StudentInfo | null> {
		const config = vscode.workspace.getConfiguration("teaching")
		const raw = config.get<Partial<StudentInfo>>("studentInfo")
		if (!raw) {
			return null
		}
		const studentId = typeof raw.studentId === "string" ? raw.studentId.trim() : ""
		const studentName = typeof raw.studentName === "string" ? raw.studentName.trim() : ""
		const classId = typeof raw.classId === "string" ? raw.classId.trim() : ""
		if (!studentId || !studentName || !classId) {
			return null
		}
		const info: StudentInfo = { studentId, studentName, classId }
		// 【v2.3 阶段4】同时加载日志文件路径
		const logFilePath = typeof raw.logFilePath === "string" ? raw.logFilePath.trim() : ""
		if (logFilePath) {
			info.logFilePath = logFilePath
		}
		return info
	}

	/**
	 * 处理 Webview 传来的保存学生信息请求。
	 */
	private async handleSaveStudentInfo(
		payload: StudentInfo,
		postMessage: (response: AssignmentResponse) => void,
	): Promise<void> {
		try {
			await this.saveStudentInfo(payload)
			vscode.window.showInformationMessage(`✅ 学生信息已保存: ${payload.studentName} (${payload.studentId})`)
			postMessage({ command: "saveStudentInfo", success: true })
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			postMessage({ command: "saveStudentInfo", success: false, error: msg })
		}
	}

	/**
	 * 处理 Webview 传来的"返回对话"请求。
	 *
	 * 通过执行 cline.plusButtonClicked 命令触发 + 新建任务逻辑，
	 * 间接让 WebviewStateContext 的 navigateToChat() 被调用，
	 * 从而关闭实验任务视图。
	 */
	private async handleExitToChat(
		postMessage: (response: AssignmentResponse) => void,
	): Promise<void> {
		try {
			// 通过命令面板触发 + 新建任务按钮的相同逻辑
			await vscode.commands.executeCommand("cline.plusButtonClicked")
			postMessage({ command: "exitToChat", success: true })
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(`❌ 退出实验任务视图失败: ${msg}`)
			postMessage({ command: "exitToChat", success: false, error: msg })
		}
	}
}
