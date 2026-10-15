/**
 * G0 · P0 优先级综合测试（L2 层）
 *
 * 覆盖 plan-2 §0 要求的四类检查：正常路径 / 边界条件 / 回归 / 核心流程可跑通。
 * 对应 plan-2 §4 的「统一模板」6 例 + G0 专项断言 ①–⑦。
 *
 * 链路：BehaviorMonitor（决策：ruleId / 计数 / 升级）→ TeachingInterventionManager（冷却 / 限额 / 阻断）。
 */
import { expect } from "chai"
import { after, beforeEach } from "mocha"
import { BehaviorMonitor, DEFAULT_OPTIONS } from "../BehaviorMonitor"
import { getRulePolicy } from "../rulePolicy"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import { editEv, ev } from "./__fixtures__/events"

// 【测试卫生】阻断状态是**跨会话全局静态**（v2.7 防「退出/新建对话」绕过），生产代码刻意
// 不提供清除入口。本文件会真实触发阻断，若不在测试侧复位，同进程内后续 spec
// （requestIntentRefiner / rulePolicy）会继承"阻断冷却中"状态。故：进来时先存原值，
// 每个用例前复位，全部跑完后还原。
const managerStaticState = TeachingInterventionManager as unknown as {
	globalBlockingEndsAt: number
	globalLastBlockingIntervention: unknown
}
const savedBlockingEndsAt = managerStaticState.globalBlockingEndsAt
const savedLastBlockingIntervention = managerStaticState.globalLastBlockingIntervention

const ruleIds = (m: BehaviorMonitor): string[] => m.getPendingAlerts().map((a) => a.ruleId)

describe("G0 · 优先级综合（可跑通 + 边界）", () => {
	beforeEach(() => {
		managerStaticState.globalBlockingEndsAt = 0
		managerStaticState.globalLastBlockingIntervention = null
	})

	// ---------------- 统一模板（6 例） ----------------

	it("★ 核心流程端到端：AI 真实落盘 3 次 → 计数 → 升级 → 阻断文本 → 阻断态生效", () => {
		// 【P6/T6】阻断的唯一入口是独立通道 `ai_coding_rounds`（旧写法走的 consecutive_code_generation 已不可阻断）
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m.ingest(
				ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: `第 ${i} 次` }),
			)
			m.ingest(editEv({ editor: "ai" }))
		}
		expect(m.getAiCodingCount()).to.equal(3)
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		const text = mgr.checkAndGenerateIntervention(m, 3)
		expect(text).to.be.a("string").and.to.include("阻断模式")
		expect(mgr.isBlockingActive()).to.equal(true)
	})

	it("★ 边界：阈值前一次不阻断、恰好阈值阻断（独立通道 ai_coding_rounds）", () => {
		const m2 = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 2; i++) {
			m2.ingest(
				ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: `第 ${i} 次` }),
			)
			m2.ingest(editEv({ editor: "ai" }))
		}
		expect(m2.getAiCodingCount()).to.equal(2)
		expect(m2.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(false)
		m2.ingest(ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: "第 3 次" }))
		m2.ingest(editEv({ editor: "ai" }))
		expect(m2.getAiCodingCount()).to.equal(3)
		expect(m2.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(true)
	})

	it("★【P6/T6】原可升级的代码规则改为只提示：计数照旧、阻断恒 false", () => {
		const mCode = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		mCode.ingest(ev({}))
		mCode.ingest(ev({}))
		expect(mCode.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
		mCode.ingest(ev({}))
		expect(mCode.getEscalationCount("consecutive_code_generation")).to.equal(3)
		expect(mCode.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
		expect(ruleIds(mCode)).to.include("consecutive_code_generation")
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
		// 【P5-A】阈值 8→3 后同一串事件也会命中 no_edit_streak；按 ruleId 精确断言本规则的提醒条数
		expect(m3.getPendingAlerts().filter((a) => a.ruleId === "consecutive_code_generation").length).to.equal(1)
	})

	it("★ 兜底路径：警报队列被清空后，阻断仍生效且文本非空（阻断不依赖 pendingAlerts）", () => {
		const m4 = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m4.ingest(
				ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: `第 ${i} 次` }),
			)
			m4.ingest(editEv({ editor: "ai" }))
		}
		// 必须先消费掉队列，否则这条用例只是例 ① 的重复：命中阈值时阻断分支在
		// `hasPendingAlerts()` 之前就已 return，队列里有没有警报都看不出来。
		m4.consumePendingAlerts()
		expect(m4.hasPendingAlerts()).to.equal(false)
		const mgr4 = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		expect(mgr4.checkAndGenerateIntervention(m4, 3)).to.be.a("string").and.to.not.be.empty
	})

	it("★ 边界：有警报但未达升级阈值，且队列被消费后 ⇒ 不注入（返回 null，不得凭空产出文本）", () => {
		// （原为规避 `high_recent_ai_dependency` 的误阻断而抬到 4，2026-10-13 回归修复后改回 3）
		// 那 8 个纯文字助手回合会把 ai_dependency 推到 3，但该规则现已被 rulePolicy 标为**永不可升级**，
		// 故阈值 3 不再造成误阻断，本用例仍是「有警报（no_edit_streak=1）但未达阈值」。
		const m6 = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		// 【P5-A】单位改为「学生请求」且阈值 8→3：3 个纯文字回合（退化口径下按回合计数）
		// ⇒ no_edit_streak 恰好记 1 次（< 3，不阻断）；旧注释里的"8 轮"已废弃。
		for (let i = 0; i < 3; i++) {
			m6.ingest(ev({ hasCodeBlock: false }))
		}
		expect(m6.getEscalationCount("no_edit_streak")).to.equal(1)
		expect(m6.hasPendingAlerts()).to.equal(true)
		m6.consumePendingAlerts()
		expect(m6.hasPendingAlerts()).to.equal(false)
		const mgr6 = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		expect(mgr6.checkAndGenerateIntervention(m6, 3)).to.equal(null)
	})

	it("★ 关掉特性开关后行为回到旧口径（enabled=false）", () => {
		const m5 = new BehaviorMonitor("t1", { enabled: false, cooldownMs: 0, escalationBlockingThreshold: 3 })
		m5.ingest(ev({}))
		m5.ingest(ev({}))
		m5.ingest(ev({}))
		expect(m5.getPendingAlerts()).to.have.length(0)
		expect(m5.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
	})

	// ---------------- G0 专项断言 ①–⑦ ----------------

	it("【G0-①】升级阻断阈值恰为 3（权威值在 DEFAULT_OPTIONS）", () => {
		expect(DEFAULT_OPTIONS.escalationBlockingThreshold).to.equal(3)
		expect(new BehaviorMonitor("t1").getEscalationBlockingThreshold()).to.equal(3)
	})

	it("【G0-②】AI 落盘（editor: ai）不清零 streak ⇒ consecutive_code_generation 仍可达", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(editEv({ editor: "ai" })) // AI 写盘：既不清零也不计数
		m.ingest(ev({})) // 第 3 个含 fenced 代码块的助手回合
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(3)
		expect(ruleIds(m)).to.include("consecutive_code_generation")
	})

	it("【G0-③】学生本人编辑清零 streak ⇒ consecutive_code_generation 不再触发", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(editEv({ editor: "user" }))
		m.ingest(ev({}))
		// ① 升级计数**单调**：学生编辑只清零 streak（`assistantCodeStreak`），不清零
		//    `escalationCounter` —— 这就是 spec §9.6-B 登记的已知残留（"清零"形式本次不实施）。
		//    因此这里仍是 3 个助手代码回合 = 3（与 G0-② 同口径）。
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(3)
		// ② 但 streak 确实被清零 ⇒ 规则不再发提醒（这才是「编辑生效」的可观察后果）
		expect(ruleIds(m)).to.not.include("consecutive_code_generation")
	})

	it("【G0-④】概念模式下连索 5 次完整代码，护栏仍 active 且计数为 5", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "algorithm" }))
		for (let i = 0; i < 5; i++) {
			m.ingest(ev({ role: "user", category: "code_generation" }))
		}
		const st = m.getConceptModeState()
		expect(st.active).to.equal(true)
		expect(st.completeImplDemands).to.equal(5)
	})

	it("【G0-⑤】学生本人编辑后概念护栏解除", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "explanation" }))
		expect(m.getConceptModeState().active).to.equal(true)
		m.ingest(editEv({ editor: "user" }))
		expect(m.getConceptModeState().active).to.equal(false)
	})

	it("【G0-⑥】阻断态可被外部观察到（isBlockingActive / getBlockingEndsAt）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m.ingest(
				ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: `第 ${i} 次` }),
			)
			m.ingest(editEv({ editor: "ai" }))
		}
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		expect(mgr.isBlockingActive()).to.equal(false)
		mgr.checkAndGenerateIntervention(m, 3)
		expect(mgr.isBlockingActive()).to.equal(true)
		expect(mgr.getBlockingEndsAt()).to.be.greaterThan(Date.now())
	})

	it("【G0-⑦】high_adoption_low_self_modification 逐轮计数并出提醒，但已不再可阻断（T9-b + P6/T6）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		for (let i = 0; i < 3; i++) {
			m.ingest(ev({ role: "assistant", hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getEscalationCount("high_adoption_low_self_modification")).to.equal(3)
		// 【P6/T6】计数与提醒保留（可审计），但阻断的唯一入口已收归独立通道 ai_coding_rounds
		expect(ruleIds(m)).to.include("high_adoption_low_self_modification")
		expect(m.shouldEscalateToBlocking("high_adoption_low_self_modification")).to.equal(false)
		expect(m.getRuleIdsAtBlockingThreshold()).to.deep.equal([])
	})

	after(() => {
		managerStaticState.globalBlockingEndsAt = savedBlockingEndsAt
		managerStaticState.globalLastBlockingIntervention = savedLastBlockingIntervention
	})
})
