/**
 * MCP server 启动参数解析（v3：去周数）
 *
 * 为什么仍要经启动参数传 serverUrl：
 *   stdio MCP server 是**独立进程**，进程内没有 vscode 模块，读不到扩展配置。
 *
 * 【v3 变更】不再传 `--week` / `--week-file`：
 *   教学周概念已从整个系统移除，资料检索改为「按提问内容召回全部已发布资料」。
 *   旧配置里残留的 `--week` 仍会被**静默忽略**（不报错、不写入注册项），
 *   由 `WikiMcpRegistrar` 在下次激活时把 args 覆盖回正确值。
 */

export interface McpArgs {
	serverUrl: string
}

export function parseMcpArgs(argv: string[]): McpArgs {
	let serverUrl = ""

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === "--server") {
			const raw = String(argv[i + 1] ?? "").trim()
			serverUrl = raw.endsWith("/") ? raw.slice(0, -1) : raw
			i++
		}
		// 兼容旧参数：`--week N` / `--week-file P` 直接跳过其值，避免被当成位置参数
		else if (a === "--week" || a === "--week-file") {
			i++
		}
	}

	return { serverUrl }
}
