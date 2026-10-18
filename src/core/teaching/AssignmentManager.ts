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

import { buildApiHandler } from "@core/api"
import { randomUUID } from "crypto"
import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import type {
	BundleAnswer,
	BundleIngestResult,
	BundleQuestion,
	BundleRunTrace,
	ThinkingConfirmResult,
	ThinkingQuestionsPayload,
} from "./submission/bundleTypes"
import { sliceLogForUpload } from "./submission/logSlicer"
import type { QuestionCountPolicy } from "./submission/QuestionCountPolicy"
import { generateThinkingQuestions } from "./submission/QuestionGenerator"
import {
	buildBundleMeta,
	type CollectedCodeFile,
	type CollectedLog,
	collectCodeFiles,
	collectLog,
	postBundle,
	readRunTraces,
	summarizeLogEvents,
} from "./submission/SubmissionPackager"
import { redactForFile } from "./submission/secrets"
import type { QuestionSignals } from "./submission/thinkingQuestions"
import { ensureStudentLogFile, resolveStudentLogFile } from "./workspaceLogPath"

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
	command:
		| "fetchAssignments"
		| "createOneFile"
		| "submitTask"
		| "openFile"
		| "downloadAttachment"
		| "saveStudentInfo"
		| "loadStudentInfo"
		| "exitToChat"
		| "queryAutoLogPath"
		// 【v2.13 两段式提交】点击上传 → 本地收集 + 出题（不上传）→ 答题面板确认后才真正上传
		| "prepareSubmission"
		| "confirmSubmission"
		| "cancelSubmission"
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

/**
 * 【v2.13 两段式提交】点击上传后暂存在内存里的待提交内容。
 * 只有在答题面板点「确认提交」时才真正上传（需求 2：「点击上传后先不上传」）。
 */
interface PendingSubmission {
	assignment: Assignment
	studentInfo: StudentInfo
	codeFiles: CollectedCodeFile[]
	log: CollectedLog
	runTraces: BundleRunTrace[]
	questions: BundleQuestion[]
	/** 出题来源（llm / template / mixed）与降级提示，用于面板顶部说明 */
	generatedBy: "llm" | "template" | "mixed"
	questionWarning?: string
	signals: QuestionSignals
	submittedAt: string
	idempotencyKey: string
	workspaceRoot: string
	/** BN-16：内容取自编辑器缓冲区、磁盘上还没保存的文件 */
	unsavedFiles: string[]
	/** 打码命中次数（面板与报告都要告知学生「已打码」） */
	redactionHits: number
}

/** 面板打开回调：由宿主（VscodeWebviewProvider）注入，避免 AssignmentManager 直接依赖 vscode 面板 */
export type ThinkingPanelOpener = (
	payload: ThinkingQuestionsPayload,
	onConfirm: (answers: BundleAnswer[]) => Promise<ThinkingConfirmResult>,
) => void

/** 统计文本行数（末尾换行不算空行），用于打码后重算 lineCount */
function countTextLines(text: string): number {
	if (!text) return 0
	const lines = text.replace(/\r\n/g, "\n").split("\n")
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
	return lines.length
}

/**
 * 从日志尾部倒查最近一条事件里的 taskId（Cline 内部任务 id）。
 * 不引入 Task 依赖：日志本身就是「当前任务」的最权威记录，且缺失时可降级（slice_missing）。
 */
function pickLatestTaskId(logText: string): string | null {
	if (!logText) return null
	const lines = logText.split("\n")
	const scanned = Math.min(lines.length, 200)
	for (let i = lines.length - 1; i >= lines.length - scanned; i--) {
		const line = lines[i]?.trim()
		if (!line || !line.startsWith("{")) continue
		try {
			const parsed = JSON.parse(line) as { taskId?: unknown; task_id?: unknown }
			const candidate = parsed.taskId ?? parsed.task_id
			if (typeof candidate === "string" && candidate.length > 0) return candidate
		} catch {
			// 坏行跳过：日志里允许存在半行
		}
	}
	return null
}

// ============================================================================
//  AssignmentManager 类
// ============================================================================

/**
 * 【方案 B — 通过 setApiBase 注入 API 地址】
 *
 * 配置优先级（从高到低）：
 * 1. 通过 setApiBase() 显式注入（优先级最高）
 * 2. VS Code 配置 `clineTeaching.serverUrl`（教学"服务器设置"面板，Wiki/答疑/实验任务共用）
 * 3. 旧配置 `teaching.apiBase`（兼容旧版设置）
 * 4. 构造函数参数 apiBase 默认值（兜底 http://localhost:4001）
 *
 * 推荐的调用方式：
 *   在插件 activate() 中创建 AssignmentManager 时，从 VS Code 配置加载：
 *     const manager = new AssignmentManager();
 *     manager.refreshApiBaseFromConfig();
 *   这样用户在设置中修改 serverUrl / teaching.apiBase 后，下次拉取/提交即生效。
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

	/** 【v2.13】待提交内容与答题面板回调（点击上传后暂存，确认后才上传） */
	private pendingSubmission: PendingSubmission | null = null
	private panelOpener: ThinkingPanelOpener | null = null
	/** 上传互斥：面板连点/重复确认时只允许一个在飞 */
	private uploadInFlight = false

	constructor(apiBase?: string) {
		// 若调用方未传值，使用默认兜底；后续可通过 refreshApiBaseFromConfig 或 setApiBase 覆盖
		this.apiBase = AssignmentManager.normalizeApiBase(apiBase ?? AssignmentManager.DEFAULT_API_BASE)
	}

	/**
	 * 【v2.10】归一化 API 地址：去首尾空白 + 去尾部斜杠。
	 * 用户在「服务器设置」填 `http://localhost:4001/`（尾斜杠）时，
	 * 拼接 `/api/v1/...` 会产生双斜杠路径 `//api/...`，Express 返回 404。
	 */
	private static normalizeApiBase(url: string): string {
		return url.trim().replace(/\/+$/, "")
	}

	/**
	 * 从 VS Code 配置读取 API 地址并应用。
	 * 【v2.6】与 LLMSettingsView 的"服务器设置"统一：优先 clineTeaching.serverUrl，
	 * 回退 teaching.apiBase，避免"服务器设置改了但实验任务仍用 localhost"。
	 * 应在插件 activation 时调用一次，之后可用 listenConfigChanges() 监听后续变更。
	 */
	public refreshApiBaseFromConfig(): void {
		// ① 优先：clineTeaching.serverUrl（服务器设置面板，Wiki/答疑/实验任务共用）
		const teachingCfg = vscode.workspace.getConfiguration("clineTeaching")
		const serverUrl = teachingCfg.get<string>("serverUrl")
		if (typeof serverUrl === "string" && serverUrl.trim()) {
			// 【v2.10】归一化：去尾斜杠，避免拼接出 //api 双斜杠 404
			this.apiBase = AssignmentManager.normalizeApiBase(serverUrl)
			return
		}

		// ② 回退：旧配置 teaching.apiBase（兼容旧版）
		const config = vscode.workspace.getConfiguration(AssignmentManager.CONFIG_SECTION)
		const fromConfig = config.get<string>(AssignmentManager.CONFIG_API_BASE)
		if (typeof fromConfig === "string" && fromConfig.trim()) {
			this.apiBase = AssignmentManager.normalizeApiBase(fromConfig)
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
			const affected =
				event.affectsConfiguration("clineTeaching.serverUrl") ||
				event.affectsConfiguration(`${AssignmentManager.CONFIG_SECTION}.${AssignmentManager.CONFIG_API_BASE}`)
			if (affected) {
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
		this.apiBase = AssignmentManager.normalizeApiBase(url)
	}

	/**
	 * 读取当前生效的 API 地址（用于诊断 / Webview 展示）。
	 */
	public getApiBase(): string {
		return this.apiBase
	}

	/**
	 * 【v2.7 网络稳定性】带自动重试的 fetch。
	 *
	 * 背景：热点 / 校园网等不稳定网络下，HTTPS 请求会间歇性 Connection reset
	 * （未备案 IP 被运营商 DPI 概率性干扰），导致"获取任务有时成功有时失败"。
	 * 这里对网络层错误（ECONNRESET / ECONNREFUSED / ETIMEDOUT 等）自动重试，
	 * 最多 attempts 次，间隔按 2 的幂退避。
	 * 非网络层错误（HTTP 4xx/5xx 等业务错误）不重试，直接返回响应 / 抛出。
	 */
	private async fetchWithRetry(
		url: string,
		init?: RequestInit,
		options: { attempts?: number; retryDelayMs?: number } = {},
	): Promise<Response> {
		const attempts = options.attempts ?? 4 // 1 次原始请求 + 最多 3 次重试
		const retryDelayMs = options.retryDelayMs ?? 800
		let lastError: unknown

		for (let attempt = 1; attempt <= attempts; attempt++) {
			try {
				const response = await fetch(url, init)
				// 已拿到响应（无论 2xx/4xx/5xx），业务错误由调用方处理，不在此重试
				return response
			} catch (error) {
				lastError = error
				const causeCode = (error as { cause?: { code?: string } })?.cause?.code
				const isNetworkError =
					error instanceof TypeError &&
					(typeof causeCode !== "string" ||
						[
							"ECONNRESET",
							"ECONNREFUSED",
							"ECONNABORTED",
							"ETIMEDOUT",
							"EPIPE",
							"ENOTFOUND",
							"UND_ERR_SOCKET",
							"UND_ERR_CONNECT_TIMEOUT",
						].includes(causeCode))

				if (!isNetworkError || attempt >= attempts) {
					throw error
				}

				// 退避等待后重试
				const delay = retryDelayMs * 2 ** (attempt - 1)
				await new Promise((resolve) => setTimeout(resolve, delay))
			}
		}

		throw lastError
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
		Logger.log(`[AssignmentManager] 工作区日志路径: ${path}（${created ? "新建" : "已存在"}）`)
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

				// 【v2.13】点击上传（第一段）：本地收集代码/日志/运行痕迹 + 生成思考题，
				// **不上传**；学生答完题在面板点确认后才走 confirmSubmission（第二段）。
				case "prepareSubmission": {
					const assignmentId = typeof payload["assignmentId"] === "string" ? (payload["assignmentId"] as string) : ""
					await this.handlePrepareSubmission({ assignmentId }, postMessage)
					break
				}

				// 面板内部走 onConfirm 回调；这里留一条 IPC 入口便于调试与后续复用
				case "confirmSubmission": {
					const answers = Array.isArray(payload["answers"]) ? (payload["answers"] as BundleAnswer[]) : []
					const result = await this.confirmSubmission(answers)
					postMessage({
						command: "confirmSubmission",
						success: result.success,
						data: result.data,
						error: result.error,
					})
					break
				}

				case "cancelSubmission": {
					this.cancelPendingSubmission()
					postMessage({ command: "cancelSubmission", success: true })
					break
				}

				case "openFile": {
					const filePath = typeof payload["filePath"] === "string" ? (payload["filePath"] as string) : ""
					await this.handleOpenFile({ filePath }, postMessage)
					break
				}

				case "downloadAttachment": {
					const assignmentId = typeof payload["assignmentId"] === "string" ? (payload["assignmentId"] as string) : ""
					const fileId = Number(payload["fileId"])
					const originalName = typeof payload["originalName"] === "string" ? (payload["originalName"] as string) : ""
					if (!assignmentId || !fileId) {
						postMessage({ command: "downloadAttachment", success: false, error: "缺少附件下载参数" })
						return
					}
					await this.handleDownloadAttachment({ assignmentId, fileId, originalName }, postMessage)
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

				// 【v2.6】查询已持久化的学生信息（webview 进入实验任务窗口时回填表单）
				case "loadStudentInfo": {
					try {
						const info = await this.loadStudentInfo()
						postMessage({ command: "loadStudentInfo", success: true, data: info })
					} catch (error) {
						postMessage({
							command: "loadStudentInfo",
							success: false,
							error: error instanceof Error ? error.message : String(error),
						})
					}
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

	// ============================================================================
	//  【v2.13】两段式提交：本地收集 → 生成思考题 → 面板答题 → 确认上传
	//  需求 2：点击上传后先不上传，由助手分析代码/日志并出题，学生答完才上传。
	// ============================================================================

	/** 宿主注入答题面板（VscodeWebviewProvider 用 extensionUri 创建单例面板） */
	public attachPanelOpener(opener: ThinkingPanelOpener | null): void {
		this.panelOpener = opener
	}

	/** 是否存在等待答题的待提交内容（面板关闭/重新提交时用于清理） */
	public hasPendingSubmission(): boolean {
		return this.pendingSubmission !== null
	}

	public cancelPendingSubmission(): void {
		this.pendingSubmission = null
	}

	/**
	 * 读取出题相关配置（`teaching.thinkingQuestionAuto` / `teaching.thinkingQuestionCount`）。
	 * 配置缺失时按裁定 R1 的默认值：开启自适应、默认 3 题。
	 */
	private readThinkingQuestionPolicy(): QuestionCountPolicy {
		try {
			const config = vscode.workspace.getConfiguration("teaching")
			return {
				auto: config.get<boolean>("thinkingQuestionAuto", true),
				configuredCount: config.get<number>("thinkingQuestionCount", 3),
			}
		} catch {
			return { auto: true, configuredCount: 3 }
		}
	}

	/**
	 * 构造一次性 LLM 调用器。
	 *
	 * 返回 undefined 表示「当前没有可用模型」——出题会自动退化成模板题，
	 * 而不是让提交失败（Q-8）。这里刻意不缓存 apiHandler：用户可能中途换模型/改 key。
	 */
	private createQuestionLLMCaller(): ((systemPrompt: string, userPrompt: string) => Promise<string>) | undefined {
		try {
			const config = StateManager.get().getApiConfiguration()
			const provider = (config as { apiProvider?: string } | undefined)?.apiProvider
			if (!config || !provider) return undefined
			const apiHandler = buildApiHandler(
				{ ...config, actModeThinkingBudgetTokens: 0, planModeThinkingBudgetTokens: 0 },
				"act",
			)
			return async (systemPrompt: string, userPrompt: string): Promise<string> => {
				let text = ""
				for await (const chunk of apiHandler.createMessage(systemPrompt, [{ role: "user", content: userPrompt }])) {
					if (chunk.type === "text") text += chunk.text
				}
				return text
			}
		} catch (error) {
			Logger.warn("[AssignmentManager] 无法初始化出题模型，将使用模板题", error as Error)
			return undefined
		}
	}

	/**
	 * 第一段：点击「上传」时调用。
	 *
	 * 只做本地工作，全程零上传：
	 *   ① 解析学生信息与任务信息（任务来自缓存或现拉一次列表）
	 *   ② 收集工作区代码文件（活动编辑器优先，≤20 个 × 1MB）
	 *   ③ 读取日志原文（路径由 resolver 决定，不再写死）+ 运行痕迹
	 *   ④ 按「材料丰富度」自适应生成 3~5 道思考题
	 *   ⑤ 打开答题面板，把答案回调接到 confirmSubmission
	 *
	 * 失败时只提示、不开面板，也不会污染待提交状态。
	 */
	private async handlePrepareSubmission(
		{ assignmentId }: { assignmentId: string },
		postMessage: (response: AssignmentResponse) => void,
	): Promise<void> {
		if (!assignmentId) {
			postMessage({ command: "prepareSubmission", success: false, error: "缺少任务 ID" })
			return
		}

		const studentInfo = await this.loadStudentInfo()
		if (!studentInfo) {
			const msg = "❌ 请先在设置中填写学生信息（学号/姓名/班级）后再提交"
			vscode.window.showErrorMessage(msg)
			postMessage({ command: "prepareSubmission", success: false, error: msg })
			return
		}

		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
		if (!workspaceRoot) {
			const msg = "❌ 请先打开一个工作区文件夹：提交需要读取工作区里的代码与日志"
			vscode.window.showErrorMessage(msg)
			postMessage({ command: "prepareSubmission", success: false, error: msg })
			return
		}

		const assignment = await this.resolveAssignmentById(assignmentId)
		if (!assignment) {
			const msg = `❌ 未找到任务「${assignmentId}」，请刷新任务列表后重试`
			vscode.window.showErrorMessage(msg)
			postMessage({ command: "prepareSubmission", success: false, error: msg })
			return
		}

		try {
			// ① 当前编辑器缓冲区（BN-16：未保存的内容也要能提交）
			const activeDoc = vscode.window.activeTextEditor?.document
			const activeFilePath = activeDoc?.uri.fsPath ?? null
			const unsavedFiles: string[] = []
			const collected = collectCodeFiles({ workspaceRoot, activeFilePath })

			// ② 代码文件：密钥打码 + 未保存内容优先（内容在客户端还完整时才处理，BN-11/BN-12/BN-16）
			let redactionHits = 0
			const codeFiles = collected.files.map((file) => {
				let content = file.buffer.toString("utf8")
				if (activeDoc && activeDoc.isDirty && !activeDoc.isUntitled && file.absPath === activeFilePath) {
					content = activeDoc.getText()
					unsavedFiles.push(file.relPath)
				}
				const redacted = redactForFile(file.relPath, content)
				if (redacted.hits === 0 && content === file.buffer.toString("utf8")) return file
				redactionHits += redacted.hits
				const buffer = Buffer.from(redacted.text, "utf8")
				return {
					...file,
					buffer,
					sizeBytes: buffer.byteLength,
					lineCount: countTextLines(redacted.text),
				}
			})

			// ③ 日志：切片（找不到 task_id 时降级为 run_result + 尾部 200 行，BN-06）
			const logResolution = resolveStudentLogFile(workspaceRoot)
			const rawLog = collectLog(logResolution?.path ?? null)
			const rawLogText = rawLog.buffer ? rawLog.buffer.toString("utf8") : ""
			const activeTaskId = pickLatestTaskId(rawLogText)
			const sliced = sliceLogForUpload(rawLogText, { taskId: activeTaskId })
			const log: CollectedLog = {
				...rawLog,
				buffer: Buffer.from(sliced.text, "utf8"),
				lineCount: sliced.lineCount,
				info: {
					...rawLog.info,
					line_count: sliced.lineCount,
					bad_lines: sliced.badLines,
					slice_missing: sliced.sliceMissing,
					truncated: sliced.truncated || sliced.sliceMissing,
				},
			}
			const runTraces = readRunTraces(workspaceRoot)
			const logEvents = summarizeLogEvents(log.buffer)

			// ④ 出题信号 → 自适应题数
			const signals: QuestionSignals = {
				codeLineCount: codeFiles.reduce((sum, file) => sum + file.lineCount, 0),
				fileCount: codeFiles.length,
				runCount: runTraces.length,
				failureCount: runTraces.filter((trace) => typeof trace.exit_code === "number" && trace.exit_code !== 0).length,
				descriptionChars: (assignment.description ?? "").length,
				codeEditCount: logEvents.codeEdit,
			}
			// ④' 出题：优先 LLM，失败/不可用自动降级为模板题（Q-8：绝不阻断提交）
			const generated = await generateThinkingQuestions(
				{
					signals,
					assignment: { id: assignmentId, title: assignment.title, description: assignment.description },
					codeFiles: codeFiles.map((file) => ({
						relPath: file.relPath,
						content: file.buffer.toString("utf8"),
					})),
					runTraces,
					logLineCount: log.lineCount,
					policy: this.readThinkingQuestionPolicy(),
				},
				{ callLLM: this.createQuestionLLMCaller() },
			)
			const questions = generated.questions
			const submittedAt = new Date().toISOString()

			this.pendingSubmission = {
				assignment,
				studentInfo,
				codeFiles,
				log,
				runTraces,
				questions,
				generatedBy: generated.generatedBy,
				questionWarning: generated.warning,
				signals,
				submittedAt,
				idempotencyKey: randomUUID(),
				workspaceRoot,
				unsavedFiles,
				redactionHits,
			}

			// ⑤ 开面板
			if (!this.panelOpener) {
				const msg = "❌ 答题面板未初始化，请重启 VS Code 后重试"
				vscode.window.showErrorMessage(msg)
				postMessage({ command: "prepareSubmission", success: false, error: msg })
				return
			}
			const payload: ThinkingQuestionsPayload = {
				assignmentId,
				assignmentTitle: assignment.title,
				assignmentDescription: assignment.description,
				questions,
				codeFiles: codeFiles.map((file) => ({ relPath: file.relPath, sizeBytes: file.sizeBytes })),
				logPath: log.path,
				logLineCount: log.lineCount,
				runTraceCount: runTraces.length,
				generatedBy: generated.generatedBy,
				questionWarning: generated.warning,
				questionCountReason: generated.decision.reason,
				submittedAt,
				redactionHits,
				unsavedFiles,
			}
			this.panelOpener(payload, (answers) => this.confirmSubmission(answers))

			vscode.window.showInformationMessage(
				`📦 已收集 ${codeFiles.length} 个代码文件、${log.lineCount} 行日志` +
					`${collected.omitted.length > 0 ? `（${collected.omitted.length} 个文件被跳过）` : ""}` +
					`${redactionHits > 0 ? `（已打码 ${redactionHits} 处敏感信息）` : ""}，` +
					`请完成 ${questions.length} 道思考题后提交。`,
			)
			postMessage({
				command: "prepareSubmission",
				success: true,
				data: {
					questions: questions.length,
					codeFiles: codeFiles.length,
					omittedFiles: collected.omitted.length,
					logLineCount: log.lineCount,
					logBadLines: sliced.badLines,
					logTruncated: sliced.truncated,
					logSliceMissing: sliced.sliceMissing,
					runTraceCount: runTraces.length,
					generatedBy: generated.generatedBy,
					warning: generated.warning,
					questionCountReason: generated.decision.reason,
					redactionHits,
					unsavedFiles: unsavedFiles.length,
					panelOpened: true,
				},
			})
		} catch (error) {
			const msg = `❌ 收集提交材料失败: ${error instanceof Error ? error.message : String(error)}`
			vscode.window.showErrorMessage(msg)
			postMessage({ command: "prepareSubmission", success: false, error: msg })
		}
	}

	/**
	 * 第二段：面板里点「确认提交」时调用 —— 唯一真正上传的入口。
	 *
	 * 一次性 multipart 上传：meta（含题目与答案）+ 日志原文 + 代码文件。
	 * 失败不清理待提交内容，学生可以直接重试（idempotency_key 保证重试不会重复入库）。
	 */
	public async confirmSubmission(answers: BundleAnswer[]): Promise<ThinkingConfirmResult> {
		const pending = this.pendingSubmission
		if (!pending) return { success: false, error: "提交上下文已失效，请回到任务列表重新点击上传" }
		if (this.uploadInFlight) return { success: false, error: "正在上传，请稍候…" }
		if (!Array.isArray(answers) || answers.length === 0) return { success: false, error: "请先完成所有思考题" }

		this.uploadInFlight = true
		try {
			const meta = buildBundleMeta({
				assignmentId: pending.assignment.id,
				studentId: pending.studentInfo.studentId,
				studentName: pending.studentInfo.studentName,
				classId: pending.studentInfo.classId,
				submittedAt: pending.submittedAt,
				taskId: pending.assignment.id,
				questions: pending.questions,
				answers,
				logInfo: pending.log.info,
				runTraces: pending.runTraces,
				clientVersion: this.getClientVersion(),
				idempotencyKey: pending.idempotencyKey,
				unsavedFiles: pending.unsavedFiles,
			})

			const response = await postBundle({
				apiBase: this.apiBase,
				meta,
				logBuffer: pending.log.buffer,
				logFileName: "student_interactions.log",
				codeFiles: pending.codeFiles,
			})

			const body = response.body as { ok?: boolean; code?: string; error?: string }
			if (!response.ok || body?.ok !== true) {
				// P2-1：把服务端错误码翻译成学生能照做的中文（否则只会看到 HTTP 413）
				if (response.status === 413) {
					return {
						success: false,
						error: "提交包超过教师端单包上限（25 MB）。请清理工作区里的大文件（模型/数据集/压缩包）后再提交。",
					}
				}
				if (response.status === 415) {
					return { success: false, error: "提交包里有服务端不接受的文件类型，请检查工作区后重试。" }
				}
				const detail = body?.error ?? body?.code ?? "未知错误"
				return { success: false, error: `上传失败 (HTTP ${response.status})：${detail}` }
			}

			const result = response.body as BundleIngestResult
			this.pendingSubmission = null

			const aiDependencyPercent = Math.round((result.metrics?.ai_dependency ?? 0) * 100)
			vscode.window.showInformationMessage(
				`✅ 实验「${pending.assignment.title}」提交成功（第 ${result.revision} 版）` +
					`｜AI 依赖度 ${aiDependencyPercent}%｜代码文件 ${result.stored?.code_count ?? pending.codeFiles.length} 个`,
			)
			Logger.log(`[AssignmentManager] 提交包上传成功 submission_id=${result.submission_id} revision=${result.revision}`)
			return { success: true, data: result }
		} catch (error) {
			const rawMsg = error instanceof Error ? error.message : String(error)
			const isNetworkError = /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(rawMsg)
			const friendlyMsg = isNetworkError
				? `无法连接教学服务器 ${this.apiBase}，请检查网络或服务器设置后重试`
				: `上传失败：${rawMsg}`
			Logger.warn(`[AssignmentManager] confirmSubmission 失败: ${rawMsg}`)
			return { success: false, error: friendlyMsg }
		} finally {
			this.uploadInFlight = false
		}
	}

	/**
	 * 取任务详情：先查列表缓存，miss 则现拉一次 `/api/v1/assignments`。
	 * 提交需要 title/description（出题用），所以不能只依赖 webview 传回的 payload。
	 */
	private async resolveAssignmentById(assignmentId: string): Promise<Assignment | null> {
		const cached = this.cachedAssignmentsById.get(assignmentId)
		if (cached) return cached

		try {
			const response = await this.fetchWithRetry(`${this.apiBase}/api/v1/assignments`, { method: "GET" })
			if (!response.ok) return null
			const result = (await response.json()) as { ok?: boolean; data?: Assignment[] }
			const list = Array.isArray(result?.data) ? result.data : []
			for (const item of list) {
				if (item?.id) this.cachedAssignmentsById.set(item.id, item)
			}
			return this.cachedAssignmentsById.get(assignmentId) ?? null
		} catch (error) {
			Logger.warn(
				`[AssignmentManager] resolveAssignmentById 失败: ${error instanceof Error ? error.message : String(error)}`,
			)
			return null
		}
	}

	/** 客户端版本（写进 meta.client_version，便于排查"哪个版本的学生端传的包有问题"） */
	private getClientVersion(): string {
		const candidates = ["cline.cline", "saoudrizwan.claude-dev"]
		for (const id of candidates) {
			try {
				const version = vscode.extensions.getExtension(id)?.packageJSON?.version
				if (typeof version === "string" && version) return `cline-extension/${version}`
			} catch {
				// 忽略：取不到版本不影响上传
			}
		}
		return "cline-extension/unknown"
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
			// ----- 调用后端 API 获取任务列表（带网络重试，缓解热点下间歇性 reset）-----
			const response = await this.fetchWithRetry(`${this.apiBase}/api/v1/assignments`, {
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
			// 【诊断增强】展示当前生效的 apiBase + 具体网络错误（cause），
			// 便于定位"配置未生效 / 端口不通 / 代理拦截"等问题
			const cause = error instanceof Error && (error as { cause?: { code?: string; message?: string } }).cause
			const causeDetail = cause ? cause.code || cause.message || String(cause) : ""
			const msg = error instanceof Error ? error.message : String(error)
			const detail = `${msg}${causeDetail ? ` (${causeDetail})` : ""} [apiBase=${this.apiBase}]`
			vscode.window.showErrorMessage(`❌ 获取实验任务失败: ${detail}`)
			postMessage({
				command: "fetchAssignments",
				success: false,
				error: detail,
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
			const response = await this.fetchWithRetry(`${this.apiBase}/api/v1/assignments`, {
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

	/**
	 * 【附件下载】Webview 点击附件 → 从后端下载附件到本地工作区并打开。
	 *
	 * 背景：附件实际存储在 teaching-server 的 uploads/ 目录，学生本地工作区
	 * 并没有该文件。此前把 original_name 当本地路径打开必然报"文件不存在"。
	 * 现在改为通过后端下载接口
	 *   GET /api/v1/assignments/:id/attachments/:fileId/download
	 * 将附件保存到工作区根目录后，再在编辑器中打开。
	 */
	private async handleDownloadAttachment(
		payload: { assignmentId: string; fileId: number; originalName?: string },
		postMessage: (response: AssignmentResponse) => void,
	): Promise<void> {
		try {
			const { assignmentId, fileId, originalName } = payload
			if (!assignmentId || !fileId) {
				throw new Error("缺少附件下载参数")
			}

			// ----- 校验工作区是否打开 -----
			const workspaceFolders = vscode.workspace.workspaceFolders
			if (!workspaceFolders || workspaceFolders.length === 0) {
				throw new Error("未打开工作区，无法保存附件")
			}
			const workspaceRoot = workspaceFolders[0].uri.fsPath

			// ----- 调用后端下载接口（返回二进制流） -----
			const downloadUrl = `${this.apiBase}/api/v1/assignments/${encodeURIComponent(
				assignmentId,
			)}/attachments/${fileId}/download`
			const response = await this.fetchWithRetry(downloadUrl, {
				method: "GET",
			})
			if (!response.ok) {
				throw new Error(`附件下载失败: HTTP ${response.status}`)
			}

			// ----- 文件名解析 -----
			// 优先使用 webview 传入的 originalName（任务列表中的原始文件名，中文正常）。
			// 后端 res.download 的 Content-Disposition 对中文会做 latin1+UTF-8 双重编码
			// （filename*=UTF-8''%C3%A5...），解析后反而是乱码，故仅作为兜底。
			let fileName = originalName || ""
			if (!fileName) {
				const disposition = response.headers.get("content-disposition") ?? ""
				const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i)
				const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
				if (utf8Match) {
					try {
						fileName = decodeURIComponent(utf8Match[1])
					} catch {
						fileName = utf8Match[1]
					}
				} else if (plainMatch) {
					fileName = plainMatch[1]
				}
			}
			if (!fileName) {
				fileName = `attachment_${fileId}`
			}
			// 文件名安全过滤（防止路径穿越）
			const safeFileName = path.basename(fileName).replace(/[\\/:*?"<>|]/g, "_")

			// ----- 写入工作区根目录 -----
			const targetPath = path.join(workspaceRoot, safeFileName)
			const buffer = Buffer.from(await response.arrayBuffer())
			fs.writeFileSync(targetPath, buffer)

			// ----- 打开文件（PDF 等二进制用 showTextDocument 可能乱码，走系统默认应用） -----
			const uri = vscode.Uri.file(targetPath)
			const isTextLike = /\.(txt|md|py|js|ts|json|c|cpp|h|java|html|css|xml|yml|yaml|log|sql|sh)$/i.test(safeFileName)
			if (isTextLike) {
				const document = await vscode.workspace.openTextDocument(uri)
				await vscode.window.showTextDocument(document, { preview: false })
			} else {
				await vscode.commands.executeCommand("vscode.open", uri)
			}

			vscode.window.showInformationMessage(`📄 已下载附件: ${safeFileName}`)
			postMessage({
				command: "downloadAttachment",
				success: true,
				data: { filePath: targetPath, fileName: safeFileName },
			})
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(`❌ 下载附件失败: ${msg}`)
			postMessage({ command: "downloadAttachment", success: false, error: msg })
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

			// ----- ⑤ POST 提交至云端后端（带网络重试，缓解热点下间歇性 reset）-----
			const response = await this.fetchWithRetry(`${this.apiBase}/api/v1/submissions`, {
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
				{
					ts: new Date().toISOString(),
					eventType: "adoption_infer",
					role: "user",
					category: "other",
					adoptionStatus: "adopted",
				},
				{
					ts: new Date().toISOString(),
					eventType: "adoption_infer",
					role: "user",
					category: "other",
					adoptionStatus: "adopted",
				},
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
	private async handleExitToChat(postMessage: (response: AssignmentResponse) => void): Promise<void> {
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
