/**
 * G1 · P1 优先级综合测试（L2 层）
 *
 * 覆盖 plan-2 §0 要求的四类检查：正常路径 / 边界条件 / 回归 / 核心流程可跑通。
 * 对应 plan-2 §4 的「统一模板」6 例 + G1 专项断言 ①–⑤。
 * P1 范围：F4（全周索引 + 三档应答）、F5（分类粘性 + 词边界）、F6（干预不进对话历史）。
 */
import { expect } from "chai"
import * as fs from "fs"
import { after, beforeEach } from "mocha"
import * as path from "path"
import { LLMWikiService } from "@/core/teaching/LLMWikiService"
import { buildWikiSystemPrompt } from "@/core/teaching/wikiPrompt"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { appendEphemeralIntervention } from "../ephemeralIntervention"
import { getRulePolicy } from "../rulePolicy"
import { TaskClassifier } from "../TaskClassifier"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import { ev } from "./__fixtures__/events"

// 【测试卫生】同 priorityGate.p0.test.ts：阻断态是进程级全局静态，进来先存快照、每例前归零、跑完还原。
const managerStaticState = TeachingInterventionManager as unknown as {
	globalBlockingEndsAt: number
	globalLastBlockingIntervention: unknown
}
const savedBlockingEndsAt = managerStaticState.globalBlockingEndsAt
const savedLastBlockingIntervention = managerStaticState.globalLastBlockingIntervention

describe("G1 · 优先级综合（可跑通 + 边界）", () => {
	beforeEach(() => {
		managerStaticState.globalBlockingEndsAt = 0
		managerStaticState.globalLastBlockingIntervention = null
	})

	// ---------------- 统一模板（6 例） ----------------
	// 与 G0 同形，仅改 describe 名；用于守护「每个优先级都从端到端可跑通」这一不变量。

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

	it("★ 兜底路径：警报队列被清空后，阻断仍生效且文本非空", () => {
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

	// ---------------- G1 专项断言 ①–⑤ ----------------

	it("【G1-①】buildIndexGroups() 放行全部周次（含 > 当前周）", () => {
		const svc = LLMWikiService.getInstance()
		type Internals = { _wikiCache: Map<string, unknown[]>; _textbookChapters: unknown[]; _currentWeek: number }
		const internals = svc as unknown as Internals
		const prev = { w: internals._wikiCache, t: internals._textbookChapters, c: internals._currentWeek }
		try {
			internals._wikiCache = new Map([
				["a", [{ id: "a", title: "第1周标题", applicable_week: 1, content: "x" }]],
				["b", [{ id: "b", title: "第18周标题", applicable_week: 18, content: "y" }]],
			])
			internals._textbookChapters = []
			internals._currentWeek = 1
			const groups = svc.buildIndexGroups()
			expect(groups.map((g) => g.week)).to.deep.equal([1, 18])
			expect(groups[1].titles).to.deep.equal(["第18周标题"])
		} finally {
			internals._wikiCache = prev.w
			internals._textbookChapters = prev.t
			internals._currentWeek = prev.c
		}
	})

	it("【G1-②】buildWikiSystemPrompt 命中 A/B/C 三档策略", () => {
		const s = buildWikiSystemPrompt({
			week: 5,
			index: [{ week: 5, titles: ["装饰器"] }],
			mcpAvailable: true,
		})
		const tierA = s.includes("【A 在进度内】")
		const tierB = s.includes("【B 超纲、无资料】")
		const tierC = s.includes("【C 超纲、可联网】")
		expect({ tierA, tierB, tierC }).to.deep.equal({ tierA: true, tierB: true, tierC: true })
		expect(s).to.include("不要一律拒答")
		expect(s).to.not.include("不要展开讲解其具体用法")
	})

	it("【G1-③】分类粘性：弱信号短消息不得覆盖已确立的 code_generation", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "code_generation" }))
		expect(m.getTaskCategory()).to.equal("code_generation")
		// 「再实现一个快速排序」这类短消息会被判成 algorithm —— 不得覆盖
		m.ingest(ev({ role: "user", category: "algorithm" }))
		expect(m.getTaskCategory()).to.equal("code_generation")
		m.ingest(ev({ role: "user", category: "explanation" }))
		expect(m.getTaskCategory()).to.equal("code_generation")
		// 强信号可覆盖（学生开始处理已有代码）
		m.ingest(ev({ role: "user", category: "debugging" }))
		expect(m.getTaskCategory()).to.equal("debugging")
	})

	it("【G1-④】干预只进本轮 system prompt，不得进入对话内容数组", () => {
		// ⚠️ 这是**结构契约断言 + 纯函数断言**的组合，不是端到端验证。
		//    「apiConversationHistory 中不出现 <teaching_intervention」的真正验证
		//    需要真实 Task + 一次真实请求，留给人工验收 M9'。
		const text = '<teaching_intervention rule="no_edit_streak" severity="gentle">x</teaching_intervention>'
		const injected = appendEphemeralIntervention("BASE_PROMPT", text)
		expect(injected.applied).to.equal(true)
		expect(injected.systemPrompt).to.include(text) // 本轮模型看得到
		// 且它不改变任何"内容数组"：函数只返回字符串，没有数组入参
		expect(injected.systemPrompt.startsWith("BASE_PROMPT")).to.equal(true)

		// 源码结构守卫（index.ts 是请求组装点）
		const indexSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")
		expect(indexSrc).to.include("appendEphemeralIntervention(systemPromptFinal, this.pendingInterventionText)") // 已接线到 system prompt
		expect(indexSrc).to.include("this.pendingInterventionText = interventionText") // 干预文本的来源
		// 关键否定断言：不得把 interventionText 当作某个 push() 的 text 值（那会被持久化进历史）
		const pushedAsContent = /text:\s*interventionText\b/.test(indexSrc)
		expect(pushedAsContent).to.equal(false)
	})

	it("【G1-⑤】countMatches 词边界：CJK 短语仍按 includes 命中", () => {
		const cls = new TaskClassifier()
		expect(cls.classify("排序与实现")).to.equal("algorithm") // "排序"(algorithm,10) 压过 "实现"(code_generation,7)
		// 词边界的副作用不得误伤正常命中
		expect(cls.classify("go 的 goroutine 怎么用")).to.equal("language_request")
		expect(cls.classify("c++")).to.equal("language_request")
		// 且不得再被子串误命中
		expect(cls.classify("algorithm")).to.equal("other")
		expect(cls.classify("这段 json 怎么解析")).to.equal("other")
	})

	after(() => {
		managerStaticState.globalBlockingEndsAt = savedBlockingEndsAt
		managerStaticState.globalLastBlockingIntervention = savedLastBlockingIntervention
	})
})
