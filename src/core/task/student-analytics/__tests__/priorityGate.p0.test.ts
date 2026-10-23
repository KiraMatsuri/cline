/**
 * G0 · P0 优先级综合测试（L2 层）
 *
 * 覆盖 plan-2 §0 要求的四类检查：正常路径 / 边界条件 / 回归 / 核心流程可跑通。
 * 对应 plan-2 §4 的「统一模板」6 例 + G0 专项断言 ①–⑦。
 *
 * 【P2-2】阻断式干预已删除：所有规则（含独立通道 `ai_coding_rounds`）都只产生软提示，
 * 计数阈值恒为常量 3（不可注入、不存在「阻断阈值 / 阻断态」这类可观察接口）。
 *
 * 链路：BehaviorMonitor（决策：ruleId / 计数）→ TeachingInterventionManager（冷却 / 限额 / 软提示文本）。
 */
import { expect } from "chai"
import { BehaviorMonitor, DEFAULT_OPTIONS } from "../BehaviorMonitor"
import { getRulePolicy } from "../rulePolicy"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import { editEv, ev } from "./__fixtures__/events"

const ruleIds = (m: BehaviorMonitor): string[] => m.getPendingAlerts().map((a) => a.ruleId)

/** 运行时守卫：已删除的阻断能力不得在实例上复活 */
const runtimeProp = (obj: object, key: string): unknown => (obj as unknown as Record<string, unknown>)[key]

describe("G0 · 优先级综合（可跑通 + 边界）", () => {
	// ---------------- 统一模板（6 例） ----------------

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
		expect(runtimeProp(mgr, "getBlockingEndsAt")).to.equal(undefined)
	})

	it("★ 边界：阈值前 2 次只计数、第 3 次计数达 3 并产生软提示（独立通道 ai_coding_rounds）", () => {
		const m2 = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 2; i++) {
			m2.ingest(
				ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: `第 ${i} 次` }),
			)
			m2.ingest(editEv({ editor: "ai" }))
		}
		expect(m2.getAiCodingCount()).to.equal(2)
		m2.ingest(ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: "第 3 次" }))
		m2.ingest(editEv({ editor: "ai" }))
		expect(m2.getAiCodingCount()).to.equal(3)
		// 第 3 次仍只入队软提示，不存在“阻断阈值”这一类状态
		expect(ruleIds(m2)).to.include("ai_coding_rounds")
		expect(runtimeProp(m2, "shouldEscalateToBlocking")).to.equal(undefined)
	})

	it("★【P2-2】代码规则只提示：计数照旧、不产生阻断", () => {
		const mCode = new BehaviorMonitor("t1", { cooldownMs: 0 })
		mCode.ingest(ev({}))
		mCode.ingest(ev({}))
		mCode.ingest(ev({}))
		expect(mCode.getEscalationCount("consecutive_code_generation")).to.equal(3)
		expect(ruleIds(mCode)).to.include("consecutive_code_generation")
		expect(runtimeProp(mCode, "shouldEscalateToBlocking")).to.equal(undefined)
	})

	it("★ 边界：概念问答下规则被门控停用（rulePolicy）", () => {
		expect(getRulePolicy("consecutive_code_generation", "algorithm").enabled).to.equal(false)
		expect(getRulePolicy("consecutive_code_generation", "code_generation").enabled).to.equal(true)
	})

	it("★ 边界：冷却不影响计数、只影响提示条数", () => {
		const m3 = new BehaviorMonitor("t1", { cooldownMs: 120_000 })
		m3.ingest(ev({}))
		m3.ingest(ev({}))
		m3.ingest(ev({}))
		expect(m3.getEscalationCount("consecutive_code_generation")).to.equal(3)
		// 【P5-A】阈值 8→3 后同一串事件也会命中 no_edit_streak；按 ruleId 精确断言本规则的提醒条数
		expect(m3.getPendingAlerts().filter((a) => a.ruleId === "consecutive_code_generation").length).to.equal(1)
	})

	it("★ 决策依赖警报队列：队列被消费后不再产出干预文本（返回 null）", () => {
		const m4 = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m4.ingest(
				ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: `第 ${i} 次` }),
			)
			m4.ingest(editEv({ editor: "ai" }))
		}
		m4.consumePendingAlerts()
		expect(m4.hasPendingAlerts()).to.equal(false)
		const mgr4 = new TeachingInterventionManager("t1")
		expect(mgr4.checkAndGenerateIntervention(m4, 3)).to.equal(null)
	})

	it("★ 边界：有警报但队列被消费 ⇒ 不注入（返回 null，不得凭空产出文本）", () => {
		const m6 = new BehaviorMonitor("t1", { cooldownMs: 0 })
		// 【P5-A】单位改为「学生请求」且阈值 8→3：3 个纯文字回合（退化口径下按回合计数）
		// ⇒ no_edit_streak 恰好记 1 次，只产生软提示。
		for (let i = 0; i < 3; i++) {
			m6.ingest(ev({ hasCodeBlock: false }))
		}
		expect(m6.getEscalationCount("no_edit_streak")).to.equal(1)
		expect(m6.hasPendingAlerts()).to.equal(true)
		m6.consumePendingAlerts()
		expect(m6.hasPendingAlerts()).to.equal(false)
		const mgr6 = new TeachingInterventionManager("t1")
		expect(mgr6.checkAndGenerateIntervention(m6, 3)).to.equal(null)
	})

	it("★ 关掉特性开关后行为回到旧口径（enabled=false）", () => {
		const m5 = new BehaviorMonitor("t1", { enabled: false, cooldownMs: 0 })
		m5.ingest(ev({}))
		m5.ingest(ev({}))
		m5.ingest(ev({}))
		expect(m5.getPendingAlerts()).to.have.length(0)
	})

	// ---------------- G0 专项断言 ①–⑦ ----------------

	it("【G0-①】阻断阈值已从默认配置与接口中删除（计数阈值恒为常量 3）", () => {
		expect("escalationBlockingThreshold" in DEFAULT_OPTIONS).to.equal(false)
		expect(runtimeProp(new BehaviorMonitor("t1"), "getEscalationBlockingThreshold")).to.equal(undefined)
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

	it("【G0-⑥】决策后不产生任何阻断状态（P2-2 已删能力）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m.ingest(
				ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: `第 ${i} 次` }),
			)
			m.ingest(editEv({ editor: "ai" }))
		}
		const mgr = new TeachingInterventionManager("t1")
		mgr.checkAndGenerateIntervention(m, 3)
		expect(runtimeProp(mgr, "isBlockingActive")).to.equal(undefined)
		expect(runtimeProp(mgr, "getBlockingEndsAt")).to.equal(undefined)
		expect(runtimeProp(mgr, "getGlobalBlockingState")).to.equal(undefined)
	})

	it("【G0-⑦】high_adoption_low_self_modification 逐轮计数并出提醒（只提示，不阻断）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
		for (let i = 0; i < 3; i++) {
			m.ingest(ev({ role: "assistant", hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getEscalationCount("high_adoption_low_self_modification")).to.equal(3)
		// 计数与提醒保留（可审计、可提示），阻断能力已删除
		expect(ruleIds(m)).to.include("high_adoption_low_self_modification")
	})
})
