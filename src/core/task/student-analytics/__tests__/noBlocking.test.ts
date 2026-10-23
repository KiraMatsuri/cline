/**
 * 【P2-2】阻断式干预删除后的「不存在」契约（noBlocking）
 *
 * 背景：`docs/design/teaching-modes-and-behavior-metrics-plan.md` P2-2 决定整体删除阻断式干预。
 * 本文件是这次删除的**契约测试**——它断言的不是「某个阻断行为怎样」，而是「阻断能力确实不存在」：
 *
 *  1. 导出面：`student-analytics` 及四个相关模块不再导出任何 `*blocking*` 符号；
 *  2. 运行时：BehaviorMonitor / TeachingInterventionManager 的原型与静态成员上不再有阻断方法；
 *  3. 配置面：两个 `DEFAULT_OPTIONS` 不再接受阻断参数（含 `@ts-expect-error` 类型层契约）；
 *  4. 策略面：`RulePolicy` 只剩 `{ enabled }`，不再有 `canEscalateToBlocking`/白名单；
 *  5. 文案面：生成的普通/软提示 `interventionType` 恒为 `"normal"`，正文不含阻断文案与阻断字段；
 *  6. 源码面：被清理的五个模块（含 `types.ts`）注释里也不再有 `blocking`，`task/index.ts` 无阻断代码路径。
 *
 * 注意：`interventionDisplay.ts` 仍保留 `"blocking_template"` **字面量**（旧日志读取兼容），
 * 因此该文件不做 `blocking` 全量扫描，只断言死导出已删除且该字面量被保留。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import * as analytics from "../index"
import { BehaviorMonitor, DEFAULT_OPTIONS as MONITOR_DEFAULTS } from "../BehaviorMonitor"
import * as interventionDisplay from "../interventionDisplay"
import * as messageGenerator from "../InterventionMessageGenerator"
import { generateInterventionMessage, generateSoftInterventionMessage } from "../InterventionMessageGenerator"
import * as rulePolicy from "../rulePolicy"
import { getRulePolicy, SOFT_INTERVENTION_RULE_IDS } from "../rulePolicy"
import { TeachingInterventionManager, DEFAULT_OPTIONS as MANAGER_DEFAULTS } from "../TeachingInterventionManager"
import type { BehaviorAlert, BehaviorRuleId, TaskCategory } from "../types"
import { editEv, ev } from "./__fixtures__/events"

const analyticsDir = path.join(__dirname, "..")
const repoRoot = path.join(__dirname, "..", "..", "..", "..", "..")
const readAnalytics = (file: string): string => fs.readFileSync(path.join(analyticsDir, file), "utf-8")
const runtimeProp = (obj: object, key: string): unknown => (obj as unknown as Record<string, unknown>)[key]

/** P2-2 清理过的模块（连同注释都不得再出现 blocking） */
const PURGED_MODULES = [
	"BehaviorMonitor.ts",
	"TeachingInterventionManager.ts",
	"InterventionMessageGenerator.ts",
	"rulePolicy.ts",
	"types.ts",
]

/** P2-2 删除的实例成员（管理器 + 监测器 + 消息生成器） */
const DELETED_INSTANCE_MEMBERS = [
	"shouldEscalateToBlocking",
	"getRuleIdsAtBlockingThreshold",
	"getBlockingThresholdFor",
	"getEscalationBlockingThreshold",
	"markBlockingTriggered",
	"isBlockingActive",
	"getBlockingEndsAt",
	"getGlobalBlockingState",
	"getBlockingReminderMessage",
	"triggerBlocking",
	"generateBlockingInterventionMessage",
]

/** 全部规则 × 全部分类的交叉矩阵（RulePolicy 必须对每一种组合都只有 enabled） */
const ALL_RULE_IDS: readonly BehaviorRuleId[] = [
	"consecutive_code_generation",
	"no_edit_streak",
	"high_adoption_low_self_modification",
	"high_recent_ai_dependency",
	"complete_impl_demand",
	"ai_coding_rounds",
	"design_stall",
	"same_error_twice",
	"full_impl_demand",
	"ai_code_streak",
	"concept_streak",
	"error_no_progress",
]
const ALL_CATEGORIES: readonly (TaskCategory | undefined)[] = [
	"code_generation",
	"debugging",
	"refactoring",
	"testing",
	"explanation",
	"algorithm",
	"language_request",
	"other",
	undefined,
]

const alertOf = (ruleId: BehaviorRuleId): BehaviorAlert => ({
	ruleId,
	message: "测试警报",
	triggeredAt: new Date().toISOString(),
	metricValue: 3,
	threshold: 3,
	escalationCount: 1,
})

/** 造出「AI 落盘 3 次」的局面（ai_coding_rounds 计数达到 3，会入队一条普通警报） */
const monitorWithAiCodingRounds = (): BehaviorMonitor => {
	const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
	for (let i = 0; i < 3; i++) {
		m.ingest(ev({ eventType: "turn_message", role: "user", hasCode: false, hasCodeBlock: false, rawContent: `第 ${i + 1} 次：直接写进文件` }))
		m.ingest(editEv({ editor: "ai" }))
	}
	return m
}

describe("【P2-2】阻断式干预已删除：不存在性契约（noBlocking）", () => {
	it("① 导出面：student-analytics 与四个模块不再导出任何 blocking 符号", () => {
		for (const key of Object.keys(analytics)) {
			expect(key, `统一导出不应再有 blocking 符号：${key}`).to.not.match(/blocking/i)
		}
		for (const key of Object.keys(messageGenerator)) {
			expect(key, `消息生成器不应再导出 blocking 符号：${key}`).to.not.match(/blocking/i)
		}
		for (const key of Object.keys(rulePolicy)) {
			expect(key, `规则策略不应再导出 blocking 符号：${key}`).to.not.match(/blocking/i)
		}
		expect("generateBlockingInterventionMessage" in messageGenerator).to.equal(false)
	})

	it("② 运行时：两个类的原型/静态/实例上都不再有阻断成员", () => {
		for (const klass of [BehaviorMonitor, TeachingInterventionManager]) {
			for (const name of Object.getOwnPropertyNames(klass.prototype)) {
				expect(name, `${klass.name} 原型上不应再有阻断方法：${name}`).to.not.match(/blocking/i)
			}
			for (const name of Object.getOwnPropertyNames(klass)) {
				expect(name, `${klass.name} 静态成员上不应再有阻断入口：${name}`).to.not.match(/blocking/i)
			}
		}

		const monitor = new BehaviorMonitor("t1")
		const manager = new TeachingInterventionManager("t1")
		for (const member of DELETED_INSTANCE_MEMBERS) {
			expect(runtimeProp(monitor, member), `BehaviorMonitor 不应再有 ${member}`).to.equal(undefined)
			expect(runtimeProp(manager, member), `TeachingInterventionManager 不应再有 ${member}`).to.equal(undefined)
		}
	})

	it("③ 配置面：DEFAULT_OPTIONS 不再含阻断参数（含 @ts-expect-error 类型契约）", () => {
		for (const key of Object.keys(MONITOR_DEFAULTS)) {
			expect(key, `BehaviorMonitorOptions 不应再有阻断参数：${key}`).to.not.match(/blocking/i)
		}
		for (const key of Object.keys(MANAGER_DEFAULTS)) {
			expect(key, `InterventionManagerOptions 不应再有阻断参数：${key}`).to.not.match(/blocking/i)
		}
		expect("escalationBlockingThreshold" in MONITOR_DEFAULTS).to.equal(false)
		expect("aiCodingBlockingThreshold" in MONITOR_DEFAULTS).to.equal(false)
		expect("blockingCooldownMs" in MANAGER_DEFAULTS).to.equal(false)

		// @ts-expect-error 【P2-2】阻断阈值参数已删除，类型层面必须拒绝
		new BehaviorMonitor("t1", { escalationBlockingThreshold: 3 })
		// @ts-expect-error 【P2-2】阻断冷却参数已删除，类型层面必须拒绝
		new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
	})

	it("④ 策略面：RulePolicy 只剩 { enabled }，不存在 canEscalateToBlocking / 白名单", () => {
		expect("BLOCKING_CAPABLE_RULES" in rulePolicy).to.equal(false)
		expect("canEscalateToBlocking" in rulePolicy).to.equal(false)
		for (const ruleId of ALL_RULE_IDS) {
			for (const category of ALL_CATEGORIES) {
				const policy = getRulePolicy(ruleId, category)
				expect(Object.keys(policy), `RulePolicy 只能有 enabled 字段（${ruleId}/${category}）`).to.deep.equal(["enabled"])
				expect(policy).to.not.have.property("canEscalateToBlocking")
				expect(policy.enabled).to.be.a("boolean")
			}
		}
	})

	it("⑤ 源码面：五个被清理模块（含注释）不再出现 blocking", () => {
		for (const file of PURGED_MODULES) {
			const source = readAnalytics(file)
			expect(source, `${file} 不应再残留 blocking（含注释/历史兼容说明）`).to.not.match(/blocking/i)
		}
	})

	it("⑥ 展示层：阻断脱敏死导出已删除，历史日志字面量按设计保留", () => {
		expect("toStudentVisibleBlockingText" in interventionDisplay).to.equal(false)
		expect("INJECTION_WRAPPER_RE" in interventionDisplay).to.equal(false)
		expect("INTERNAL_INSTRUCTION_MARKER" in interventionDisplay).to.equal(false)
		const displaySource = readAnalytics("interventionDisplay.ts")
		expect(displaySource).to.not.include("toStudentVisibleBlockingText")
		expect(displaySource).to.not.include("INJECTION_WRAPPER_RE")
		expect(displaySource).to.not.include("INTERNAL_INSTRUCTION_MARKER")
		// 旧日志读取兼容：blocking_template 字面量必须保留
		expect(displaySource).to.include('"blocking_template"')
	})

	it("⑦ 文案面：普通干预消息恒为 normal，且不含阻断正文/阻断字段", () => {
		const alert = alertOf("ai_coding_rounds")
		const message = generateInterventionMessage(alert, "hint")
		expect(message.interventionType).to.equal("normal")
		expect(message.severity).to.be.oneOf(["gentle", "moderate", "strong"])
		expect(message.content).to.not.include("阻断")
		expect(message.content).to.not.include("🚫")
		for (const blockedField of ["disabledFeatures", "countdownSeconds", "blockingEndAt", "reflectionQuestions"]) {
			expect(message, `InterventionMessage 不应再有阻断字段 ${blockedField}`).to.not.have.property(blockedField)
		}
	})

	it("⑧ 文案面：软提示恒为 gentle + normal（hint/question），永不阻断", () => {
		for (const ruleId of SOFT_INTERVENTION_RULE_IDS) {
			const message = generateSoftInterventionMessage(alertOf(ruleId))
			expect(message.interventionType).to.equal("normal")
			expect(message.severity).to.equal("gentle")
			expect(message.style).to.be.oneOf(["hint", "question"])
			expect(message.content).to.not.include("阻断")
		}
	})

	it("⑨ 决策面：AI 落盘 3 次后的干预决策恒为普通提示，不存在阻断态", () => {
		const monitor = monitorWithAiCodingRounds()
		expect(monitor.getAiCodingCount()).to.equal(3)

		const manager = new TeachingInterventionManager("t1", { globalCooldownMs: 0 })
		const decision = manager.checkAndGenerateInterventionDecision(monitor, 3)
		expect(decision, "计数达阈值后应给出普通提示").to.not.equal(null)
		expect(decision?.interventionType).to.equal("normal")
		expect(decision?.severity).to.be.oneOf(["gentle", "moderate", "strong"])
		expect(decision?.injectionText ?? "").to.not.include("阻断模式")
		expect(decision?.templateText ?? "").to.not.include("阻断模式")
		expect(runtimeProp(manager, "isBlockingActive")).to.equal(undefined)
	})

	it("⑩ 源码面：task/index.ts 不存在阻断回合/阻断文案/阻断脱敏调用", () => {
		const taskSrc = fs.readFileSync(path.join(repoRoot, "src", "core", "task", "index.ts"), "utf-8")
		for (const symbol of [
			"isBlockingActive",
			"blockingNoticeRequestKey",
			"toStudentVisibleBlockingText",
			"generateBlockingInterventionMessage",
			"shouldEscalateToBlocking",
			'decision.interventionType === "blocking"',
		]) {
			expect(taskSrc, `task/index.ts 不应再出现 ${symbol}`).to.not.include(symbol)
		}
	})
})
