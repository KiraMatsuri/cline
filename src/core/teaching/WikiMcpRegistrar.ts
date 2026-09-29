/**
 * WikiMcpRegistrar — wiki MCP server 的配置自注册（v2.13）
 *
 * 三条操作边界（见 docs/design/wiki-mcp-retrieval-design.md §D2）：
 *   1) 禁用（disabled=true）  → 尊重，不覆盖（由 watcher 提示后果，见 §D5）
 *   2) 删除条目              → 不允许：每次激活检测，缺失即重建
 *   3) 篡改 command/args     → 覆盖回正确值
 *
 * 路径约定（Task 0 + Task 5 实测）：
 *   - **必须用 `await ensureSettingsDirectoryExists()` 作为入参**，即与 McpHub 用同一个函数：
 *     `getMcpSettingsFilePath` **不会**拼接 `settings/` 子目录，它只做
 *     `path.join(入参, "cline_mcp_settings.json")`。
 *     而 McpHub 构造时传的是 `() => ensureSettingsDirectoryExists()`（= `<globalStorage>/settings`）。
 *   - ⚠️ **反面教训**：早先（包括本计划 Task 0 的笔记）曾误以为该函数内部会拼 `settings/`，
 *     于是传 `context.globalStorageUri.fsPath` —— 那会写到 `<globalStorage>/cline_mcp_settings.json`，
 *     **McpHub 永远不会看到**，整个功能静默失效。这类“写入了但没人读”的故障极难排查。
 *   - 目录名是发布后的扩展 ID（`shiinamatsuri.student-teaching-assistant-edu`），
 *     不是上游的 `saoudrizwan.claude-dev` → 同样禁止硬编码。
 *   - 写入后无需调用任何 McpHub API：chokidar watcher 会自动触发 updateServerConnections()
 *     （awaitWriteFinish 100ms 防抖、atomic: true）。只要不置位 isUpdatingClineSettings，重载必定发生。
 */
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { ensureSettingsDirectoryExists, getMcpSettingsFilePath } from "@core/storage/disk"
import { Logger } from "@/shared/services/Logger"
import { clampWeek } from "./mcp/args"

export interface McpServerEntry {
	type: "stdio"
	command: string
	args: string[]
	env?: Record<string, string>
	autoApprove?: string[]
	timeout?: number
	disabled?: boolean
}

type McpServersMap = Record<string, McpServerEntry>

export const WIKI_SERVER_NAME = "wiki"
export const WIKI_TOOL_NAMES = ["search_wiki", "read_wiki_chunk", "list_wiki_weeks"]

export function buildWikiServerEntry(opts: {
	execPath: string
	scriptPath: string
	week: number
	serverUrl: string
}): McpServerEntry {
	return {
		type: "stdio",
		command: opts.execPath,
		args: [opts.scriptPath, "--week", String(clampWeek(opts.week)), "--server", opts.serverUrl],
		// stdio server 是独立进程：用 VS Code 自带的 node 运行脚本
		env: { ELECTRON_RUN_AS_NODE: "1" },
		autoApprove: [...WIKI_TOOL_NAMES],
		timeout: 30,
	}
}

/** 合并逻辑（纯函数，便于单测）：只补缺失与不一致，不动 disabled，不动其它 server */
export function mergeWikiServerEntry(
	existing: McpServersMap,
	entry: McpServerEntry,
): { changed: boolean; next: McpServersMap } {
	const next: McpServersMap = { ...existing }
	const cur = next[WIKI_SERVER_NAME]

	// 1) 条目缺失 → 写入（"删除无效"）
	if (!cur) {
		next[WIKI_SERVER_NAME] = entry
		return { changed: true, next }
	}

	// 2) 被禁用 → 尊重，完全不改（"禁用可控"）
	if (cur.disabled === true) {
		return { changed: false, next }
	}

	// 3) 内容不一致（含 command/args 被篡改）→ 覆盖为正确值
	const same =
		cur.command === entry.command &&
		JSON.stringify(cur.args ?? []) === JSON.stringify(entry.args) &&
		cur.type === entry.type &&
		JSON.stringify(cur.autoApprove ?? []) === JSON.stringify(entry.autoApprove ?? [])
	if (same) {
		return { changed: false, next }
	}

	next[WIKI_SERVER_NAME] = { ...entry, disabled: false }
	return { changed: true, next }
}

/** 读取配置文件的结果类型 */
export type McpSettingsOutcome = "missing" | "ok" | "broken"

/**
 * 决定该怎么处理配置文件（纯函数，便于单测）。
 *
 * ⚠️ `broken` 必须 abort：配置文件**存在但 JSON 解析失败**时若继续写入，
 * 会把学生配置的其它 MCP server 一并清空。宁可这次不注册（等对方的写入完成/修好），
 * 也绝不覆盖 —— 这与本项目"清洗失败不得回写截断原文"是同一条教训。
 */
export function decideWriteAction(outcome: McpSettingsOutcome, changed: boolean): "write" | "skip" | "abort" {
	if (outcome === "broken") {
		return "abort"
	}
	return changed ? "write" : "skip"
}

interface ReadResult {
	filePath: string
	map: McpServersMap
	raw: Record<string, unknown>
	outcome: McpSettingsOutcome
}

/** 读取 MCP 配置文件，并区分「不存在」与「存在但坏了」两种情况 */
async function readMcpSettings(settingsDir: string): Promise<ReadResult> {
	const filePath = await getMcpSettingsFilePath(settingsDir)

	let text: string
	try {
		text = await fs.readFile(filePath, "utf-8")
	} catch {
		// 文件不存在（首次安装）→ 可以安全新建
		return { filePath, map: {}, raw: {}, outcome: "missing" }
	}

	try {
		const raw = JSON.parse(text) as Record<string, unknown>
		return { filePath, map: (raw.mcpServers as McpServersMap) ?? {}, raw, outcome: "ok" }
	} catch {
		// 文件存在但解析失败（半写入 / 手工编辑语法错）→ 绝不覆盖
		return { filePath, map: {}, raw: {}, outcome: "broken" }
	}
}

/**
 * 确保 wiki server 条目存在且正确。
 * 每次插件激活都会调用（覆盖"被意外删除"的情况）。
 */
export async function ensureWikiMcpServer(context: vscode.ExtensionContext): Promise<void> {
	try {
		const cfg = vscode.workspace.getConfiguration("clineTeaching")
		const week = cfg.get<number>("currentWeek") ?? 1
		const serverUrl = (cfg.get<string>("serverUrl") ?? "").trim()

		const scriptPath = path.join(context.extensionPath, "dist", "mcp-wiki-server.js")
		const entry = buildWikiServerEntry({
			execPath: process.execPath,
			scriptPath,
			week,
			serverUrl,
		})

		// 必须与 McpHub 用同一个函数取目录（它是 `<globalStorage>/settings`）。
		// 切勿改回 `context.globalStorageUri.fsPath` —— 那会写到 McpHub 看不到的位置。
		const settingsDir = await ensureSettingsDirectoryExists()
		const { filePath, map, raw, outcome } = await readMcpSettings(settingsDir)
		const { changed, next } = mergeWikiServerEntry(map, entry)

		const action = decideWriteAction(outcome, changed)
		if (action === "abort") {
			Logger.error(
				`[WikiMcpRegistrar] MCP 配置文件存在但无法解析，为避免清空其它 MCP server，本次放弃写入: ${filePath}`,
			)
			return
		}
		if (action === "skip") {
			Logger.log(`[WikiMcpRegistrar] wiki MCP 条目已是最新，跳过写入`)
			return
		}

		raw.mcpServers = next
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf-8")
		Logger.log(`[WikiMcpRegistrar] 已写入/更新 wiki MCP 条目: ${filePath}`)
	} catch (e) {
		// 注册失败不应阻断插件启动
		Logger.error("[WikiMcpRegistrar] 注册失败:", e as Error)
	}
}

/** 监听周数变化 → 重写 args（使 MCP server 用新的 week 重启） */
export function registerWikiMcpConfigWatcher(context: vscode.ExtensionContext): vscode.Disposable {
	const disposable = vscode.workspace.onDidChangeConfiguration((e) => {
		if (!e.affectsConfiguration("clineTeaching.currentWeek") && !e.affectsConfiguration("clineTeaching.serverUrl")) {
			return
		}
		void ensureWikiMcpServer(context)
	})
	context.subscriptions.push(disposable)
	return disposable
}
