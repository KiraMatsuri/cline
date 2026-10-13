/**
 * F11-② · 采纳推断必须以"同一主题"为前提。
 *
 * 修复前 `inferAdoption` 有三处在换题（`isSameTopic === false`）时仍返回 "adopted"：
 * 规则 1（完全不看 topic）、规则 2（`suggestionType === "completion"` 无条件）与兜底
 * （"有编辑但换了话题 ⇒ adopted"）⇒ `adoption_infer` 事件里 `adopted` 近乎恒真，采纳率指标失去区分度。
 *
 * 副作用：这样改写后 `rejected` 变为**不可达**（原"规则 4"依赖的换题分支已被提前 return 覆盖），
 * 已在 `types.ts` 的 `AdoptionStatus` JSDoc 里登记（不删除联合成员，历史 JSONL 里有该值）。
 */
import { expect } from "chai"
import { AdoptionTracker } from "../AdoptionTracker"

const TS = "2026-01-01T00:00:00.000Z"

describe("F11-② · 采纳推断必须以同一主题为前提", () => {
	it("① 换题 + 有代码编辑 → unknown（修复前是 adopted，本修复的核心断言）", () => {
		const t = new AdoptionTracker()
		t.registerAssistantTurn("t1", 0, "code_generation", true, TS)
		t.onCodeEdit("t1")
		expect(t.onUserMessage("t1", false)).to.equal("unknown")
	})

	it("② 换题 + suggestionType=completion → unknown（修复前是 adopted）", () => {
		const t = new AdoptionTracker()
		t.registerAssistantTurn("t2", 0, "completion", false, TS)
		expect(t.onUserMessage("t2", false)).to.equal("unknown")
	})

	it("③ 换题 + 有文件保存 → unknown（修复前是 adopted）", () => {
		const t = new AdoptionTracker()
		t.registerAssistantTurn("t3", 0, "explanation", false, TS)
		t.onFileSave("t3")
		expect(t.onUserMessage("t3", false)).to.equal("unknown")
	})

	it("④ 同主题 + 有代码编辑 + AI 给了代码 → adopted（正例不得被削弱）", () => {
		const t = new AdoptionTracker()
		t.registerAssistantTurn("t4", 0, "code_generation", true, TS)
		t.onCodeEdit("t4")
		expect(t.onUserMessage("t4", true)).to.equal("adopted")
	})

	it("⑤ 同主题 + completion → adopted", () => {
		const t = new AdoptionTracker()
		t.registerAssistantTurn("t5", 0, "completion", false, TS)
		expect(t.onUserMessage("t5", true)).to.equal("adopted")
	})

	it("⑥ 同主题 + 无编辑 + 非 completion → continued", () => {
		const t = new AdoptionTracker()
		t.registerAssistantTurn("t6", 0, "explanation", false, TS)
		expect(t.onUserMessage("t6", true)).to.equal("continued")
	})

	it("⑦ 无 pending → unknown", () => {
		const t = new AdoptionTracker()
		expect(t.onUserMessage("none", true)).to.equal("unknown")
	})
})
