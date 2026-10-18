/**
 * G5 · P5 优先级综合测试（L2 层）—— 计数单位 / 状态存续 / 记账去重 / 送达保护
 *
 * 覆盖 plan-2 §0 的四类检查：正常路径 / 边界条件 / 回归 / 核心流程可跑通。
 * 对应实测（§11）里 **两个反例** 与 **两个记账偏差**：
 *   - M1'（单次提问 ⇒ 应有零干预）
 *   - M1'（单次提问 ⇒ 应有零干预）
 *   - M4''（一次 12 回合的请求不得阻断；阻断的唯一入口是助手真实落盘 3 次，【P6/T6】）
 *   - M7' 的同一轮重复记账（T17）
 *   - M9' ③ 注入未送达（T19）
 *
 * ⚠️ **诚实声明**：③④ 是**结构守卫（变更探测器）**，不是端到端验证 ——
 * 它们只证明"接线挂着、顺序对、键里有该字段"，真实运行行为需要手工复现
 * （`Task` 实例化、webview 展示、文件系统写入都无法在单测里完成）。
 * ①② 是真正的行为断言（纯内存链路：BehaviorMonitor → TeachingInterventionManager）。
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { after, beforeEach } from "mocha"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import type { StudentInteractionLog, TaskCategory } from "../types"
import { ev } from "./__fixtures__/events"

/** 阻断状态是跨会话全局静态（v2.7 防绕过），生产代码无清除入口 ⇒ 测试侧必须复位（同 G0） */
const managerStaticState = TeachingInterventionManager as unknown as {
	globalBlockingEndsAt: number
	globalLastBlockingIntervention: unknown
}
const savedBlockingEndsAt = managerStaticState.globalBlockingEndsAt
const savedLastBlockingIntervention = managerStaticState.globalLastBlockingIntervention

const stu = (
	raw: string,
	eventType: "task_start" | "turn_message" = "turn_message",
	category: TaskCategory = "explanation",
): StudentInteractionLog => ev({ eventType, role: "user", category, hasCode: false, hasCodeBlock: false, rawContent: raw })

/** 只有工具调用、没有正文的助手回合（M1'/M4' 实测形态） */
const toolOnlyTurn = (): StudentInteractionLog => ev({ hasCode: false, hasCodeBlock: false, suggestionType: "other" })

/** 助手代码回合（DSML/工具调用 + 正文代码块） */
const codeTurn = (): StudentInteractionLog => ev({})

const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")

describe("G5 · 优先级综合（P5：计数单位 / 状态 / 记账 / 送达）", () => {
	beforeEach(() => {
		managerStaticState.globalBlockingEndsAt = 0
		managerStaticState.globalLastBlockingIntervention = null
	})

	it("【G5-①】M1' 零干预：单次提问 + 8 个「只有工具调用」的助手回合 ⇒ 既无警报也无注入文本", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(stu("第一周学了什么", "task_start"))
		for (let i = 0; i < 8; i++) {
			m.ingest(toolOnlyTurn())
		}

		expect(m.getStudentRequestCount()).to.equal(1)
		expect(m.getPendingAlerts()).to.have.length(0) // 实测里落下了 2 条 decision，即此处不再发生
		expect(m.getRuleIdsAtBlockingThreshold()).to.deep.equal([])

		const mgr = new TeachingInterventionManager("t1")
		expect(mgr.checkAndGenerateIntervention(m, 8)).to.equal(null)
		expect(mgr.isBlockingActive()).to.equal(false)
	})

	it("【G5-② / P6/T6】M4'' 回归：一次 12 回合的请求不阻断；第 3 次索要完整实现只提示（阻断改由 AI 落盘驱动）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })

		// 第 1 次请求：索要 + 12 个助手代码回合（实测 M4' 的形态）
		m.ingest(stu("帮我写一个完整的冒泡排序程序", "task_start", "code_generation"))
		for (let i = 0; i < 12; i++) {
			m.ingest(codeTurn())
		}
		const first = mgr.checkAndGenerateIntervention(m, 1)
		expect(mgr.isBlockingActive(), "一次请求不得触发阻断（旧口径在此处即阻断）").to.equal(false)
		expect(first ?? "").to.not.include("阻断模式")

		// 第 2 次请求：仍然只提醒
		m.ingest(stu("把完整代码给我", "turn_message", "code_generation"))
		m.ingest(codeTurn())
		expect(mgr.checkAndGenerateIntervention(m, 2) ?? "").to.not.include("阻断模式")

		// 第 3 次请求：规则计数到 3（提醒照发），但【P6/T6】阻断不再由本规则承担 ⇒ 阻断态仍为 false
		m.ingest(stu("不要解释了，直接给我代码", "turn_message", "code_generation"))
		m.ingest(codeTurn())
		expect(m.getEscalationCount("complete_impl_demand")).to.equal(3)
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("complete_impl_demand")
		expect(m.getRuleIdsAtBlockingThreshold()).to.deep.equal([])
		expect(mgr.checkAndGenerateIntervention(m, 3) ?? "").to.not.include("阻断模式")
		expect(mgr.isBlockingActive()).to.equal(false)
	})

	it("【G5-②b / P6/T6】阻断的唯一边界：助手真实落盘 3 次（独立通道）才阻断，学生索要再多也不阻断", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })

		// 两次「学生索要 + 助手落盘」⇒ 计数 2，不阻断
		for (let i = 0; i < 2; i++) {
			m.ingest(stu(`第 ${i + 1} 次请你直接写`, "task_start", "code_generation"))
			m.ingest(ev({ eventType: "code_edit", category: "other", hasCode: false, hasCodeBlock: false, editor: "ai" }))
			expect(mgr.checkAndGenerateIntervention(m, i + 1) ?? "").to.not.include("阻断模式")
		}
		expect(m.getAiCodingCount()).to.equal(2)
		expect(mgr.isBlockingActive()).to.equal(false)

		// 第 3 次落盘 ⇒ 达阈值 ⇒ 阻断文本 + 阻断态
		m.ingest(stu("第 3 次请你直接写", "turn_message", "code_generation"))
		m.ingest(ev({ eventType: "code_edit", category: "other", hasCode: false, hasCodeBlock: false, editor: "ai" }))
		expect(m.getAiCodingCount()).to.equal(3)
		const third = mgr.checkAndGenerateIntervention(m, 3)
		expect(third).to.be.a("string").and.to.include("阻断模式")
		expect(mgr.isBlockingActive()).to.equal(true)
	})

	it("【G5-③】结构守卫（**变更探测器**）：T15 状态存续 / T17 记账去重 / T19 送达保护的接线", () => {
		// T19-a：未送达的干预顺延重投，且有上限
		expect(taskSrc).to.include("const INTERVENTION_REDELIVERY_LIMIT = 2")
		expect(taskSrc).to.include("interventionRedeliveryLeft")
		// 【P8/T6】判定已抽成纯函数 `decideHintLifetime`（同一学生请求内一直有效，跨请求才受上限约束）：
		// 断言从"内联布尔表达式"改为"接线到该纯函数 + 仍然传入了两个关键输入"，语义不变。
		expect(taskSrc).to.include("const hintLifetime = decideHintLifetime({")
		expect(taskSrc).to.include("delivered: this.interventionCopyDeliveredThisTurn")
		expect(taskSrc).to.include("hasPending: this.pendingInterventionText !== undefined")
		// 【P6/T1】`needDecision` 门控已删除：顺延重投的回合也必须跑决策（否则计数达阈也不会阻断）
		expect(taskSrc).to.not.include("const needDecision = !carryOverHint")
		// 【P6/T2】内联的 `appliesDecision` 已抽成纯函数 `planInterventionTurn`（回合级编排可运行时单测）
		expect(taskSrc).to.not.include("const appliesDecision = ")
		expect(taskSrc).to.include("const plan = planInterventionTurn({")

		// T15：按 taskId 跨实例复用（LRU + TTL），两个入口都要接上
		expect(taskSrc).to.include("Task.takeCachedState(Task.monitorCache, this.taskId)")
		expect(taskSrc).to.include("Task.putCachedState(Task.monitorCache, this.taskId, this.behaviorMonitor)")
		expect(taskSrc).to.include("Task.takeCachedState(Task.managerCache, this.taskId)")
		expect(taskSrc).to.include("Task.putCachedState(Task.managerCache, this.taskId, this.interventionManager)")
		expect(taskSrc).to.include("TASK_STATE_LIMIT")
		expect(taskSrc).to.include("TASK_STATE_TTL_MS")

		// T15-b：学生回合"先算后写"—— monitorBehavior 必须在 await persister.persist 之前
		const fnStart = taskSrc.indexOf("private async persistTurnLevelLog")
		expect(fnStart, "index.ts 必须仍有 persistTurnLevelLog").to.be.greaterThan(-1)
		const fnEnd = taskSrc.indexOf("\n\tprivate ", fnStart + 1)
		const fnBody = taskSrc.slice(fnStart, fnEnd > 0 ? fnEnd : undefined)
		const ingestAt = fnBody.indexOf("this.monitorBehavior(log)")
		const persistAt = fnBody.indexOf("await persister.persist(log)")
		expect(ingestAt, "必须先 ingest").to.be.greaterThan(-1)
		expect(persistAt, "必须仍有落盘").to.be.greaterThan(-1)
		expect(ingestAt, "ingest 必须在落盘之前（否则提示词读到上一轮的旧状态）").to.be.lessThan(persistAt)

		// T17：【P6/T1】记账去重键 = taskId : 学生请求数 : 种类（不得含 apiRequestCount —— 重试会变）
		expect(taskSrc).to.include('if (!this.interventionAccountKey("decision"))')
		expect(taskSrc).to.include('if (!this.interventionAccountKey("copy"))')
		expect(taskSrc).to.include("buildInterventionAccountKey(this.taskId, studentRequests, kind)")
		expect(/apiRequestCount\}:\$\{studentRequests\}/.test(taskSrc)).to.equal(false)
	})

	it("【G5-④】结构守卫（**变更探测器**）：T16 强化约束只在本轮索要时注入", () => {
		// 【P6/T9】门控追加 `&& !complianceGranted`：学生自述写不出并确认后，本轮豁免拒答约束。
		expect(taskSrc).to.include("if (demandMonitor?.isCurrentRequestDemand() && !complianceGranted) {")
		expect(taskSrc).to.include("systemPromptFinal = systemPromptFinal + buildDemandRefusalConstraint()")
		// 概念护栏与"索要"约束是**两条独立注入**（索要不是概念问答的子集：M6' 里分类会被翻转）
		expect(taskSrc).to.include("systemPromptFinal = systemPromptFinal + buildConceptModeConstraint()")
		// 只读监测：注入路径不得反过来写 monitor 状态
		expect(taskSrc).to.not.include("setCurrentRequestDemand(")
	})
})

// 【测试卫生】跑完后还原全局阻断状态（同 G0），避免污染同进程内其它 spec
after(() => {
	managerStaticState.globalBlockingEndsAt = savedBlockingEndsAt
	managerStaticState.globalLastBlockingIntervention = savedLastBlockingIntervention
})
