/**
 * 【P8/T3（裁定 3-B）】「学生动手」的清零必须按**整个学生请求**判断。
 *
 * 实测依据（2026-10-18，taskId=1792317246405）：4 次 AI 写盘里有 3 次同时产生了一条
 * `code_edit(editor=user)`，而且它**早于**任何 AI 归属事件。旧实现当场把它当成"学生动手"⇒
 * `ai_coding_rounds` 被清零 ⇒ 峰值只到 2、阈值 3 永不触达。
 *
 * 裁定 3-B：清零前要求「**同一学生请求内该文件没有任何 AI 写盘事件**」。
 * 因为误判事件可能早于 AI 事件，这个判定只能在**请求边界**看全窗口 ⇒ 延迟结算。
 */
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import type { StudentInteractionLog } from "../types"
import { ev } from "./__fixtures__/events"

const stu = (raw = "第 N 次"): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: raw })

const aiWriteTo = (filePath: string): StudentInteractionLog =>
	ev({ eventType: "code_edit", editor: "ai", filePath, role: "assistant", hasCode: true })
/** 归属误判形态：同一文件、AI 刚写过，但日志写成 editor=user */
const phantomStudentEditOf = (filePath: string): StudentInteractionLog =>
	ev({ eventType: "code_edit", editor: "user", filePath, role: "user", hasCode: true })

describe("【P8/T3】学生编辑清零：请求边界结算（裁定 3-B）", () => {
	it("★ 前提：AI 写盘确实让计数 +1", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu())
		m.ingest(aiWriteTo("bubble_sort.py"))
		expect(m.getAiCodingCount()).to.equal(1)
	})

	it("★ 归属误判（同请求内 AI 也写过该文件）⇒ 下一请求开始时**不清零**", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第 1 次"))
		m.ingest(phantomStudentEditOf("bubble_sort.py")) // 实测里它比 AI 事件先到
		m.ingest(aiWriteTo("bubble_sort.py"))
		expect(m.getAiCodingCount()).to.equal(1)

		m.ingest(stu("第 2 次")) // 请求边界 → 结算：该文件本请求被 AI 写过 ⇒ 不清零
		expect(m.getAiCodingCount()).to.equal(1)
	})

	it("★ 真的学生动手（同请求内 AI 没写过该文件）⇒ 下一请求开始时清零", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第 1 次"))
		m.ingest(aiWriteTo("bubble_sort.py"))
		m.ingest(stu("第 2 次"))
		m.ingest(phantomStudentEditOf("my_notes.py")) // 学生自己改别的文件
		expect(m.getAiCodingCount()).to.equal(1) // 延迟结算：此刻还没清

		m.ingest(stu("第 3 次")) // 边界结算 ⇒ 清零
		expect(m.getAiCodingCount()).to.equal(0)
	})

	it("★ 没有学生编辑 ⇒ 计数不受影响", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第 1 次"))
		m.ingest(aiWriteTo("a.py"))
		m.ingest(stu("第 2 次"))
		m.ingest(aiWriteTo("b.py"))
		expect(m.getAiCodingCount()).to.equal(2)
	})

	it("★ 无 filePath 的旧日志/异形态 ⇒ 保守地立即清零（保持向后兼容）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第 1 次"))
		m.ingest(aiWriteTo("a.py"))
		m.ingest(ev({ eventType: "code_edit", editor: "user", role: "user", hasCode: false })) // 无 filePath
		expect(m.getAiCodingCount()).to.equal(0)
	})

	it("★ 连续 4 次写盘 + 3 次伪学生编辑 ⇒ 计数到 4，第 3 次即达阻断阈值（本轮失效的复现）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		const files = ["bubble_sort.py", "selection_sort.py", "quick_sort.py", "insertion_sort.py"]
		files.forEach((file, i) => {
			m.ingest(stu(`第 ${i + 1} 次：帮我实现`))
			m.ingest(phantomStudentEditOf(file)) // 日志里的 editor=user（归属误判）
			m.ingest(aiWriteTo(file))
		})
		expect(m.getAiCodingCount()).to.equal(4)
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(true)
	})

	it("★ 依赖度窗口同样受保护（同一误判的连带项）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第 1 次"))
		m.ingest(stu("第 2 次"))
		m.ingest(stu("第 3 次"))
		expect(m.getWeightedDependencyScore()).to.equal(3)

		m.ingest(aiWriteTo("a.py"))
		m.ingest(phantomStudentEditOf("a.py")) // 该文件本请求被 AI 写过 ⇒ 不清窗口
		m.ingest(stu("第 4 次"))
		expect(m.getWeightedDependencyScore()).to.be.greaterThan(3)
	})

	it("★ reset() 清空归属集合（跨任务不得残留）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第 1 次"))
		m.ingest(aiWriteTo("a.py"))
		m.reset()
		m.ingest(stu("第 2 次"))
		m.ingest(phantomStudentEditOf("a.py"))
		m.ingest(stu("第 3 次"))
		// reset 后同一请求内没有 AI 写盘 ⇒ 视为真动手 ⇒ 清零（证明上一任务的集合没残留）
		expect(m.getAiCodingCount()).to.equal(0)
	})
})
