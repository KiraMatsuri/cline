/**
 * G8 · P8 判据门禁（L2 层）—— 写盘归属 / 学生动手的边界结算 / 提示生命周期
 *
 * 对应 2026-10-18 第二轮的失败：4 次真实写盘，`ai_coding_rounds` 只到 2，阻断永不触发。
 * 三处根因各有一条门禁：
 *  M4'''：4 次写盘（每次后跟一条归属误判的 `editor=user`）⇒ 计数 1/2/3/4，**第 3 次阻断**
 *  M20'：归属误判不得清零（同请求内 AI 写过该文件）
 *  M21'：真的学生动手 ⇒ 下一请求开始时清零
 *  M22'：`我还是写不出来` 进入 b+c 询问
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { after, beforeEach } from "mocha"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { decideHintLifetime } from "../interventionHintLifetime"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import type { StudentInteractionLog } from "../types"
import { ev } from "./__fixtures__/events"

const managerStaticState = TeachingInterventionManager as unknown as {
	globalBlockingEndsAt: number
	globalLastBlockingIntervention: unknown
}
const savedEndsAt = managerStaticState.globalBlockingEndsAt
const savedLast = managerStaticState.globalLastBlockingIntervention

const stu = (raw: string): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: raw })
const aiWriteTo = (filePath: string): StudentInteractionLog =>
	ev({ eventType: "code_edit", editor: "ai", filePath, role: "assistant", hasCode: true })
const phantomStudentEditOf = (filePath: string): StudentInteractionLog =>
	ev({ eventType: "code_edit", editor: "user", filePath, role: "user", hasCode: true })

const taskSrc = fs.readFileSync(path.resolve(process.cwd(), "src/core/task/index.ts"), "utf-8")
const monitorSrc = fs.readFileSync(path.resolve(process.cwd(), "src/core/task/student-analytics/BehaviorMonitor.ts"), "utf-8")
const writeSrc = fs.readFileSync(path.resolve(process.cwd(), "src/core/task/tools/handlers/WriteToFileToolHandler.ts"), "utf-8")

describe("G8 · P8（写盘归属 / 边界结算 / 提示生命周期）", () => {
	beforeEach(() => {
		managerStaticState.globalBlockingEndsAt = 0
		managerStaticState.globalLastBlockingIntervention = null
	})

	it("【G8-①】M4'''：4 次写盘（每次都带一条归属误判的学生编辑）⇒ 第 3 次阻断", () => {
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		const files = ["bubble_sort.py", "selection_sort.py", "quick_sort.py", "insertion_sort.py"]

		files.slice(0, 2).forEach((file, i) => {
			m.ingest(stu(`第 ${i + 1} 次：帮我写完整的排序`))
			m.ingest(phantomStudentEditOf(file))
			m.ingest(aiWriteTo(file))
		})
		expect(m.getAiCodingCount()).to.equal(2)
		expect(mgr.checkAndGenerateIntervention(m, 1) ?? "").to.not.include("阻断模式")

		// 第 3 次写盘 ⇒ 达阈值 ⇒ 阻断（实测就卡在这一步之前）
		m.ingest(stu("第 3 次：帮我写完整的排序"))
		m.ingest(phantomStudentEditOf(files[2]))
		m.ingest(aiWriteTo(files[2]))
		expect(m.getAiCodingCount()).to.equal(3)
		expect(mgr.checkAndGenerateIntervention(m, 2)).to.include("阻断模式")
		expect(mgr.isBlockingActive()).to.equal(true)
	})

	it("【G8-②】M21'：真的学生动手（AI 本请求没写过该文件）⇒ 下一请求开始时清零", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第 1 次"))
		m.ingest(aiWriteTo("a.py"))
		m.ingest(aiWriteTo("a.py")) // 同请求内仍只 +1
		expect(m.getAiCodingCount()).to.equal(1)

		m.ingest(stu("第 2 次"))
		m.ingest(phantomStudentEditOf("my_notes.py")) // 学生真的改了别的文件
		m.ingest(stu("第 3 次")) // 边界结算
		expect(m.getAiCodingCount()).to.equal(0)
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(false)
	})

	it("【G8-③】回归：4 份骨架（hasFullImpl=false）永不阻断", () => {
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 4; i++) {
			m.ingest(stu(`第 ${i + 1} 次：给我完整代码`))
			m.ingest(ev({ eventType: "turn_message", role: "assistant", hasCode: true, hasCodeBlock: true, hasFullImpl: false }))
		}
		expect(m.getAiCodingCount()).to.equal(0)
		expect(mgr.checkAndGenerateIntervention(m, 1) ?? "").to.not.include("阻断模式")
	})

	it("【G8-④】M22' + 提示生命周期：`我还是写不出来` 入 b+c；同请求内多工具轮不丢提示", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("我还是写不出来，请直接帮我实现"))
		expect(m.isCurrentRequestInability()).to.equal(true)

		// 同一学生请求内的第 4 个工具轮：旧实现（顺延上限 2）会在这里丢掉提示
		const d = decideHintLifetime({
			hasPending: true,
			delivered: false,
			decisionRequest: 7,
			currentRequest: 7,
			redeliveryLeft: 0,
		})
		expect(d.carryOver).to.equal(true)
	})

	it("【G8-⑤】结构守卫（变更探测器）：归属用绝对路径 / 存在边界结算 / 生命周期已接线", () => {
		expect(writeSrc).to.not.include("markFileAsEditedByCline(relPath)")
		expect(writeSrc.match(/markFileAsEditedByCline\(absolutePath\)/g)?.length ?? 0).to.be.greaterThan(1)

		expect(monitorSrc).to.include("private settleStudentEditReset(): void")
		expect(monitorSrc).to.include("this.aiWrittenFilesThisRequest.has(f)")

		expect(taskSrc).to.include("const hintLifetime = decideHintLifetime({")
	})
})

after(() => {
	managerStaticState.globalBlockingEndsAt = savedEndsAt
	managerStaticState.globalLastBlockingIntervention = savedLast
})
