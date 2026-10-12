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

	it("★ 兜底路径：即使无新警报，干预文本仍非空", () => {
		const m4 = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m4.ingest(ev({}))
		m4.ingest(ev({}))
		m4.ingest(ev({}))
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
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({}))
		m.ingest(ev({}))
		m.ingest(ev({}))
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		expect(mgr.isBlockingActive()).to.equal(false)
		mgr.checkAndGenerateIntervention(m, 3)
		expect(mgr.isBlockingActive()).to.equal(true)
		expect(mgr.getBlockingEndsAt()).to.be.greaterThan(Date.now())
	})

	it("【G0-⑦】high_adoption_low_self_modification 逐轮计数并可达阻断阈值（T9-b）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		for (let i = 0; i < 3; i++) {
			m.ingest(ev({ role: "assistant", hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getEscalationCount("high_adoption_low_self_modification")).to.equal(3)
		expect(m.shouldEscalateToBlocking("high_adoption_low_self_modification")).to.equal(true)
	})

	after(() => {
		managerStaticState.globalBlockingEndsAt = savedBlockingEndsAt
		managerStaticState.globalLastBlockingIntervention = savedLastBlockingIntervention
	})
})
