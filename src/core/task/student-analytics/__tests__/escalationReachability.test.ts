import { expect } from "chai"
import { after } from "mocha"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import { editEv, ev } from "./__fixtures__/events"

// 【P6/T6】阻断的唯一入口 = 独立通道 `ai_coding_rounds`（助手真实落盘，阈值 3，学生本人编辑清零）。
/** 一次「学生请求 + 助手落盘」的组合 —— 即独立通道推进 1 格 */
const aiWriteRound = (m: BehaviorMonitor, i: number): void => {
	m.ingest(
		ev({
			eventType: "turn_message",
			role: "user",
			hasCode: false,
			hasCodeBlock: false,
			rawContent: `第 ${i} 次请你直接写`,
		}),
	)
	m.ingest(editEv({ editor: "ai" }))
}

// 【测试卫生】TeachingInterventionManager 的阻断状态是**跨会话全局静态**（v2.7 防
// 「退出/新建对话」绕过），本文件的阻断用例必然写它；而 .mocharc.json 把全部 spec 放在
// **同一个进程**里按字母序加载（escalationReachability < interventionRegression），
// 不清理就会使 interventionRegression 的「场景 3」先读到「阻断冷却中」提醒而非首次阻断文案。
// 该静态状态在生产代码里刻意没有公开清除入口（实例 reset() 也不清它，否则学生新建对话即可绕过），
// 所以只在测试侧复位，避免污染同进程的其它测试文件。
const managerStaticState = TeachingInterventionManager as unknown as {
	globalBlockingEndsAt: number
	globalLastBlockingIntervention: unknown
}

describe("F1 · 升级阈值可达性", () => {
	it("★ 阈值恰为 3：第 2 次不升级，第 3 次升级（边界）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, aiCodingBlockingThreshold: 3 })
		aiWriteRound(m, 1)
		aiWriteRound(m, 2)
		expect(m.getAiCodingCount()).to.equal(2)
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(false)
		aiWriteRound(m, 3)
		expect(m.getAiCodingCount()).to.equal(3)
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(true)
	})

	it("★【P6/T6】原可升级的代码规则现只提示：计数照旧、阻断恒 false（阻断入口已收归独立通道）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		expect(m.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
		m.ingest(ev({}))
		// 计数仍在（可审计），且提醒照发
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(3)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
		expect(m.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
		expect(m.getRuleIdsAtBlockingThreshold()).to.deep.equal([])
	})

	it("★ 计数与提醒冷却解耦：冷却期内仍逐轮计数", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 120_000, escalationBlockingThreshold: 3 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(ev({}))
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(3)
		// 【P5-A】阈值 8→3 后，同一串事件会连带命中 no_edit_streak ⇒ 按 ruleId 精确断言
		// （本用例关心的是"同一规则在冷却期内仍逐轮计数"，不是"全局只有一条提醒"）
		expect(m.getPendingAlerts().filter((a) => a.ruleId === "consecutive_code_generation").length).to.equal(1)
	})

	it("非 turn_message 事件不计数", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(ev({ eventType: "adoption_infer" }))
		m.ingest(ev({ eventType: "file_save" }))
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(2)
	})

	it("turn_message 但非「助手 + fenced 代码块」的回合不计数（违规单位 = 推进 streak 的回合）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({}))
		m.ingest(ev({ role: "user" })) // 学生提问：不推进 assistantCodeStreak
		m.ingest(ev({ hasCode: false, hasCodeBlock: false })) // 助手纯文字回合：同样不推进
		m.ingest(ev({ eventType: "code_edit", editor: "ai" })) // AI 落盘：不计
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(1)
	})

	it("★ 阻断不依赖 pendingAlerts（队列被清空后仍能阻断）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		aiWriteRound(m, 1)
		aiWriteRound(m, 2)
		aiWriteRound(m, 3)
		m.consumePendingAlerts() // 模拟"本轮无新警报"
		expect(m.hasPendingAlerts()).to.equal(false)
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		const text = mgr.checkAndGenerateIntervention(m, 1)
		expect(text).to.be.a("string").and.to.include("阻断模式")
		expect(mgr.isBlockingActive()).to.equal(true)
	})

	it("概念问答下代码类规则被分流停用（不计数），且 high_recent_ai_dependency 不可阻断", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "algorithm" }))
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(ev({}))
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(0) // 规则被停用 → 不计数
		// 【P6/T6】依赖度规则仍启用（只提示），但白名单之外一律不可升级为阻断
		expect(m.shouldEscalateToBlocking("high_recent_ai_dependency")).to.equal(false)
	})

	it("★ 阈值下界 1：首个命中回合即升级", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, aiCodingBlockingThreshold: 1 })
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(false)
		aiWriteRound(m, 1)
		expect(m.getAiCodingCount()).to.equal(1)
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(true)
	})

	it("★ reset() 后计数归零且不再满足升级条件", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		aiWriteRound(m, 1)
		aiWriteRound(m, 2)
		aiWriteRound(m, 3)
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(true)

		m.reset()

		expect(m.getEscalationCount("ai_coding_rounds")).to.equal(0)
		expect(m.getRuleIdsAtBlockingThreshold()).to.deep.equal([])
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(false)
		expect(m.getPendingAlerts().length).to.equal(0)
	})

	it("★ 学生持续动手时，no_edit_streak 不得累积升级（否则会被误阻断）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		// 5 个回合，每个回合之间都有"学生本人"的代码编辑 → turnsSinceLastEdit 始终 < 8
		for (let i = 0; i < 5; i++) {
			m.ingest(ev({ eventType: "turn_message", role: "user", category: "code_generation" }))
			m.ingest(ev({ eventType: "code_edit", editor: "user" }))
		}
		expect(m.getEscalationCount("no_edit_streak")).to.equal(0)
		expect(m.shouldEscalateToBlocking("no_edit_streak")).to.equal(false)
	})

	it("★ 真正连续 8 轮未编辑后，no_edit_streak 才逐轮累积", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3, noEditTurnStreakThreshold: 8 })
		for (let i = 0; i < 8; i++) {
			m.ingest(ev({ eventType: "turn_message", role: "assistant" }))
		}
		expect(m.getEscalationCount("no_edit_streak")).to.equal(1) // 第 8 轮才首次命中
		m.ingest(ev({ eventType: "turn_message", role: "assistant" }))
		m.ingest(ev({ eventType: "turn_message", role: "assistant" }))
		expect(m.getEscalationCount("no_edit_streak")).to.equal(3)
		// 【P6/T6】计数保留，但该规则不再是阻断入口
		expect(m.shouldEscalateToBlocking("no_edit_streak")).to.equal(false)
	})

	// ---- 【T9-b / 裁定 C】high_adoption_low_self_modification 的升级能力回归 ----
	// notify() 移出自增后，该规则若不在 check*Rule() 内计数，计数将**恒为 0**：
	// 命中只产生提醒，永远升不了级 —— 这是 F1 引入的静默能力回退。

	it("★【T9-b / P6/T6】采纳率高 + 自主修改少时逐轮计数（可审计），但不可再升级为阻断", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		// 2 次"已采纳"判定（达到 minAdoptionSamples=2，采纳率 100%）
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		// 3 个助手代码回合，期间学生 0 次自主编辑 → 自主修改率 0 ≤ 0.25
		for (let i = 0; i < 3; i++) {
			m.ingest(ev({ role: "assistant", hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getEscalationCount("high_adoption_low_self_modification")).to.equal(3)
		expect(m.shouldEscalateToBlocking("high_adoption_low_self_modification")).to.equal(false)
	})

	it("【T9-b】自主修改率达标时不计数（规则条件不成立）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		// 先编辑再出代码：自主修改率 = 1/1 = 100% > 25%
		m.ingest(ev({ eventType: "code_edit", editor: "user" }))
		m.ingest(ev({ role: "assistant", hasCode: true, hasCodeBlock: true }))
		expect(m.getEscalationCount("high_adoption_low_self_modification")).to.equal(0)
	})

	it("【T9-b】采纳样本不足（< minAdoptionSamples=2）时不计数（边界）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		for (let i = 0; i < 3; i++) {
			m.ingest(ev({ role: "assistant", hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getEscalationCount("high_adoption_low_self_modification")).to.equal(0)
	})

	it("【T9-b】违规单位 = 助手代码回合：学生回合不计数", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		m.ingest(ev({ role: "assistant", hasCode: true, hasCodeBlock: true }))
		expect(m.getEscalationCount("high_adoption_low_self_modification")).to.equal(1)
		m.ingest(ev({ role: "user", category: "code_generation" }))
		m.ingest(ev({ role: "user", category: "code_generation" }))
		expect(m.getEscalationCount("high_adoption_low_self_modification")).to.equal(1)
	})

	// 必须挂在 describe 内部：顶层的 after() 属于**根套件**，要等到整个运行结束才执行，
	// 而这里需要在下一个 spec 文件（interventionRegression）加载前就把全局态复位。
	after(() => {
		managerStaticState.globalBlockingEndsAt = 0
		managerStaticState.globalLastBlockingIntervention = null
	})
})
