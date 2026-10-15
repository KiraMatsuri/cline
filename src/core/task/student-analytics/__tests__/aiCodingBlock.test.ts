/**
 * 【P6/T5】阻断改为独立通道：只有**助手真实编码文件**才计数，阈值 3，学生本人编辑清零。
 *
 * 实测依据（第二轮人工验收）：9 条阻断全部发生在助手**从未落盘**的会话里
 * （该日志 `code_edit` 事件数 = 0）—— 计数与被计数的行为完全脱钩。
 * 计数必须用"AI 真的写了文件"这个信号（`code_edit` + `editor === "ai"`，
 * 由 F2/F11 保证归属正确，等价于 write_to_file / replace_in_file / apply_patch 成功）。
 */
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { TEMPLATE_REGISTRY } from "../InterventionMessageGenerator"
import type { StudentInteractionLog } from "../types"
import { editEv, ev } from "./__fixtures__/events"

const stu = (raw: string): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: raw })

/** 助手真实落盘（AI 写文件 / 改文件） */
const aiWrite = (): StudentInteractionLog => editEv({ editor: "ai" })

describe("【P6/T5】ai_coding_rounds", () => {
	it("★ 助手落盘才计数：普通助手回合（含 fenced 代码块）不计", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("帮我看看这个模块"))
		for (let i = 0; i < 5; i++) {
			m.ingest(ev({})) // hasCodeBlock: true 的助手回合
		}
		expect(m.getAiCodingCount()).to.equal(0)
	})

	it("★ 同一学生请求内写多个文件只算 1 次", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("帮我实现这三个函数"))
		m.ingest(aiWrite())
		m.ingest(aiWrite())
		m.ingest(aiWrite())
		expect(m.getAiCodingCount()).to.equal(1)
	})

	it("★ 跨 3 个学生请求各写一次 ⇒ 达阈值并触发阻断", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m.ingest(stu(`第 ${i + 1} 次请你直接写`))
			m.ingest(aiWrite())
		}
		expect(m.getAiCodingCount()).to.equal(3)
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(true)
		expect(m.getRuleIdsAtBlockingThreshold()).to.deep.equal(["ai_coding_rounds"])
	})

	it("★ 学生本人编辑代码 ⇒ 计数清零（未达阈值前）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第一句"))
		m.ingest(aiWrite())
		m.ingest(stu("第二句"))
		m.ingest(aiWrite())
		expect(m.getAiCodingCount()).to.equal(2)

		m.ingest(editEv({ editor: "user" })) // 学生自己动手
		expect(m.getAiCodingCount()).to.equal(0)
		expect(m.shouldEscalateToBlocking("ai_coding_rounds")).to.equal(false)

		m.ingest(stu("第三句"))
		m.ingest(aiWrite())
		expect(m.getAiCodingCount()).to.equal(1)
	})

	it("★ 边界：AI 落盘事件缺省 editor（旧日志）按人工处理 ⇒ 不清零、不计数", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第一句"))
		m.ingest(aiWrite())
		m.ingest(ev({ eventType: "code_edit", category: "other", hasCode: false, hasCodeBlock: false }))
		expect(m.getAiCodingCount()).to.equal(0)
	})

	it("★ reset() 清空该计数", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第一句"))
		m.ingest(aiWrite())
		m.reset()
		expect(m.getAiCodingCount()).to.equal(0)
	})

	it("★ 文案：三档模板齐备、风格正确、不留未填充占位符", () => {
		const reg = TEMPLATE_REGISTRY.ai_coding_rounds
		expect(reg.gentle[0].style).to.equal("hint")
		expect(reg.moderate[0].style).to.equal("question")
		expect(reg.strong[0].style).to.equal("challenge")
		// 主语必须是"我（AI）"：这不是学生行为违规，而是"我在替你写"
		expect(reg.gentle[0].template).to.include("我")
	})
})
