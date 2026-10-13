/**
 * 教学周状态的共享文件（插件 ↔ MCP 独立进程）。
 *
 * 为什么不用 VS Code 配置：MCP server 是**独立进程**，读不到 clineTeaching.currentWeek
 * （见 mcp/args.ts 的文件头说明）。文件是两侧唯一可行的共享通道。
 *
 * ⚠️ 本模块**必须保持纯 fs**（只用 node:fs/promises 与 node:path），
 *    因为它会被 `mcp-wiki-server.ts` 那个独立进程的 bundle 引用；
 *    一旦引入编辑器 API / 存储层 / 宿主抽象，MCP 进程会直接崩。
 *    路径的推导（需要 ensureSettingsDirectoryExists）放在插件侧的 weekStatePath.ts。
 */
import { readFile, writeFile } from "node:fs/promises"

export const WEEK_STATE_FILE_NAME = "teaching-week.json"

export interface WeekState {
	week: number
	updatedAt: string
}

/** 写入当前教学周（插件侧在周数变更时调用）。失败**不抛**，只返回 false。 */
export async function writeWeekState(filePath: string, week: number): Promise<boolean> {
	try {
		const state: WeekState = { week, updatedAt: new Date().toISOString() }
		await writeFile(filePath, JSON.stringify(state), "utf-8")
		return true
	} catch {
		return false
	}
}

/**
 * 读取当前教学周（MCP 侧每次工具调用前调用）。
 * 文件缺失 / JSON 损坏 / week 不在 1..18 → 返回 **null**（调用方回退到 spawn 参数），不抛错。
 */
export async function readWeekState(filePath: string): Promise<number | null> {
	try {
		const raw = JSON.parse(await readFile(filePath, "utf-8")) as Partial<WeekState>
		const w = Number(raw?.week)
		if (!Number.isInteger(w) || w < 1 || w > 18) return null
		return w
	} catch {
		return null
	}
}
