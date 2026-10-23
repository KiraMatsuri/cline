/**
 * 【P2-3】六条软提示的规格测试（设计 §5.2 / 计划 P2-3）。
 *
 * 断言面（每条规则 4 类）：
 * 1. 触发：满足条件时产出对应软提示；
 * 2. 不触发：条件不满足 / 被 self_code 打断时不产出；
 * 3. 冷却：同一规则 120s 内只出一条（`cooldownMs` 沿用 BehaviorMonitor 的节流）；
 * 4. 不影响流程：产出的消息恒为 gentle + hint/question + normal，永不阻断；
 *
 * 追加断言：BN-37（同一事件只出一条、按优先级）、每请求每规则 ≤ 1 条、
 * 软规则不受分类停用（`getSoftRulePolicy` 恒启用）、BN-38（模板文案必须通过文案契约）、
 * full_impl_demand 第 4 次起改用「伪代码」放行模板、旧日志（无 behaviorType）走回退路径。
 */

import { expect } from "chai"

import { BehaviorMonitor } from "../BehaviorMonitor"
import { validateCopy } from "../InterventionCopyContract"
import { generateInterventionMessage, SOFT_TEMPLATE_REGISTRY } from "../InterventionMessageGenerator"
import {
	FULL_IMPL_DEMAND_RELEASE_COUNT,
	getRulePolicy,
	getSoftRulePolicy,
	SOFT_INTERVENTION_COOLDOWN_MS,
	SOFT_INTERVENTION_RULE_IDS,
	type SoftInterventionRuleId,
} from "../rulePolicy"
import type { BehaviorAlert, StudentInteractionLog } from "../types"
import { editEv, ev } from "./__fixtures__/events"

/** 文案契约上下文（recentTexts 为空 ⇒ 不做主题锚定启发式，只看确定性校验） */
const COPY_CONTEXT = { recentTexts: "" }

/** 学生请求（默认 design；显式 `behaviorType` 让 P2-1 分类器的结果可被确定性复现） */
const studentMsg = (rawContent: string, over: Partial<StudentInteractionLog> = {}): StudentInteractionLog =>
	ev({
		eventType: "turn_message",
		role: "user",
		category: "code_generation",
		hasCode: false,
		hasCodeBlock: false,
		rawContent,
		...over,
	})

/** 学生自己动手（self_code）：应打断所有「连续…且无 self_code」计数 */
const studentSelfCode = (): StudentInteractionLog => editEv({ editor: "user" })

/** AI 给出完整实现（ai_code） */
const assistantAiCode = (): StudentInteractionLog =>
	ev({
		eventType: "turn_message",
		role: "assistant",
		hasCode: true,
		hasCodeBlock: true,
		hasFullImpl: true,
		behaviorType: "ai_code",
	})

/** 报错求助（error_help） */
const errorMsg = (rawContent: string): StudentInteractionLog => studentMsg(rawContent, { behaviorType: "error_help" })

const newMonitor = (options: ConstructorParameters<typeof BehaviorMonitor>[1] = {}): BehaviorMonitor =>
	new BehaviorMonitor("t1", { cooldownMs: 0, ...options })

const softAlerts = (monitor: BehaviorMonitor, ruleId: string): BehaviorAlert[] =>
	monitor.getPendingAlerts().filter((alert) => alert.ruleId === ruleId)

/** 软提示消息永不可阻断：gentle + hint/question + normal，且文案通过契约校验 */
const expectNonBlockingMessage = (alert: BehaviorAlert): void => {
	const message = generateInterventionMessage(alert)
	expect(message.severity, "severity 恒为 gentle").to.equal("gentle")
	expect(message.interventionType, "interventionType 恒为 normal").to.equal("normal")
	expect(["hint", "question"], "style 只能是 hint/question").to.include(message.style)
	expect(message.content, "文案不得出现阻断字样").to.not.include("阻断")
	expect(message.content, "文案不得出现阻断图标").to.not.include("🚫")
	expect(validateCopy(message.content, COPY_CONTEXT).ok, "文案必须通过文案契约（BN-38 模板兜底）").to.equal(true)
}

/** 同一个报错：exit_code 与首行错误相同 */
const SAME_ERROR_A = "运行后报错：exit_code: 1\nModuleNotFoundError: No module named 'numpy'"
/** 同一个 exit_code，但首行错误不同 ⇒ 不是同一个报错 */
const DIFFERENT_ERROR_B = "运行后报错：exit_code: 1\nValueError: invalid literal for int()"

describe("【P2-3】六条软提示 intervention（只提示、永不阻断）", () => {
	describe("design_stall：连续 3 次 design 且期间无 self_code", () => {
		it("触发：3 次设计类提问后产出 design_stall", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("这段代码的结构该怎么设计？", { behaviorType: "design" }))
			monitor.ingest(studentMsg("先帮我理一下整体思路可以吗？", { behaviorType: "design" }))
			monitor.ingest(studentMsg("模块怎么拆我还没想好，你怎么看？", { behaviorType: "design" }))

			expect(monitor.getLastSoftRuleId()).to.equal("design_stall")
			expect(softAlerts(monitor, "design_stall")).to.have.length(1)
		})

		it("不触发：中途自己动手改代码会打断连续计数", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("整体结构怎么设计？", { behaviorType: "design" }))
			monitor.ingest(studentMsg("模块怎么拆？", { behaviorType: "design" }))
			monitor.ingest(studentSelfCode())
			monitor.ingest(studentMsg("那接口怎么定？", { behaviorType: "design" }))

			expect(monitor.getLastSoftRuleId()).to.not.equal("design_stall")
			expect(softAlerts(monitor, "design_stall")).to.have.length(0)
		})

		it("冷却：120s 内同一规则只出一条", () => {
			const monitor = newMonitor({ cooldownMs: SOFT_INTERVENTION_COOLDOWN_MS })
			for (let i = 0; i < 3; i++) {
				monitor.ingest(studentMsg(`第 ${i} 次设计追问：怎么拆？`, { behaviorType: "design" }))
			}
			expect(softAlerts(monitor, "design_stall")).to.have.length(1)

			for (let i = 0; i < 3; i++) {
				monitor.ingest(studentMsg(`再来一次设计追问：怎么拆？${i}`, { behaviorType: "design" }))
			}
			expect(softAlerts(monitor, "design_stall")).to.have.length(1)
		})

		it("不影响流程：产出的是普通提示消息，不阻断回合", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("怎么设计？", { behaviorType: "design" }))
			monitor.ingest(studentMsg("怎么拆分？", { behaviorType: "design" }))
			monitor.ingest(studentMsg("接口怎么定？", { behaviorType: "design" }))

			expectNonBlockingMessage(softAlerts(monitor, "design_stall")[0])
		})
	})

	describe("same_error_twice：同一 exit_code + 同一首行错误出现 2 次", () => {
		it("触发：同一报错出现两次后产出 same_error_twice", () => {
			const monitor = newMonitor()
			monitor.ingest(errorMsg(SAME_ERROR_A))
			monitor.ingest(errorMsg(SAME_ERROR_A))

			expect(monitor.getLastSoftRuleId()).to.equal("same_error_twice")
			expect(softAlerts(monitor, "same_error_twice")).to.have.length(1)
		})

		it("不触发：exit_code 相同但首行错误不同 ⇒ 不是同一个报错", () => {
			const monitor = newMonitor()
			monitor.ingest(errorMsg(SAME_ERROR_A))
			monitor.ingest(errorMsg(DIFFERENT_ERROR_B))

			expect(monitor.getLastSoftRuleId()).to.not.equal("same_error_twice")
			expect(softAlerts(monitor, "same_error_twice")).to.have.length(0)
		})

		it("冷却：120s 内同一规则只出一条", () => {
			const monitor = newMonitor({ cooldownMs: SOFT_INTERVENTION_COOLDOWN_MS })
			monitor.ingest(errorMsg(SAME_ERROR_A))
			monitor.ingest(errorMsg(SAME_ERROR_A))
			expect(softAlerts(monitor, "same_error_twice")).to.have.length(1)

			monitor.ingest(errorMsg(SAME_ERROR_A))
			monitor.ingest(errorMsg(SAME_ERROR_A))
			expect(softAlerts(monitor, "same_error_twice")).to.have.length(1)
		})

		it("不影响流程：产出的是普通提示消息，不阻断回合", () => {
			const monitor = newMonitor()
			monitor.ingest(errorMsg(SAME_ERROR_A))
			monitor.ingest(errorMsg(SAME_ERROR_A))

			expectNonBlockingMessage(softAlerts(monitor, "same_error_twice")[0])
		})
	})

	describe("full_impl_demand：本轮索要完整实现", () => {
		it("触发：索要完整实现的请求产出 full_impl_demand", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("给我完整代码"))

			expect(monitor.getLastSoftRuleId()).to.equal("full_impl_demand")
			expect(softAlerts(monitor, "full_impl_demand")).to.have.length(1)
		})

		it("不触发：普通求助/讨论不算索要完整实现", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("这段函数为什么报错？", { behaviorType: "design" }))
			monitor.ingest(studentMsg("这个循环是怎么工作的？", { behaviorType: "concept" }))

			expect(monitor.getLastSoftRuleId()).to.not.equal("full_impl_demand")
			expect(softAlerts(monitor, "full_impl_demand")).to.have.length(0)
		})

		it("冷却：120s 内同一规则只出一条", () => {
			const monitor = newMonitor({ cooldownMs: SOFT_INTERVENTION_COOLDOWN_MS })
			monitor.ingest(studentMsg("给我完整代码"))
			monitor.ingest(studentMsg("帮我写一个完整的冒泡排序程序"))
			expect(softAlerts(monitor, "full_impl_demand")).to.have.length(1)
		})

		it("不影响流程：产出的是普通提示消息，不阻断回合", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("给我完整代码"))

			expectNonBlockingMessage(softAlerts(monitor, "full_impl_demand")[0])
		})
	})

	describe("ai_code_streak：连续 2 个学生请求都有 ai_code 且期间无 self_code", () => {
		it("触发：连续两个请求都由 AI 给出完整实现后产出 ai_code_streak", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("这里帮我补全一下", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())
			monitor.ingest(studentMsg("还有这里也帮我写", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())

			expect(monitor.getLastSoftRuleId()).to.equal("ai_code_streak")
			expect(softAlerts(monitor, "ai_code_streak")).to.have.length(1)
		})

		it("不触发：同一请求内的多个 ai_code 事件只推进一格", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("帮我补全", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())
			monitor.ingest(assistantAiCode())

			expect(monitor.getLastSoftRuleId()).to.not.equal("ai_code_streak")
			expect(softAlerts(monitor, "ai_code_streak")).to.have.length(0)
		})

		it("冷却：120s 内同一规则只出一条", () => {
			const monitor = newMonitor({ cooldownMs: SOFT_INTERVENTION_COOLDOWN_MS })
			monitor.ingest(studentMsg("帮我补全", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())
			monitor.ingest(studentMsg("继续补全", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())
			expect(softAlerts(monitor, "ai_code_streak")).to.have.length(1)

			monitor.ingest(studentMsg("再补全一处", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())
			expect(softAlerts(monitor, "ai_code_streak")).to.have.length(1)
		})

		it("不影响流程：产出的是普通提示消息，不阻断回合", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("帮我补全", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())
			monitor.ingest(studentMsg("继续补全", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())

			expectNonBlockingMessage(softAlerts(monitor, "ai_code_streak")[0])
		})
	})

	describe("concept_streak：连续 3 次概念提问且期间无 self_code", () => {
		it("触发：3 次概念提问后产出 concept_streak", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("什么是闭包？", { behaviorType: "concept", category: "explanation" }))
			monitor.ingest(studentMsg("那作用域链是怎么工作的？", { behaviorType: "concept", category: "explanation" }))
			monitor.ingest(studentMsg("原型链和闭包有什么关系？", { behaviorType: "concept", category: "explanation" }))

			expect(monitor.getLastSoftRuleId()).to.equal("concept_streak")
			expect(softAlerts(monitor, "concept_streak")).to.have.length(1)
		})

		it("不触发：中途自己动手改代码会打断连续计数", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("什么是闭包？", { behaviorType: "concept" }))
			monitor.ingest(studentMsg("作用域链呢？", { behaviorType: "concept" }))
			monitor.ingest(studentSelfCode())
			monitor.ingest(studentMsg("原型链呢？", { behaviorType: "concept" }))

			expect(monitor.getLastSoftRuleId()).to.not.equal("concept_streak")
			expect(softAlerts(monitor, "concept_streak")).to.have.length(0)
		})

		it("冷却：120s 内同一规则只出一条", () => {
			const monitor = newMonitor({ cooldownMs: SOFT_INTERVENTION_COOLDOWN_MS })
			for (let i = 0; i < 3; i++) {
				monitor.ingest(studentMsg(`概念追问 ${i}：这是什么？`, { behaviorType: "concept" }))
			}
			expect(softAlerts(monitor, "concept_streak")).to.have.length(1)

			for (let i = 0; i < 3; i++) {
				monitor.ingest(studentMsg(`概念追问 ${i}：那这又是为什么？`, { behaviorType: "concept" }))
			}
			expect(softAlerts(monitor, "concept_streak")).to.have.length(1)
		})

		it("不影响流程：产出的是普通提示消息，不阻断回合", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("什么是闭包？", { behaviorType: "concept" }))
			monitor.ingest(studentMsg("作用域链呢？", { behaviorType: "concept" }))
			monitor.ingest(studentMsg("原型链呢？", { behaviorType: "concept" }))

			expectNonBlockingMessage(softAlerts(monitor, "concept_streak")[0])
		})
	})

	describe("error_no_progress：error_help 后 5 个请求无保存/自主编码", () => {
		it("触发：报错求助后 5 个请求都没有进展时产出 error_no_progress", () => {
			const monitor = newMonitor()
			monitor.ingest(errorMsg(SAME_ERROR_A))
			for (let i = 0; i < 4; i++) {
				monitor.ingest(studentMsg(`第 ${i} 次追问，还是不行`, { behaviorType: "other" }))
			}
			expect(monitor.getLastSoftRuleId()).to.not.equal("error_no_progress")

			monitor.ingest(studentMsg("第 5 次追问，还是不行", { behaviorType: "other" }))
			expect(monitor.getLastSoftRuleId()).to.equal("error_no_progress")
			expect(softAlerts(monitor, "error_no_progress")).to.have.length(1)
		})

		it("不触发：中途自己动手保存/改代码即视为有进展", () => {
			const monitor = newMonitor()
			monitor.ingest(errorMsg(SAME_ERROR_A))
			for (let i = 0; i < 3; i++) {
				monitor.ingest(studentMsg(`追问 ${i}`, { behaviorType: "other" }))
			}
			monitor.ingest(studentSelfCode())
			for (let i = 0; i < 2; i++) {
				monitor.ingest(studentMsg(`继续追问 ${i}`, { behaviorType: "other" }))
			}

			expect(monitor.getLastSoftRuleId()).to.not.equal("error_no_progress")
			expect(softAlerts(monitor, "error_no_progress")).to.have.length(0)
		})

		it("冷却：120s 内同一规则只出一条", () => {
			const monitor = newMonitor({ cooldownMs: SOFT_INTERVENTION_COOLDOWN_MS })
			monitor.ingest(errorMsg(SAME_ERROR_A))
			for (let i = 0; i < 5; i++) {
				monitor.ingest(studentMsg(`第一轮追问 ${i}`, { behaviorType: "other" }))
			}
			expect(softAlerts(monitor, "error_no_progress")).to.have.length(1)

			monitor.ingest(errorMsg(DIFFERENT_ERROR_B))
			for (let i = 0; i < 5; i++) {
				monitor.ingest(studentMsg(`第二轮追问 ${i}`, { behaviorType: "other" }))
			}
			expect(softAlerts(monitor, "error_no_progress")).to.have.length(1)
		})

		it("不影响流程：产出的是普通提示消息，不阻断回合", () => {
			const monitor = newMonitor()
			monitor.ingest(errorMsg(SAME_ERROR_A))
			for (let i = 0; i < 5; i++) {
				monitor.ingest(studentMsg(`第 ${i} 次追问`, { behaviorType: "other" }))
			}

			expectNonBlockingMessage(softAlerts(monitor, "error_no_progress")[0])
		})
	})

	describe("跨规则约束（BN-37 / 节流 / 分类策略 / 模板兜底）", () => {
		it("BN-37：同一请求命中多条时只出一条，且 full_impl_demand 优先", () => {
			const monitor = newMonitor()
			monitor.ingest(errorMsg(SAME_ERROR_A))
			// 第二个请求：同一个报错（第 2 次）+ 索要完整实现 ⇒ 两条候选，只出 full_impl_demand
			monitor.ingest(studentMsg(`${SAME_ERROR_A}\n给我完整代码`, { behaviorType: "error_help" }))

			expect(monitor.getLastSoftRuleId()).to.equal("full_impl_demand")
			expect(softAlerts(monitor, "full_impl_demand")).to.have.length(1)
			expect(softAlerts(monitor, "same_error_twice")).to.have.length(0)
		})

		it("节流：同一规则在同一学生请求内最多一条", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("帮我补全", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())
			monitor.ingest(studentMsg("继续补全", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())
			monitor.ingest(assistantAiCode())

			expect(softAlerts(monitor, "ai_code_streak")).to.have.length(1)
		})

		it("分类策略：软提示不受「概念问答停用代码类规则」影响（恒启用）", () => {
			for (const ruleId of SOFT_INTERVENTION_RULE_IDS) {
				expect(getSoftRulePolicy(ruleId, "explanation").enabled, `${ruleId} 在概念问答里仍启用`).to.equal(true)
			}
			expect(getRulePolicy("consecutive_code_generation", "explanation").enabled).to.equal(false)
		})

		it("BN-38：软提示模板全部通过文案契约（校验不过时回退模板仍可展示）", () => {
			for (const ruleId of SOFT_INTERVENTION_RULE_IDS) {
				const templates = SOFT_TEMPLATE_REGISTRY[ruleId]
				expect(templates.length, `${ruleId} 至少两条文案`).to.be.greaterThan(0)
				for (const template of templates) {
					const filled = template.template
						.replace(/\{streak\}/g, "3")
						.replace(/\{count\}/g, "3")
						.replace(/\{percent\}/g, "30")
						.replace(/\{threshold\}/g, "3")
					const validation = validateCopy(filled, COPY_CONTEXT)
					expect(validation.ok, `${ruleId}/${template.style} 文案必须通过契约：${validation.reasons.join(",")}`).to.equal(
						true,
					)
				}
			}
		})

		it("full_impl_demand 第 4 次起改用「伪代码」放行模板", () => {
			const monitor = newMonitor()
			for (let i = 0; i < FULL_IMPL_DEMAND_RELEASE_COUNT; i++) {
				monitor.ingest(studentMsg(`给我完整代码（第 ${i + 1} 次）`))
			}
			const alerts = softAlerts(monitor, "full_impl_demand")
			expect(alerts, "每次索要都应该记一条（冷却=0）").to.have.length(FULL_IMPL_DEMAND_RELEASE_COUNT)

			const released = generateInterventionMessage(alerts[alerts.length - 1])
			expect(released.content).to.include("伪代码")
			expectNonBlockingMessage(alerts[alerts.length - 1])
		})

		it("旧日志兼容：无 behaviorType 时按 queryType 回退推断，design_stall 仍可触发", () => {
			const monitor = newMonitor()
			// 旧日志没有 behaviorType：queryType="coding" 在 resolveBehaviorType 里回退映射为 design
			monitor.ingest(studentMsg("这段代码怎么设计？", { queryType: "coding" }))
			monitor.ingest(studentMsg("模块怎么拆？", { queryType: "coding" }))
			monitor.ingest(studentMsg("接口怎么定？", { queryType: "coding" }))

			expect(monitor.getLastSoftRuleId()).to.equal("design_stall")
		})

		it("未命中任何软规则时不应误报", () => {
			const monitor = newMonitor()
			monitor.ingest(studentMsg("帮我看下这段代码为什么输出不对", { behaviorType: "design" }))
			monitor.ingest(assistantAiCode())
			monitor.ingest(studentSelfCode())

			expect(monitor.getLastSoftRuleId()).to.equal(null)
			expect(monitor.getPendingAlerts().filter((alert) => SOFT_INTERVENTION_RULE_IDS.includes(alert.ruleId as SoftInterventionRuleId))).to.have.length(0)
		})
	})
})
