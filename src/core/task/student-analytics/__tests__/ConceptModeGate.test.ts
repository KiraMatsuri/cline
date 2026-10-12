import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { INITIAL_CONCEPT_MODE_STATE, nextConceptMode } from "../ConceptModeGate"
import type { StudentInteractionLog } from "../types"

const ev = (over: Partial<StudentInteractionLog>): StudentInteractionLog => ({
	ts: new Date().toISOString(),
	taskId: "t1",
	eventType: "turn_message",
	role: "assistant",
	category: "code_generation",
	contentLength: 0,
	hasCode: true,
	hasCodeBlock: true,
	languageHint: "python",
	imageCount: 0,
	fileCount: 0,
	turnIndex: -1,
	...over,
})

const s = (o: Partial<Parameters<typeof nextConceptMode>[1]>) => ({
	category: undefined as never,
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
	it("退出后不会因后续概念提问而自动复活（需重新进入判定）", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		st = nextConceptMode(st, s({ category: "debugging" }))
		expect(nextConceptMode(st, s({ category: "other" })).active).to.equal(false)
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
})
