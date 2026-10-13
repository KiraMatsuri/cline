/**
 * G2 · P2 优先级综合测试（L2 层）
 *
 * 覆盖 plan-2 §0 的四类检查：正常路径 / 边界条件 / 回归 / 核心流程可跑通。
 * P2 范围：F7（周数热更新 + 切换通知）、F8（联网检索 MCP）、F9（ai_dependency 指标）。
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { expect } from "chai"
import { after, beforeEach } from "mocha"
import { parseMcpArgs } from "@/core/teaching/mcp/args"
import { buildWebSearchError, parseWebSearchResults } from "@/core/teaching/mcp-web/webSearchPayload"
import { readWeekState, WEEK_STATE_FILE_NAME, writeWeekState } from "@/core/teaching/weekStateFile"
import { nextWeekSwitch } from "@/core/teaching/weekSwitchNotice"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { getRulePolicy } from "../rulePolicy"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import { ev } from "./__fixtures__/events"

// 【测试卫生】同 priorityGate.p0：阻断态是进程级全局静态（v2.7 防「退出/新建对话」绕过），
// 进来存快照、每例前归零、跑完还原，避免同进程内后续 spec 继承"阻断冷却中"状态。
const managerStaticState = TeachingInterventionManager as unknown as {
	globalBlockingEndsAt: number
	globalLastBlockingIntervention: unknown
}
const savedBlockingEndsAt = managerStaticState.globalBlockingEndsAt
const savedLastBlockingIntervention = managerStaticState.globalLastBlockingIntervention

describe("G2 · 优先级综合（可跑通 + 边界）", () => {
	beforeEach(() => {
		managerStaticState.globalBlockingEndsAt = 0
		managerStaticState.globalLastBlockingIntervention = null
	})

	// ---------------- 统一模板（6 例，照抄 priorityGate.p0.test.ts 的对应 6 个 it，仅改 describe 名）----------------
	// 例 ① 核心流程端到端 / ② 阈值边界 / ③ rulePolicy 门控 / ④ 冷却只挡提示 / ⑤ 队列清空后阻断仍生效 / ⑥ enabled=false

	it("★ 核心流程端到端：违规 → 计数 → 升级 → 阻断文本 → 阻断态生效", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(ev({}))
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		const text = mgr.checkAndGenerateIntervention(m, 3)
		expect(text).to.be.a("string").and.to.include("阻断模式")
		expect(mgr.isBlockingActive()).to.equal(true)
	})

	it("★ 边界：阈值前一轮不阻断、恰好阈值阻断", () => {
		const m2 = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m2.ingest(ev({}))
		m2.ingest(ev({}))
		expect(m2.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
		m2.ingest(ev({}))
		expect(m2.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(true)
	})

	it("★ 边界：概念问答下规则被门控停用（rulePolicy）", () => {
		expect(getRulePolicy("consecutive_code_generation", "algorithm").enabled).to.equal(false)
		expect(getRulePolicy("consecutive_code_generation", "code_generation").enabled).to.equal(true)
	})

	it("★ 边界：冷却不影响计数、只影响提示条数", () => {
		const m3 = new BehaviorMonitor("t1", { cooldownMs: 120_000, escalationBlockingThreshold: 3 })
		m3.ingest(ev({}))
		m3.ingest(ev({}))
		m3.ingest(ev({}))
		expect(m3.getEscalationCount("consecutive_code_generation")).to.equal(3)
		expect(m3.getPendingAlerts().length).to.equal(1)
	})

	it("★ 兜底路径：警报队列被清空后，阻断仍生效且文本非空（阻断不依赖 pendingAlerts）", () => {
		const m4 = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m4.ingest(ev({}))
		m4.ingest(ev({}))
		m4.ingest(ev({}))
		// 必须先消费掉队列，否则这条用例只是例 ① 的重复：命中阈值时阻断分支在
		// `hasPendingAlerts()` 之前就已 return，队列里有没有警报都看不出来。
		m4.consumePendingAlerts()
		expect(m4.hasPendingAlerts()).to.equal(false)
		const mgr4 = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		expect(mgr4.checkAndGenerateIntervention(m4, 3)).to.be.a("string").and.to.not.be.empty
	})

	it("★ 关掉特性开关后行为回到旧口径（enabled=false）", () => {
		const m5 = new BehaviorMonitor("t1", { enabled: false, cooldownMs: 0, escalationBlockingThreshold: 3 })
		m5.ingest(ev({}))
		m5.ingest(ev({}))
		m5.ingest(ev({}))
		expect(m5.getPendingAlerts()).to.have.length(0)
		expect(m5.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
	})

	// ---------------- P2 专项断言 ①–④ ----------------

	it("【G2-①】周数热读：文件改动立即生效，无需重启（纯 fs 契约 + 结构守卫）", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "p2-weekstate-"))
		const file = path.join(dir, WEEK_STATE_FILE_NAME)
		try {
			expect(await writeWeekState(file, 3)).to.equal(true)
			expect(await readWeekState(file)).to.equal(3)
			// 改文件即生效（模拟"改周数不重启 MCP 进程"）
			expect(await writeWeekState(file, 18)).to.equal(true)
			expect(await readWeekState(file)).to.equal(18)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}

		// 结构守卫：MCP 侧必须在**每次工具调用前**热读（不是启动时读一次）。
		// ⚠️ 这不是端到端验证（mcp-wiki-server 是 stdio 入口，import 它会真的启动 server）。
		const src = await fs.readFile(path.join(__dirname, "..", "..", "..", "teaching", "mcp-wiki-server.ts"), "utf-8")
		expect(src).to.include("async function effectiveWeek()")
		expect(src).to.include("await readWeekState(weekFile)")
		expect(src).to.include("await effectiveWeek()")
	})

	it("【G2-②】周数切换通知：变更时注入一次，同周不重复，首次不注入", () => {
		// 首次（无上次记录）只记录、不通知
		expect(nextWeekSwitch(undefined, 5)).to.deep.equal({ notice: null, lastWeek: 5 })
		// 同周不重复
		expect(nextWeekSwitch(5, 5).notice).to.equal(null)
		// 变更 → 通知且含新旧周次
		const r = nextWeekSwitch(1, 18)
		expect(r.notice).to.be.a("string")
		expect(r.notice).to.include("第 1 周")
		expect(r.notice).to.include("第 18 周")
		expect(r.lastWeek).to.equal(18)
		// 再来一次仍是"只通知一次"（状态被正确推进）
		expect(nextWeekSwitch(r.lastWeek, 18).notice).to.equal(null)
	})

	it("【G2-③】--week / --server 缺省仍可用（向后兼容）", () => {
		const bare = parseMcpArgs(["--server", "http://h:4001"])
		expect(bare.week).to.equal(1) // clampWeek 兜底
		expect(bare.serverUrl).to.equal("http://h:4001")
		expect(bare.weekFile).to.equal(undefined)
		// 带 --week-file 且不影响既有参数
		const full = parseMcpArgs(["--week", "9", "--server", "http://h:4001/", "--week-file", "C:/a/b.json"])
		expect(full.week).to.equal(9)
		expect(full.serverUrl).to.equal("http://h:4001") // 去尾斜杠
		expect(full.weekFile).to.equal("C:/a/b.json")
	})

	it("【G2-④】概念问答下 AI 依赖规则零提示（M2'/M3' 的通过条件）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "explanation" }))
		for (let i = 0; i < 8; i++) m.ingest(ev({ role: "assistant" }))
		expect(m.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("high_recent_ai_dependency")
		expect(getRulePolicy("high_recent_ai_dependency", "algorithm").enabled).to.equal(false)

		// 非概念任务下仍然可用（计数可达 + 阈值边界：连续 5 个助手回合不触发、第 6 个触发）
		// ⚠️ 已登记的残留：Cline 单次提问即产生 6+ 连续助手回合 ⇒ 该形态下仍会提示（见账本 §18.2）。
		const m2 = new BehaviorMonitor("t2", { cooldownMs: 0 })
		for (let i = 0; i < 5; i++) m2.ingest(ev({ taskId: "t2", role: "assistant" }))
		expect(m2.getEscalationCount("high_recent_ai_dependency")).to.equal(0)
		m2.ingest(ev({ taskId: "t2", role: "assistant" }))
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

	after(() => {
		managerStaticState.globalBlockingEndsAt = savedBlockingEndsAt
		managerStaticState.globalLastBlockingIntervention = savedLastBlockingIntervention
	})
})
