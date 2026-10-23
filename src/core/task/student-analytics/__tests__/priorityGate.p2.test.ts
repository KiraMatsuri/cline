/**
 * G2 · P2 优先级综合测试（L2 层）
 *
 * 覆盖 plan-2 §0 的四类检查：正常路径 / 边界条件 / 回归 / 核心流程可跑通。
 * P2 范围：F8（联网检索 MCP）、F9（ai_dependency 指标）。
 *
 * 【v3 去周数】F7（周数热更新 + 切换通知）随教学周概念整体移除，
 * 原 G2-①/②/③ 三条用例改为「周数机制必须已消失」的结构守卫（G2-①'）。
 * 【P2-2】阻断式干预已删除：所有干预都只产生软提示文本。
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { expect } from "chai"
import { parseMcpArgs } from "@/core/teaching/mcp/args"
import { buildWebSearchError, parseWebSearchResults } from "@/core/teaching/mcp-web/webSearchPayload"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { getRulePolicy } from "../rulePolicy"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import { editEv, ev } from "./__fixtures__/events"

const ruleIds = (m: BehaviorMonitor): string[] => m.getPendingAlerts().map((a) => a.ruleId)
const runtimeProp = (obj: object, key: string): unknown => (obj as unknown as Record<string, unknown>)[key]

describe("G2 · 优先级综合（可跑通 + 边界）", () => {
	// ---------------- 统一模板（4 例，软提示口径） ----------------

	it("★ 核心流程端到端：AI 真实落盘 3 次 → 计数 → 只产生软提示文本（无阻断）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m.ingest(
				ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: `第 ${i} 次` }),
			)
			m.ingest(editEv({ editor: "ai" }))
		}
		expect(m.getAiCodingCount()).to.equal(3)
		const mgr = new TeachingInterventionManager("t1")
		const text = mgr.checkAndGenerateIntervention(m, 3)
		expect(text).to.be.a("string").and.to.not.be.empty
		expect(text).to.not.include("阻断模式")
		expect(runtimeProp(mgr, "isBlockingActive")).to.equal(undefined)
	})

	it("★【P2-2】代码规则只提示：计数照旧、不产生阻断", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(ev({}))
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(3)
		expect(ruleIds(m)).to.include("consecutive_code_generation")
	})

	it("★ 边界：概念问答下规则被门控停用（rulePolicy）", () => {
		expect(getRulePolicy("consecutive_code_generation", "algorithm").enabled).to.equal(false)
		expect(getRulePolicy("consecutive_code_generation", "code_generation").enabled).to.equal(true)
	})

	it("★ 关掉特性开关后行为回到旧口径（enabled=false）", () => {
		const m = new BehaviorMonitor("t1", { enabled: false, cooldownMs: 0 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(ev({}))
		expect(m.getPendingAlerts()).to.have.length(0)
	})

	// ---------------- P2 专项断言 ①–④ ----------------

	it("【G2-①'】周数机制已整体移除（结构守卫：源码与配置都不得再出现 week）", async () => {
		const teachingDir = path.join(__dirname, "..", "..", "..", "teaching")
		// 1) 周状态文件模块已被删除
		for (const f of ["weekStateFile.ts", "weekStatePath.ts", "weekSwitchNotice.ts"]) {
			let exists = true
			try {
				await fs.access(path.join(teachingDir, f))
			} catch {
				exists = false
			}
			expect(exists, `${f} 应已删除`).to.equal(false)
		}

		// 2) MCP 入口不再热读周数（注释里提到"不再有 --week"是允许的，只看代码行）
		const src = await fs.readFile(path.join(teachingDir, "mcp-wiki-server.ts"), "utf-8")
		const code = src
			.split("\n")
			.filter((line) => {
				const t = line.trim()
				return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"))
			})
			.join("\n")
		expect(code.includes("effectiveWeek")).to.equal(false)
		expect(code.includes("--week")).to.equal(false)
		expect(code.includes("readWeekState")).to.equal(false)
		expect(src).to.include("parseMcpArgs")

		// 3) package.json 不再暴露 clineTeaching.currentWeek
		const pkg = await fs.readFile(path.join(__dirname, "..", "..", "..", "..", "..", "package.json"), "utf-8")
		expect(pkg.includes("clineTeaching.currentWeek")).to.equal(false)
	})

	it("【G2-②'】MCP 启动参数只认 --server；旧 --week 被忽略", () => {
		const bare = parseMcpArgs(["--server", "http://h:4001"])
		expect(bare).to.deep.equal({ serverUrl: "http://h:4001" })
		const full = parseMcpArgs(["--week", "9", "--server", "http://h:4001/", "--week-file", "C:/a/b.json"])
		expect(full).to.deep.equal({ serverUrl: "http://h:4001" }) // 去尾斜杠，且无 week 字段
	})

	it("【G2-④】概念问答：单次提问零提示（M2'/M3' 的通过条件）；规则本身已启用且只产生软提示", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "explanation" }))
		for (let i = 0; i < 8; i++) m.ingest(ev({ role: "assistant" }))
		// 单次请求内的多回合不算依赖（T19-b），因此这里既不计数也不提示
		expect(m.getWeightedDependencyScore()).to.equal(0.5) // 【P6/T7】概念问答的加权依赖度只记 50%
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("high_recent_ai_dependency")
		// 【P6/T6】规则策略白名单反转：概念分类下依赖规则改为**启用**（可提示），但策略对象不含阻断字段
		expect(getRulePolicy("high_recent_ai_dependency", "algorithm")).to.deep.equal({ enabled: true })
		expect(runtimeProp(m, "shouldEscalateToBlocking")).to.equal(undefined)

		// 【P6/T7】加权口径下的可见后果：概念问答只记 50%，所以必须**反复**提问才命中
		// （6 次概念提问 3.0 = 3 次编码类提问）。上面那次 task_start 已是第 1 次提问，
		// 故"累计 5 次 = 2.5"仍不命中 —— 旧断言（第 2 次提问即计数 > 0）钉住的是加权前的语义。
		for (let i = 0; i < 4; i++) m.ingest(ev({ role: "user", category: "explanation" }))
		expect(m.getWeightedDependencyScore()).to.equal(2.5)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("high_recent_ai_dependency")

		m.ingest(ev({ role: "user", category: "explanation" })) // 第 6 次提问 ⇒ 3.0 ⇒ 出现温和提示
		expect(m.getWeightedDependencyScore()).to.be.closeTo(3, 1e-9)
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("high_recent_ai_dependency")

		// 非概念任务下仍然可用（权重 1.0 ⇒ 阈值边界：2 次提问不触发、第 3 次触发）
		const m2 = new BehaviorMonitor("t2", { cooldownMs: 0 })
		for (let i = 0; i < 2; i++) {
			m2.ingest(ev({ taskId: "t2", role: "user", category: "code_generation" }))
		}
		expect(m2.getWeightedDependencyScore()).to.equal(2)
		expect(m2.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		m2.ingest(ev({ taskId: "t2", role: "user", category: "code_generation" }))
		expect(m2.getEscalationCount("high_recent_ai_dependency")).to.equal(1)
	})

	it("【G2-⑤】联网检索失败必须返回结构化错误且不抛错（F8 硬要求）", () => {
		const codes = ["backend_unreachable", "endpoint_missing", "timeout", "bad_response"] as const
		for (const c of codes) {
			const p = buildWebSearchError(c)
			expect(p.ok, c).to.equal(false)
			expect(p.error, c).to.equal(c)
			expect(p.message.length, c).to.be.greaterThan(0)
		}
		// 畸形响应 → null（调用方据此用 bad_response，而不是编造内容）
		expect(parseWebSearchResults(null)).to.equal(null)
		expect(parseWebSearchResults({ results: "nope" })).to.equal(null)
		expect(parseWebSearchResults({ results: [{ title: "t" }] })).to.equal(null)
	})
})
