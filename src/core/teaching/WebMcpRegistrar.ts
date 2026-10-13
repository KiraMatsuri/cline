/**
 * WebMcpRegistrar — 联网检索 MCP server 的配置自注册（F8）
 *
 * 镜像 `WikiMcpRegistrar.ts`，**同三条操作边界**：
 *   1) 禁用（disabled=true）  → 尊重，不覆盖（学生的禁用选择不被回写）
 *   2) 删除条目              → 不允许：每次激活检测，缺失即重建
 *   3) 篡改 command/args     → 覆盖回正确值
 *
 * 路径约定与 wiki 版**完全一致**（Task 0 + Task 5 实测）：
 *   - **必须用 `await ensureSettingsDirectoryExists()` 作为入参**，即与 McpHub 用同一个函数：
 *     `getMcpSettingsFilePath` **不会**拼接 `settings/` 子目录，它只做
 *     `path.join(入参, "cline_mcp_settings.json")`。
 *     McpHub 构造时传的是 `() => ensureSettingsDirectoryExists()`（= `<globalStorage>/settings`）。
 *   - ⚠️ **反面教训**：早先曾误以为该函数内部会拼 `settings/`，于是传
 *     `context.globalStorageUri.fsPath` —— 那会写到 `<globalStorage>/cline_mcp_settings.json`，
 *     **McpHub 永远不会看到**，整个功能静默失效。这类"写入了但没人读"的故障极难排查。
 *   - 目录名是发布后的扩展 ID，不是上游的 `saoudrizwan.claude-dev` → 同样禁止硬编码。
 *   - 写入后无需调用任何 McpHub API：chokidar watcher 会自动触发 updateServerConnections()
 *     （awaitWriteFinish 100ms 防抖、atomic: true）。只要不置位 isUpdatingClineSettings，重载必定发生。
 *
 * ── D1/D2 取舍（本任务实现 D1）──────────────────────────────────────────────
 * D1（实现）：检索能力由**教学后端**端点提供（`GET {server}{endpoint}?q=…&limit=…`）。
 *   理由：API Key 归属教师、内容安全与成本集中在后端管控（与 wiki 检索同一条原则）。
 * D2（不做）：直连第三方搜索 API，key 放插件设置。
 *
 * ⚠️ **后端端点在 `d:\cline` 仓库之外且尚未实现**：本注册器只负责把"入口"写进 MCP 配置，
 *    端点路径可经 `endpoint` 参数配置。端点缺失/不可达时由 server 返回结构化错误、不阻断对话。
 *
 * 与 wiki 版的对应关系：`merge/remove` 与 `decideWriteAction` 与 wiki 版**同语义**；
 * `decideWriteAction` 直接从 `./WikiMcpRegistrar` 复用（已导出），下面的 `readMcpSettings`
 * 是 wiki 版同名私有函数的**同语义最小副本**（wiki 版未导出它），以保证"坏文件不覆盖（abort）"一致。
 */
import { ensureSettingsDirectoryExists, getMcpSettingsFilePath } from "@core/storage/disk"
import * as fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { decideWriteAction, type McpServerEntry, type McpServersMap, type McpSettingsOutcome } from "./WikiMcpRegistrar"

export const WEB_SEARCH_SERVER_NAME = "web-search"
export const WEB_SEARCH_TOOL_NAMES = ["web_search"]

export function buildWebSearchServerEntry(opts: {
	execPath: string
	scriptPath: string
	serverUrl: string
	/** 可选的自定义检索端点路径（缺省由 server 侧取 `/api/v1/web-search`）；仅在提供时追加 `--endpoint` */
	endpoint?: string
}): McpServerEntry {
	const args = [opts.scriptPath, "--server", opts.serverUrl]
	if (opts.endpoint) {
		args.push("--endpoint", opts.endpoint)
	}
	return {
		type: "stdio",
		command: opts.execPath,
		args,
		// stdio server 是独立进程：用宿主自带的 node 运行脚本
		env: { ELECTRON_RUN_AS_NODE: "1" },
		autoApprove: [...WEB_SEARCH_TOOL_NAMES],
		timeout: 30,
	}
}

/** 合并逻辑（纯函数，便于单测）：只补缺失与不一致，不动 disabled，不动其它 server */
export function mergeWebSearchServerEntry(
	existing: McpServersMap,
	entry: McpServerEntry,
): { changed: boolean; next: McpServersMap } {
	const next: McpServersMap = { ...existing }
	const cur = next[WEB_SEARCH_SERVER_NAME]

	// 1) 条目缺失 → 写入（"删除无效"）
	if (!cur) {
		next[WEB_SEARCH_SERVER_NAME] = entry
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

	next[WEB_SEARCH_SERVER_NAME] = { ...entry, disabled: false }
	return { changed: true, next }
}

/** 移除 web-search 条目（纯函数，便于单测） */
export function removeWebSearchServerEntry(existing: McpServersMap): { changed: boolean; next: McpServersMap } {
	if (!(WEB_SEARCH_SERVER_NAME in existing)) {
		return { changed: false, next: existing }
	}
	const next: McpServersMap = { ...existing }
	delete next[WEB_SEARCH_SERVER_NAME]
	return { changed: true, next }
}

interface ReadResult {
	filePath: string
	map: McpServersMap
	raw: Record<string, unknown>
	outcome: McpSettingsOutcome
}

/**
 * 读取 MCP 配置文件，并区分「不存在」与「存在但坏了」两种情况。
 * 与 `WikiMcpRegistrar` 内同名私有函数**同语义**（那份未导出，故此处给出最小副本）。
 */
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
 * 确保 web-search server 条目存在且正确（或按开关移除）。
 *
 * `enabled === false` ⇒ **移除条目**（**不是**写 `disabled: true`，这是计划的硬要求"移除而非 disabled"）：
 * 与 wiki 版同理，写 `disabled: true` 会被"学生禁用了检索"的检测逻辑误判为需要弹窗提示，
 * 而这条路径本就是教师端下发关闭的，再弹一次属于噪音。
 *
 * 无变化就不写（避免无谓触发 chokidar 重载）；配置文件存在但坏掉时 abort，绝不覆盖其它 server。
 */
export async function syncWebSearchMcpServer(opts: {
	enabled: boolean
	execPath: string
	scriptPath: string
	serverUrl: string
	endpoint?: string
}): Promise<"written" | "removed" | "skipped" | "aborted"> {
	try {
		// 必须与 McpHub 用同一个函数取目录（它是 `<globalStorage>/settings`）。
		// 切勿改回 `context.globalStorageUri.fsPath` —— 那会写到 McpHub 看不到的位置。
		const settingsDir = await ensureSettingsDirectoryExists()

		if (!opts.enabled) {
			const cur = await readMcpSettings(settingsDir)
			if (cur.outcome === "broken") {
				Logger.error(`[WebMcpRegistrar] MCP 配置文件存在但无法解析，跳过移除: ${cur.filePath}`)
				return "aborted"
			}
			const removed = removeWebSearchServerEntry(cur.map)
			if (!removed.changed) {
				Logger.log("[WebMcpRegistrar] 联网检索开关已关闭且条目本就不存在，跳过写入")
				return "skipped"
			}
			cur.raw.mcpServers = removed.next
			await fs.writeFile(cur.filePath, JSON.stringify(cur.raw, null, 2), "utf-8")
			Logger.log(`[WebMcpRegistrar] 联网检索开关已关闭 → 已移除 web-search MCP 条目: ${cur.filePath}`)
			return "removed"
		}

		const entry = buildWebSearchServerEntry({
			execPath: opts.execPath,
			scriptPath: opts.scriptPath,
			serverUrl: opts.serverUrl,
			endpoint: opts.endpoint,
		})

		const { filePath, map, raw, outcome } = await readMcpSettings(settingsDir)
		const { changed, next } = mergeWebSearchServerEntry(map, entry)

		const action = decideWriteAction(outcome, changed)
		if (action === "abort") {
			Logger.error(`[WebMcpRegistrar] MCP 配置文件存在但无法解析，为避免清空其它 MCP server，本次放弃写入: ${filePath}`)
			return "aborted"
		}
		if (action === "skip") {
			Logger.log("[WebMcpRegistrar] web-search MCP 条目已是最新，跳过写入")
			return "skipped"
		}

		raw.mcpServers = next
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf-8")
		Logger.log(`[WebMcpRegistrar] 已写入/更新 web-search MCP 条目: ${filePath}`)
		return "written"
	} catch (e) {
		// 注册失败不应阻断插件启动
		Logger.error("[WebMcpRegistrar] 注册失败:", e as Error)
		return "aborted"
	}
}
