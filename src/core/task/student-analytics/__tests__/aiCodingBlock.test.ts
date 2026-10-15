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
import { generateBlockingInterventionMessage, TEMPLATE_REGISTRY } from "../InterventionMessageGenerator"
import type { BehaviorAlert, BehaviorRuleId, StudentInteractionLog } from "../types"
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

	it("★ 边界：code_edit 缺省 editor（旧日志）按人工编辑处理 ⇒ 计数被清零", () => {
		// 为什么缺省按人工处理：旧日志 / 未标注来源的编辑只能保守视为"学生自己动手"
		//（与 `updateRealtimeStreaks` 的 `event.editor !== "ai"` 分支、`isStudentSideEvent` 同一口径）；
		// 宁可多清零（漏记一次 AI 落盘）也不要反着误判：把学生的手动编辑当成 AI 落盘而继续累计依赖。
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第一句"))
		m.ingest(aiWrite())
		expect(m.getAiCodingCount()).to.equal(1) // 前提：清零前确实计了一次，否则下面的 0 是恒真的
		m.ingest(ev({ eventType: "code_edit", category: "other", hasCode: false, hasCodeBlock: false }))
		expect(m.getAiCodingCount()).to.equal(0)
	})

	it("★ 同一请求内「AI 落盘 → 学生手改 → AI 再落盘」不得记 2 次", () => {
		// 全局约束「每个学生请求最多 +1」：学生编辑只把**计数**清零，重入去重标记不动
		//（`bumpedRulesThisRequest`）。若连标记一起清，AI 在本请求内再落盘就会再 +1。
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第一句"))
		m.ingest(aiWrite())
		expect(m.getAiCodingCount()).to.equal(1)

		m.ingest(editEv({ editor: "user" })) // 学生手改 ⇒ 计数清零
		expect(m.getAiCodingCount()).to.equal(0)

		m.ingest(aiWrite()) // 同一请求内再次落盘：本请求已计过 ⇒ 不再 +1
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
		// 让用例名里的"不留未填充占位符"真有断言兜底：三档均为静态文案，不应残留 `{...}`
		for (const t of [reg.gentle[0].template, reg.moderate[0].template, reg.strong[0].template]) {
			expect(t).to.not.include("{")
		}
	})

	it("★ 阻断文案：本规则有自己的阻断模板，主语是「我（AI）」而非指控学生", () => {
		// 生产入口 `generateBlockingInterventionMessage()` 就是按 `BLOCKING_TEMPLATE_REGISTRY[ruleId]` 取文案
		//（注册表未导出，所以"注册表含该键"只能透过这个函数断言：缺键会落到 `?? consecutive_code_generation`）。
		const alert = (ruleId: BehaviorRuleId): BehaviorAlert => ({
			ruleId,
			message: "我已经替你写了 3 次完整代码。",
			triggeredAt: new Date().toISOString(),
			metricValue: 3,
			threshold: 3,
			escalationCount: 3,
		})
		const own = generateBlockingInterventionMessage(alert("ai_coding_rounds"), 60_000)
		const fallback = generateBlockingInterventionMessage(alert("consecutive_code_generation"), 60_000)

		// ① 注册表含 `ai_coding_rounds` 键 ⇒ 取到的是本规则模板，而不是兜底模板
		expect(own.content).to.not.equal(fallback.content)
		// ② 不得复用兜底文案里"指控学生"的字句
		expect(own.content).to.not.include("直接请求 AI 生成代码")
		expect(fallback.content).to.include("直接请求 AI 生成代码") // 反向对照：证明上面那句不是恒真
		// ③ 主语必须是「我（AI）」，且阻断结构（标题 / 禁用功能 / 反思问题）齐备
		expect(own.content).to.include("我")
		expect(own.content).to.include("🚫 【教学干预 — 阻断模式】")
		expect(own.disabledFeatures).to.deep.equal(["code_generation", "tool_execution"])
		expect(own.reflectionQuestions?.length ?? 0).to.be.greaterThan(0)
	})
})
