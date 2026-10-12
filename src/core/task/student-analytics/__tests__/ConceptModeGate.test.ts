import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { INITIAL_CONCEPT_MODE_STATE, nextConceptMode } from "../ConceptModeGate"
import { ev } from "./__fixtures__/events"

const s = (o: Partial<Parameters<typeof nextConceptMode>[1]>) => ({
	category: undefined,
	studentEdited: false,
	wantsCompleteImpl: false,
	...o,
})

describe("F3 · 概念模式粘性", () => {
	it("起始为概念类 → 进入", () => {
		expect(nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" })).active).to.equal(true)
	})
	it("起始为 code_generation → 不进入", () => {
		expect(nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "code_generation" })).active).to.equal(false)
	})
	it("category 缺失 → 不进入", () => {
		expect(nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: undefined })).active).to.equal(false)
	})
	it("★ 连续 5 次索要完整代码也不退出（旧行为会撤销护栏）", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		for (let i = 0; i < 5; i++) {
			st = nextConceptMode(st, s({ category: "code_generation", wantsCompleteImpl: true }))
			expect(st.active).to.equal(true)
		}
		expect(st.completeImplDemands).to.equal(5)
	})
	it("学生本人编辑代码 → 退出", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		st = nextConceptMode(st, s({ category: "algorithm", studentEdited: true }))
		expect(st.active).to.equal(false)
	})
	it("转为 debugging（在处理已有代码）→ 退出", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		st = nextConceptMode(st, s({ category: "debugging" }))
		expect(st.active).to.equal(false)
	})
	it("★ 退出后需新的概念信号才可重新进入（非概念提问不得复活）", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		st = nextConceptMode(st, s({ category: "debugging" }))
		expect(st.active).to.equal(false)
		// ① 非概念分类不得复活
		expect(nextConceptMode(st, s({ category: "other" })).active).to.equal(false)
		expect(nextConceptMode(st, s({ category: "code_generation", wantsCompleteImpl: true })).active).to.equal(false)
		// ② 学生再次提出概念问题 ⇒ 按"学生侧分类"口径重新进入
		expect(nextConceptMode(st, s({ category: "algorithm" })).active).to.equal(true)
	})
	it("completeImplDemands 只增不减", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		st = nextConceptMode(st, s({ category: "code_generation", wantsCompleteImpl: true }))
		st = nextConceptMode(st, s({ category: "algorithm" }))
		expect(st.completeImplDemands).to.equal(1)
	})
	it("★ 边界：状态为 active 时，无分类信号不得误退出", () => {
		const st = nextConceptMode(
			{ active: true, completeImplDemands: 0 },
			s({ category: undefined, studentEdited: false, wantsCompleteImpl: false }),
		)
		expect(st.active).to.equal(true)
	})
	it("★ 边界：assistant/adoption_infer 事件不得误退出（需 BehaviorMonitor 集成）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "algorithm" }))
		expect(m.getConceptModeState().active).to.equal(true)
		// adoption_infer 事件也带 category（真实日志里出现过 language_request）。
		// 若 BehaviorMonitor 在这里读分类，概念护栏会被助手侧事件错误撤销。
		m.ingest(ev({ eventType: "adoption_infer", category: "language_request" }))
		expect(m.getConceptModeState().active).to.equal(true)
	})

	it("★ reset() 后概念状态复位", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "algorithm" }))
		expect(m.getConceptModeState().active).to.equal(true)
		m.reset()
		expect(m.getConceptModeState().active).to.equal(false)
		expect(m.getConceptModeState().completeImplDemands).to.equal(0)
	})

	it("★ AI 落盘（editor: ai）不得退出概念模式，学生本人编辑才退出", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "explanation" }))
		m.ingest(ev({ eventType: "code_edit", editor: "ai" }))
		expect(m.getConceptModeState().active).to.equal(true)
		m.ingest(ev({ eventType: "code_edit", editor: "user" }))
		expect(m.getConceptModeState().active).to.equal(false)
	})

	it("★ CODE_WORK 的四个分类都能退出概念模式（参数化）", () => {
		for (const category of ["debugging", "refactoring", "testing", "language_request"] as const) {
			const st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, {
				category: "algorithm",
				studentEdited: false,
				wantsCompleteImpl: false,
			})
			const exited = nextConceptMode(st, { category, studentEdited: false, wantsCompleteImpl: false })
			expect(exited.active, `category=${category} 应退出概念模式`).to.equal(false)
		}
	})
})
