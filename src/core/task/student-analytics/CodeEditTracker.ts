/**
 * 代码编辑行为追踪器
 * Code Edit Tracker - Monitors student code editing behavior via VSCode API
 *
 * 监听的事件：
 * 1. vscode.workspace.onDidChangeTextDocument - 文本变更
 * 2. vscode.workspace.onDidSaveTextDocument - 文件保存
 *
 * 设计思路：
 * - 防抖：短时间内多次编辑合并为一条日志（2 秒防抖）
 * - 忽略非用户编辑文件（如 .git、node_modules、.cline-logs 等）
 * - 记录变更量（字符差异）
 */

import * as path from "path"
import * as vscode from "vscode"
import { asRelativePath } from "@/utils/path"
import type { AdoptionTracker } from "./AdoptionTracker"
import type { BehaviorMonitor } from "./BehaviorMonitor"
import { contentAnalyzer } from "./ContentAnalyzer"
import type { StudentLogPersister } from "./StudentLogPersister"
import type { StudentInteractionLog } from "./types"

/** 防抖间隔（毫秒） */
const DEBOUNCE_MS = 2_000

/** 应忽略的目录/文件名模式 */
const IGNORE_PATTERNS = [
	/[/\\]\.git[/\\]/,
	/[/\\]node_modules[/\\]/,
	/[/\\]\.cline-logs[/\\]/,
	/[/\\]dist[/\\]/,
	/[/\\]out[/\\]/,
	/\.log$/,
	/\.lock$/,
	/package-lock\.json$/,
	/pnpm-lock\.yaml$/,
]

/**
 * 待处理的编辑事件
 */
interface PendingEdit {
	filePath: string
	totalDelta: number
	timer: ReturnType<typeof setTimeout>
}

export class CodeEditTracker implements vscode.Disposable {
	private disposables: vscode.Disposable[] = []
	private pendingEdits: Map<string, PendingEdit> = new Map()

	/** 当前活跃的任务 ID（由外部设置） */
	private activeTaskId: string | undefined

	/** 持久化服务（由外部注入） */
	private persister: StudentLogPersister | undefined

	/** 采纳追踪器（由外部注入） */
	private adoptionTracker: AdoptionTracker | undefined

	/** 实时行为监测器（由外部注入） */
	private behaviorMonitor: BehaviorMonitor | undefined

	constructor() {
		// 监听文本文档变更
		this.disposables.push(vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChange(e)))

		// 监听文件保存
		this.disposables.push(vscode.workspace.onDidSaveTextDocument((doc) => this.onDocumentSave(doc)))
	}

	/**
	 * 设置当前活跃任务信息
	 */
	public setContext(
		taskId: string,
		persister: StudentLogPersister,
		adoptionTracker: AdoptionTracker,
		behaviorMonitor?: BehaviorMonitor,
	): void {
		this.activeTaskId = taskId
		this.persister = persister
		this.adoptionTracker = adoptionTracker
		this.behaviorMonitor = behaviorMonitor
	}

	/**
	 * 清除当前任务上下文
	 */
	public clearContext(): void {
		this.activeTaskId = undefined
		this.persister = undefined
		this.adoptionTracker = undefined
		this.behaviorMonitor = undefined
	}

	/**
	 * 文档变更事件处理（防抖）
	 */
	private onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
		if (!this.activeTaskId || !this.persister) {
			return
		}

		const filePath = event.document.uri.fsPath
		if (this.shouldIgnore(filePath)) {
			return
		}

		// 只处理用户编辑的文件（不是输出、终端等）
		if (event.document.uri.scheme !== "file") {
			return
		}

		// 计算变更量
		let delta = 0
		for (const change of event.contentChanges) {
			delta += change.text.length - change.rangeLength
		}

		// 防抖处理
		const existing = this.pendingEdits.get(filePath)
		if (existing) {
			clearTimeout(existing.timer)
			existing.totalDelta += delta
			existing.timer = setTimeout(() => this.flushEdit(filePath), DEBOUNCE_MS)
		} else {
			this.pendingEdits.set(filePath, {
				filePath,
				totalDelta: delta,
				timer: setTimeout(() => this.flushEdit(filePath), DEBOUNCE_MS),
			})
		}

		// 通知采纳追踪器
		if (this.adoptionTracker && this.activeTaskId) {
			this.adoptionTracker.onCodeEdit(this.activeTaskId)
		}
	}

	/**
	 * 文件保存事件处理
	 */
	private async onDocumentSave(document: vscode.TextDocument): Promise<void> {
		if (!this.activeTaskId || !this.persister) {
			return
		}

		const filePath = document.uri.fsPath
		if (this.shouldIgnore(filePath)) {
			return
		}
		if (document.uri.scheme !== "file") {
			return
		}

		// 通知采纳追踪器
		if (this.adoptionTracker && this.activeTaskId) {
			this.adoptionTracker.onFileSave(this.activeTaskId)
		}

		// 记录 file_save 日志
		const relativePath = await asRelativePath(filePath)
		const languageHint = contentAnalyzer.inferLanguage(document.getText().substring(0, 500))

		const log: StudentInteractionLog = {
			ts: new Date().toISOString(),
			taskId: this.activeTaskId,
			eventType: "file_save",
			role: "user",
			category: "other",
			contentLength: document.getText().length,
			hasCode: true,
			languageHint,
			imageCount: 0,
			fileCount: 0,
			turnIndex: -1, // file_save 不占轮次
			filePath: relativePath,
		}

		void this.persister.persist(log)
		this.behaviorMonitor?.ingest(log)
	}

	/**
	 * 刷新防抖缓冲区中的编辑事件
	 */
	private async flushEdit(filePath: string): Promise<void> {
		const pending = this.pendingEdits.get(filePath)
		if (!pending || !this.activeTaskId || !this.persister) {
			this.pendingEdits.delete(filePath)
			return
		}

		const relativePath = await asRelativePath(filePath)
		const ext = path.extname(filePath).toLowerCase()
		const languageHint = this.inferLanguageFromExtension(ext)

		const log: StudentInteractionLog = {
			ts: new Date().toISOString(),
			taskId: this.activeTaskId,
			eventType: "code_edit",
			role: "user",
			category: "other",
			contentLength: Math.abs(pending.totalDelta),
			hasCode: true,
			languageHint,
			imageCount: 0,
			fileCount: 0,
			turnIndex: -1, // code_edit 不占轮次
			filePath: relativePath,
			changeDelta: pending.totalDelta,
		}

		void this.persister.persist(log)
		this.behaviorMonitor?.ingest(log)
		this.pendingEdits.delete(filePath)
	}

	/**
	 * 判断路径是否应该忽略
	 */
	private shouldIgnore(filePath: string): boolean {
		return IGNORE_PATTERNS.some((pattern) => pattern.test(filePath))
	}

	/**
	 * 根据文件后缀推断语言
	 */
	private inferLanguageFromExtension(ext: string): "cpp" | "python" | "java" | "javascript" | "typescript" | "c" | "unknown" {
		const extMap: Record<string, "cpp" | "python" | "java" | "javascript" | "typescript" | "c"> = {
			".py": "python",
			".java": "java",
			".cpp": "cpp",
			".cc": "cpp",
			".cxx": "cpp",
			".hpp": "cpp",
			".h": "c",
			".c": "c",
			".js": "javascript",
			".jsx": "javascript",
			".mjs": "javascript",
			".ts": "typescript",
			".tsx": "typescript",
		}
		return extMap[ext] || "unknown"
	}

	/**
	 * 释放事件监听器
	 */
	public dispose(): void {
		// 清理所有防抖定时器
		for (const pending of this.pendingEdits.values()) {
			clearTimeout(pending.timer)
		}
		this.pendingEdits.clear()

		// 释放 VSCode 事件订阅
		for (const d of this.disposables) {
			d.dispose()
		}
		this.disposables = []
	}
}
