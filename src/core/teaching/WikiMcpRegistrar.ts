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

import { ensureSettingsDirectoryExists, getMcpSettingsFilePath } from "@core/storage/disk"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"

/** McpHub 的最小结构依赖（便于单测，避免 teaching 层绑定 McpHub 实现） */
export interface McpHubLike {
	getServers: () => Array<{ name?: string; status?: string; disabled?: boolean }>
}

export interface McpServerEntry {
	type: "stdio"
	command: string
	args: string[]
	env?: Record<string, string>
	autoApprove?: string[]
	timeout?: number
	disabled?: boolean
}

export type McpServersMap = Record<string, McpServerEntry>

export const WIKI_SERVER_NAME = "wiki"
export const WIKI_TOOL_NAMES = ["search_wiki", "read_wiki_chunk", "list_wiki_weeks"]

export function buildWikiServerEntry(opts: { execPath: string; scriptPath: string; serverUrl: string }): McpServerEntry {
	// 【v3 去周数】只传后端地址：检索范围 = 教师发布的全部资料，不再有「当前第几周」
	const args = [opts.scriptPath, "--server", opts.serverUrl]
	return {
		type: "stdio",
		command: opts.execPath,
		args,
		// stdio server 是独立进程：用 VS Code 自带的 node 运行脚本
		env: { ELECTRON_RUN_AS_NODE: "1" },
		autoApprove: [...WIKI_TOOL_NAMES],
		timeout: 30,
	}
}

/** 合并逻辑（纯函数，便于单测）：只补缺失与不一致，不动 disabled，不动其它 server */
export function mergeWikiServerEntry(existing: McpServersMap, entry: McpServerEntry): { changed: boolean; next: McpServersMap } {
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

/** 移除 wiki 条目（纯函数，便于单测） */
export function removeWikiServerEntry(existing: McpServersMap): { changed: boolean; next: McpServersMap } {
	if (!(WIKI_SERVER_NAME in existing)) {
		return { changed: false, next: existing }
	}
	const next: McpServersMap = { ...existing }
	delete next[WIKI_SERVER_NAME]
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
		const enabled = cfg.get<boolean>("llmEnableTools") ?? true
		const serverUrl = (cfg.get<string>("serverUrl") ?? "").trim()

		// 必须与 McpHub 用同一个函数取目录（它是 `<globalStorage>/settings`）。
		// 切勿改回 `context.globalStorageUri.fsPath` —— 那会写到 McpHub 看不到的位置。
		const settingsDir = await ensureSettingsDirectoryExists()

		// 【v2.13】`clineTeaching.llmEnableTools` = “是否启用课程资料检索（MCP）”。
		// 关闭时**移除条目**而不是写 `disabled: true`：后者会被 watchWikiServerDisabled
		// 判定为“学生禁用了检索”并弹“是否重新启用”——但这条路径本就是学生自己在设置页
		// 关掉的，再弹一次属于噪音，且与设置项语义直接打架。
		if (!enabled) {
			const cur = await readMcpSettings(settingsDir)
			if (cur.outcome === "broken") {
				Logger.error(`[WikiMcpRegistrar] MCP 配置文件存在但无法解析，跳过移除: ${cur.filePath}`)
				return
			}
			const removed = removeWikiServerEntry(cur.map)
			if (!removed.changed) {
				Logger.log("[WikiMcpRegistrar] 检索开关已关闭且条目本就不存在，跳过写入")
				return
			}
			cur.raw.mcpServers = removed.next
			await fs.writeFile(cur.filePath, JSON.stringify(cur.raw, null, 2), "utf-8")
			Logger.log(`[WikiMcpRegistrar] 检索开关已关闭 → 已移除 wiki MCP 条目: ${cur.filePath}`)
			return
		}

		const scriptPath = path.join(context.extensionPath, "dist", "mcp-wiki-server.js")
		const entry = buildWikiServerEntry({
			execPath: process.execPath,
			scriptPath,
			serverUrl,
		})

		const { filePath, map, raw, outcome } = await readMcpSettings(settingsDir)
		const { changed, next } = mergeWikiServerEntry(map, entry)

		const action = decideWriteAction(outcome, changed)
		if (action === "abort") {
			Logger.error(`[WikiMcpRegistrar] MCP 配置文件存在但无法解析，为避免清空其它 MCP server，本次放弃写入: ${filePath}`)
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

/** 监听服务地址/检索开关变化 → 重写或移除条目 */
export function registerWikiMcpConfigWatcher(context: vscode.ExtensionContext): vscode.Disposable {
	const disposable = vscode.workspace.onDidChangeConfiguration((e) => {
		if (!e.affectsConfiguration("clineTeaching.serverUrl") && !e.affectsConfiguration("clineTeaching.llmEnableTools")) {
			return
		}
		void ensureWikiMcpServer(context).then(() => probeWikiMcpAvailability())
	})
	context.subscriptions.push(disposable)
	return disposable
}

/** 检测"由启用变为禁用"这一次状态跃迁（避免每次读文件都弹提示） */
export function detectDisabledTransition(prev: McpServersMap, next: McpServersMap): boolean {
	const p = prev[WIKI_SERVER_NAME]
	const n = next[WIKI_SERVER_NAME]
	if (!n) {
		return false
	}
	const wasDisabled = p?.disabled === true
	const nowDisabled = n.disabled === true
	return !wasDisabled && nowDisabled
}

/** 轮询间隔。禁用动作发生在 Cline 自带的 MCP 面板里，我们无法直接拦截那次点击（见 spec §D5）。 */
const DISABLED_POLL_MS = 2000

/**
 * 监听 wiki server 被禁用 → 提示后果并提供"重新启用"。
 *
 * 为什么用**轮询**而不是文件监听：
 *   McpHub 写这个文件是**原子写**（临时文件 + rename），对单文件做 fs.watch 会被这种模式坑到；
 *   而该文件很小，2s 读一次的开销可忽略。轮询同时也避开了跨平台差异。
 *
 * ⚠️ 首次读取**只作为基线**，不判定跃迁。否则"用户本来就把 server 禁用了"这种情况
 * 会在每次激活时都弹一次警告 —— 那与 spec §D5「禁用可控（尊重学生选择）」直接矛盾。
 */
export function watchWikiServerDisabled(context: vscode.ExtensionContext): vscode.Disposable {
	let lastMap: McpServersMap | undefined

	const tick = async (): Promise<void> => {
		try {
			// 与 McpHub 用同一个函数取目录（切勿改成 context.globalStorageUri.fsPath）
			const settingsDir = await ensureSettingsDirectoryExists()
			const { map } = await readMcpSettings(settingsDir)
			// 首次只建立基线：没有"上一次"就不存在"跃迁"
			if (lastMap !== undefined && detectDisabledTransition(lastMap, map)) {
				// 必须走 host bridge（项目规范禁止直接用 vscode.window），
				// 且它在 JetBrains / CLI 宿主下也有实现
				const res = await HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message: "课程资料检索已禁用：AI 将无法获取教师发布的课程资料，可能给出超出教学进度的回答。是否重新启用？",
					options: { modal: false, items: ["重新启用", "保持禁用"] },
				})
				if (res.selectedOption === "重新启用") {
					await reEnableWikiServer()
				}
			}
			lastMap = map
			// 【v2.13】顺带刷新连接状态。
			// 为什么不能只在激活时探测：MCP server 是**异步**拉起并重载的，
			// 激活瞬间往往还是 connecting —— 只探一次会把“尚未连接”误当成“不可用”并一直错下去。
			await probeWikiMcpAvailability()
		} catch {
			// 读配置失败不影响主流程
		}
	}

	void tick()
	const timer = setInterval(() => void tick(), DISABLED_POLL_MS)
	const disposable = new vscode.Disposable(() => clearInterval(timer))
	context.subscriptions.push(disposable)
	return disposable
}

/** 把条目写回 disabled:false（用于学生在提示里选择"重新启用"） */
export async function reEnableWikiServer(): Promise<void> {
	try {
		// 同样必须用 ensureSettingsDirectoryExists()，否则会写到 McpHub 看不到的位置
		const settingsDir = await ensureSettingsDirectoryExists()
		const { filePath, map, raw, outcome } = await readMcpSettings(settingsDir)
		if (outcome === "broken") {
			Logger.error(`[WikiMcpRegistrar] 配置文件无法解析，放弃重新启用: ${filePath}`)
			return
		}
		const cur = map[WIKI_SERVER_NAME]
		if (!cur) {
			return
		}
		map[WIKI_SERVER_NAME] = { ...cur, disabled: false }
		raw.mcpServers = map
		await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf-8")
		Logger.log("[WikiMcpRegistrar] 已重新启用 wiki MCP server")
	} catch (e) {
		Logger.error("[WikiMcpRegistrar] 重新启用失败:", e as Error)
	}
}

/**
 * wiki MCP server 是否“已连接且未被禁用”（纯函数，便于单测）。
 *
 * ⚠️ 注意力陷阱：`McpHub` **没有** `getInstance()` / `getMcpServers()`。
 * 它只能从 `WebviewProvider.getInstance().controller.mcpHub` 拿到，取服务列表的方法是 `getServers()`。
 * 若照拄设计稿里的 `McpHub.getInstance?.()`，会永远拿到 undefined → 永远判定“不可用”，
 * 而且**不报任何错**（与本项目历史上“写入了但没人读”同类的静默失效）。
 */
export function isWikiServerConnected(hub: McpHubLike | undefined | null): boolean {
	if (!hub || typeof hub.getServers !== "function") {
		return false
	}
	try {
		const servers = hub.getServers() ?? []
		const wiki = servers.find((s) => s.name === WIKI_SERVER_NAME)
		return wiki !== undefined && wiki.status === "connected" && wiki.disabled !== true
	} catch {
		return false
	}
}

/**
 * 探测 wiki MCP 连接状态并回写 `LLMWikiService`，供注入内容决定是否带“检索不可用”声明。
 * 探测失败一律按**不可用**处理（失败可见优于静默假装可用）。
 */
export async function probeWikiMcpAvailability(): Promise<void> {
	const { LLMWikiService } = await import("./LLMWikiService")
	try {
		// Controller 是唯一持有 McpHub 的地方，它通过 WebviewProvider 单例暴露。
		const { WebviewProvider } = await import("@/core/webview")
		const controller = (WebviewProvider.getInstance() as unknown as { controller?: { mcpHub?: unknown } })?.controller
		LLMWikiService.getInstance().setWikiMcpAvailable(isWikiServerConnected(controller?.mcpHub as McpHubLike | undefined))
	} catch (e) {
		Logger.warn("[WikiMcpRegistrar] 探测 MCP 状态失败，按不可用处理:", e as Error)
		LLMWikiService.getInstance().setWikiMcpAvailable(false)
	}
}
