/**
 * =============================================================================
 *  workspaceLogPath — 自动工作区日志路径工具 (v2.5 增量)
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 当用户打开工作区时，自动：
 *   1. 取第一个工作区根目录
 *   2. 在 `<root>/.cline-logs/student_interactions.log` 创建空文件（不存在时）
 *   3. 返回路径 + 是否新建
 *
 * 【决策点】
 * - 默认子目录：`.cline-logs/`（与 Cline 内部日志一致）
 * - 文件名固定：`student_interactions.log`（与 backend 看板格式一致）
 * - 空白文件：只创建 0 字节文件，由 Cline 真正记录行为时追加
 *
 * =============================================================================
 */

import * as fs from "fs"
import * as path from "path"
import * as vscode from "vscode"
import type { LogPathResolution } from "./logPathResolver"
import { defaultStudentLogPath, resolveLogPath } from "./logPathResolver"

export interface EnsureResult {
	/** 完整路径 */
	path: string
	/** true = 本次新建，false = 文件已存在 */
	created: boolean
}

/**
 * 解析当前工作区的日志文件路径（不创建文件）。
 *
 * 与终端脚本 `scripts/analyze-student-log.ts` 共用同一条解析链
 * （`logPathResolver.resolveLogPath`），保证「扩展上传的日志」与
 * 「终端分析的日志」是同一个文件。
 *
 * @param workspaceRoot 可选，默认取 workspaceFolders[0]
 * @returns 解析结果；无工作区时返回 null
 */
export function resolveStudentLogFile(workspaceRoot?: string | null): LogPathResolution | null {
	const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (!root) {
		return null
	}
	// cwd 也传 root：避免扩展宿主进程的 cwd 落在别的工作区时向上回溯到错误的日志
	return resolveLogPath({ workspaceRoot: root, cwd: root })
}

/**
 * 当前工作区的日志目录 `<root>/.cline-logs`（不创建）。
 */
export function resolveStudentLogDir(workspaceRoot?: string | null): string | null {
	const root = workspaceRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	if (!root) {
		return null
	}
	return path.join(root, ".cline-logs")
}

/**
 * 在当前工作区根目录下创建/读取 student_interactions.log。
 *
 * @returns EnsureResult 或 null（无工作区）
 */
export function ensureStudentLogFile(): EnsureResult | null {
	const folders = vscode.workspace.workspaceFolders
	if (!folders || folders.length === 0) {
		return null
	}

	const workspaceRoot = folders[0].uri.fsPath
	const logPath = defaultStudentLogPath(workspaceRoot)
	const logDir = path.dirname(logPath)

	try {
		// 确保目录存在
		if (!fs.existsSync(logDir)) {
			fs.mkdirSync(logDir, { recursive: true })
		}

		// 文件已存在 → 直接返回
		if (fs.existsSync(logPath)) {
			return { path: logPath, created: false }
		}

		// 创建空白文件
		fs.writeFileSync(logPath, "", "utf8")
		Logger.log(`[workspaceLogPath] 已创建空白日志文件: ${logPath}`)
		return { path: logPath, created: true }
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		console.warn(`[workspaceLogPath] 创建日志文件失败: ${msg}`)
		return null
	}
}

// 避免 TS6133：在 keep imports 模式下提供 Logger stub
const Logger = {
	log: (msg: string) => console.log(msg),
}
