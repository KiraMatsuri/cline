/**
 * F2 · code_edit 编辑者归属：AI 落盘（write_to_file / apply_patch）不得被判成「学生动手」。
 *
 * 背景见 docs/design/teaching-intervention-acceptance-and-revisions.md §7.4：
 * 旧实现遇 code_edit 即清零 assistantCodeStreak，而 AI 每次落盘都会产生 code_edit，
 * 于是 streak 在 0/1 之间震荡，consecutive_code_generation（阈值 3）永远达不到。
 */
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import { expect } from "chai"
import type { Controller } from "@/core/controller"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { resolveEditEditor } from "../CodeEditTracker"
import type { StudentInteractionLog } from "../types"

const ev = (over: Partial<StudentInteractionLog>): StudentInteractionLog => ({
	ts: new Date().toISOString(),
	taskId: "t1",
	eventType: "code_edit",
	role: "user",
	category: "other",
	contentLength: 0,
	hasCode: true,
	languageHint: "python",
	imageCount: 0,
	fileCount: 0,
	turnIndex: -1,
	...over,
})

const asstCode = () => ev({ eventType: "turn_message", role: "assistant", hasCodeBlock: true })

const ruleIds = (m: BehaviorMonitor) => m.getPendingAlerts().map((a) => a.ruleId)

describe("F2 · code_edit 编辑者归属", () => {
	it("tracker 缺失 → 人工（向后兼容）", () => {
		expect(resolveEditEditor("a.py", undefined)).to.equal("user")
	})

	it("tracker 判定为 AI 写盘 → 'ai'", () => {
		expect(resolveEditEditor("a.py", { wasRecentlyWrittenByCline: () => true })).to.equal("ai")
	})

	it("tracker 抛错 → 回退人工，不向上抛", () => {
		expect(
			resolveEditEditor("a.py", {
				wasRecentlyWrittenByCline: () => {
					throw new Error("x")
				},
			}),
		).to.equal("user")
	})

	it("★ AI 落盘不再清零 streak（旧行为会清零）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(asstCode())
		m.ingest(asstCode())
		m.ingest(ev({ editor: "ai" })) // ← AI 写盘
		m.ingest(asstCode()) // 第 3 个含代码块回合
		expect(ruleIds(m)).to.include("consecutive_code_generation")
	})

	it("人工编辑仍然清零", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(asstCode())
		m.ingest(asstCode())
		m.ingest(ev({ editor: "user" }))
		m.ingest(asstCode())
		expect(ruleIds(m)).to.not.include("consecutive_code_generation")
	})

	it("缺省 editor（旧日志/旧事件）按人工处理", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(asstCode())
		m.ingest(asstCode())
		m.ingest(ev({})) // 无 editor
		m.ingest(asstCode())
		expect(ruleIds(m)).to.not.include("consecutive_code_generation")
	})
})

describe("F2 · wasRecentlyWrittenByCline 只读语义（不得破坏既有 watcher）", () => {
	it("连续两次查询都为 true —— 证明它不消费状态", () => {
		const tracker = new FileContextTracker({} as Controller, "t1")
		tracker.markFileAsEditedByCline("a.py")
		expect(tracker.wasRecentlyWrittenByCline("a.py")).to.equal(true)
		expect(tracker.wasRecentlyWrittenByCline("a.py")).to.equal(true)
	})
})
