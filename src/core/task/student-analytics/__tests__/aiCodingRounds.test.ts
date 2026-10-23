/**
 * ai_coding_rounds · 计数通道（P2-2 删除阻断后的现行契约）。
 *
 * 原 `aiCodingBlock.test.ts` 的主题「阻断改独立通道」已随阻断能力删除；
 * 本文件只保留仍然生效的计数语义：
 *   ① 计数单位 = 助手**真实编码**：落盘（code_edit + editor=ai）或给出完整实现（hasFullImpl）；
 *   ② 每个学生请求至多 +1（同请求多文件 / 落盘+完整实现都只算 1 次）；
 *   ③ 学生本人编辑 ⇒ 计数清零（缺省 editor 也按人工处理）；
 *   ④ reset() 清空。
 * 阻断相关断言（shouldEscalateToBlocking / getRuleIdsAtBlockingThreshold / 阻断文案）已随 API 删除，
 * 由 noBlocking.test.ts 统一做「不存在」守卫。
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
const fullImplTurn = (): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "assistant", hasCode: true, hasCodeBlock: true, hasFullImpl: true })
const skeletonTurn = (): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "assistant", hasCode: true, hasCodeBlock: true, hasFullImpl: false })

describe("ai_coding_rounds · 计数通道（助手真实编码）", () => {
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

	it("★ 跨 3 个学生请求各写一次 ⇒ 计数到 3，并产生提醒（只提示，不阻断）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m.ingest(stu(`第 ${i + 1} 次请你直接写`))
			m.ingest(aiWrite())
		}
		expect(m.getAiCodingCount()).to.equal(3)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("ai_coding_rounds")
		// 计数通道不再有升级能力
		expect((m as unknown as Record<string, unknown>).shouldEscalateToBlocking).to.equal(undefined)
	})

	it("★ 概念分类（algorithm）下同样计数（计数不受分类门控影响）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		const askConcept = (raw: string): StudentInteractionLog =>
			ev({
				eventType: "turn_message",
				role: "user",
				category: "algorithm",
				hasCode: false,
				hasCodeBlock: false,
				rawContent: raw,
			})
		for (let i = 0; i < 3; i++) {
			m.ingest(askConcept(`第 ${i + 1} 个概念问题`))
			m.ingest(editEv({ editor: "ai" }))
		}
		expect(m.getAiCodingCount()).to.equal(3)
	})

	it("★ 学生本人编辑代码 ⇒ 计数清零", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第一句"))
		m.ingest(aiWrite())
		m.ingest(stu("第二句"))
		m.ingest(aiWrite())
		expect(m.getAiCodingCount()).to.equal(2)

		m.ingest(editEv({ editor: "user" })) // 学生自己动手
		expect(m.getAiCodingCount()).to.equal(0)

		m.ingest(stu("第三句"))
		m.ingest(aiWrite())
		expect(m.getAiCodingCount()).to.equal(1)
	})

	it("★ 边界：code_edit 缺省 editor（旧日志）按人工编辑处理 ⇒ 计数被清零", () => {
		// 为什么缺省按人工处理：旧日志 / 未标注来源的编辑只能保守视为"学生自己动手"
		//（与 `updateRealtimeStreaks` 的 `event.editor !== "ai"` 分支同一口径）；
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

	it("★ 文案：ai_coding_rounds 三档模板齐备、风格正确、不留未填充占位符", () => {
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
})

describe("ai_coding_rounds · 完整实现信号", () => {
	it("★ 给出完整实现即计 1 次（即使没有落盘）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("帮我写完整的冒泡排序"))
		m.ingest(fullImplTurn())
		expect(m.getAiCodingCount()).to.equal(1)
	})

	it("★ 骨架 / 填空模板（hasFullImpl=false）不计", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m.ingest(stu(`第 ${i + 1} 次`))
			m.ingest(skeletonTurn())
		}
		expect(m.getAiCodingCount()).to.equal(0)
	})

	it("★ 同一请求内「落盘 + 完整实现」只算 1 次（≤1/请求 的全局约束）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第一句"))
		m.ingest(aiWrite())
		m.ingest(fullImplTurn())
		expect(m.getAiCodingCount()).to.equal(1)
	})

	it("★ 学生回合带 hasFullImpl 不计（信号只认助手回合）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ev({ eventType: "turn_message", role: "user", hasCode: true, hasCodeBlock: true, hasFullImpl: true }))
		expect(m.getAiCodingCount()).to.equal(0)
	})

	it("★ 学生本人编辑同样清零按完整实现累计的计数", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(stu("第一句"))
		m.ingest(fullImplTurn())
		m.ingest(stu("第二句"))
		m.ingest(fullImplTurn())
		expect(m.getAiCodingCount()).to.equal(2)

		m.ingest(editEv({ editor: "user" }))
		expect(m.getAiCodingCount()).to.equal(0)
	})

	it("★ 跨 3 个学生请求各给一次完整实现 ⇒ 计数到 3（提醒仍在队，不阻断）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 0; i < 3; i++) {
			m.ingest(stu(`第 ${i + 1} 次：直接给我完整代码`))
			m.ingest(fullImplTurn())
		}
		expect(m.getAiCodingCount()).to.equal(3)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("ai_coding_rounds")
	})
})
