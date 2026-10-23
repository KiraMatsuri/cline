/**
 * v3 去周数 · 结构守卫
 *
 * 目的：教学周（currentWeek / max_week / --week / weekStateFile）这一整套概念已整体移除，
 * 任何一处**回潮**都会让「学生按自己的进度看资料」这条隐含边界重新出现，
 * 而它已经在教师端被删掉（后端 `max_week` 可选、资料全量可见）。
 *
 * 因此这里做纯文本守卫：
 *   ① package.json 不得再声明 `clineTeaching.currentWeek`
 *   ② src/ 与 webview-ui/src/ 不得再引用已删除的周数 API / 模块
 *   ③ MCP 工具的 inputSchema 不得再出现 `week`
 *
 * 为什么用文本守卫而不是类型守卫：被删的导出**不存在**这件事，tsc 是检查不出来的
 * （只会检查"引用不存在的导出"），而"有人把 week 参数又加回来"往往以新增字段的形式出现。
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"

// 仓库根：mocha 始终从仓库根执行（package.json 的 test:unit），
// 这里不依赖 __dirname —— 该文件可能被 node 的原生 TS 支持按 ESM 加载，那环境下 __dirname 不存在。
const REPO_ROOT = process.cwd()

/** 递归收集若干目录下的 .ts/.tsx 源码（跳过 build / node_modules / 测试自身） */
function collectSources(roots: string[]): string[] {
	const out: string[] = []
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name)
			if (entry.isDirectory()) {
				if (["node_modules", "build", "dist", ".git", "out"].includes(entry.name)) continue
				walk(abs)
				continue
			}
			if (!/\.(ts|tsx)$/.test(entry.name)) continue
			if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue
			out.push(abs)
		}
	}
	for (const r of roots) walk(path.join(REPO_ROOT, r))
	return out
}

describe("v3 去周数 · 结构守卫", () => {
	it("★ package.json 不再声明 clineTeaching.currentWeek", () => {
		const pkg = fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")
		expect(pkg.includes("clineTeaching.currentWeek")).to.equal(false)
	})

	it("★ src/ 与 webview-ui/src/ 不再引用已删除的周数模块/接口", () => {
		const forbidden = [
			"weekStateFile",
			"weekStatePath",
			"weekSwitchNotice",
			"getCurrentWeek",
			"setCurrentWeek",
			"fetchWikiForWeek",
			"loadTextbookForWeek",
			"buildIndexGroups",
		]
		const hits: string[] = []
		for (const file of collectSources(["src", path.join("webview-ui", "src")])) {
			const text = fs.readFileSync(file, "utf-8")
			for (const token of forbidden) {
				if (text.includes(token)) hits.push(`${path.relative(REPO_ROOT, file)} → ${token}`)
			}
		}
		expect(hits).to.deep.equal([])
	})

	it("★ 前端不再有周数选择器组件与「学习进度」控件", () => {
		const hits: string[] = []
		for (const file of collectSources([path.join("webview-ui", "src")])) {
			const text = fs.readFileSync(file, "utf-8")
			if (text.includes("WikiWeekSelector") || text.includes("teachingCurrentWeek") || text.includes("学习进度")) {
				hits.push(path.relative(REPO_ROOT, file))
			}
		}
		expect(hits).to.deep.equal([])
	})

	it("★ MCP server 的 inputSchema 不再出现 week 参数", () => {
		const server = fs.readFileSync(path.join(REPO_ROOT, "src", "core", "teaching", "mcp-wiki-server.ts"), "utf-8")
		// 只检查工具定义区（main() 之前），注释行不算
		const code = server
			.split("\n")
			.filter((line) => {
				const t = line.trim()
				return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"))
			})
			.join("\n")
		expect(code.includes("max_week")).to.equal(false)
		expect(code.includes('"week"')).to.equal(false)
	})
})
