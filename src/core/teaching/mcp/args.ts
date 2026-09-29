/**
 * MCP server 启动参数解析（v2.13）
 *
 * 为什么周数要经启动参数传入：
 *   stdio MCP server 是**独立进程**，进程内没有 vscode 模块，
 *   读不到 clineTeaching.currentWeek。只能由插件在 spawn 时注入。
 *   好处是"当前周"这个权威值始终在模型进程之外传递（见 spec §D1）。
 */

/** 周数收紧到 [1,18]；非法值回退 1（最保守，不泄露后续周内容） */
export function clampWeek(n: unknown): number {
	const v = Number(n)
	if (!Number.isFinite(v)) {
		return 1
	}
	const i = Math.floor(v)
	if (i < 1) {
		return 1
	}
	if (i > 18) {
		return 18
	}
	return i
}

export interface McpArgs {
	week: number
	serverUrl: string
}

export function parseMcpArgs(argv: string[]): McpArgs {
	let week = 1
	let serverUrl = ""

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === "--week") {
			week = clampWeek(argv[i + 1])
			i++
		} else if (a === "--server") {
			const raw = String(argv[i + 1] ?? "").trim()
			serverUrl = raw.endsWith("/") ? raw.slice(0, -1) : raw
			i++
		}
	}

	return { week, serverUrl }
}
