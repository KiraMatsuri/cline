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

export interface EnsureResult {
  /** 完整路径 */
  path: string
  /** true = 本次新建，false = 文件已存在 */
  created: boolean
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
  const logDir = path.join(workspaceRoot, ".cline-logs")
  const logPath = path.join(logDir, "student_interactions.log")

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