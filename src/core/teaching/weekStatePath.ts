/**
 * 教学周状态文件的**路径推导**（仅插件侧可用）。
 *
 * ⚠️ 必须与 MCP 配置文件同目录：用 `ensureSettingsDirectoryExists()`，与 McpHub / WikiMcpRegistrar 完全一致，
 *    **禁止硬编码扩展 ID 或拼 "settings"**（历史事故：`getMcpSettingsFilePath(dir)` 只做 dir 拼接）。
 * ⚠️ 本模块不得被 `mcp-wiki-server.ts` 引用（它 import 了 disk ⇒ 会引入 vscode）。
 */

import { ensureSettingsDirectoryExists } from "@core/storage/disk"
import * as path from "path"
import { WEEK_STATE_FILE_NAME } from "./weekStateFile"

export async function weekStateFilePath(): Promise<string> {
	return path.join(await ensureSettingsDirectoryExists(), WEEK_STATE_FILE_NAME)
}
