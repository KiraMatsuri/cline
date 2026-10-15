/**
 * 【P6/T9】b+c 服从流程（用户 2026-10-14 裁定）：
 *  - 仅当学生**明确表示自己写不出**才进入服从流程（"请提供完整实现"不算 —— 那是索要，不是自述能力不足）；
 *  - 先**询问一次**，询问文案必须含"连续 3 次直接编码会触发阻断"的告知；
 *  - 确认后本轮给出完整实现（豁免概念护栏与拒答约束）；否认则回引导态；
 *  - 服从态**仅本轮**（下一个学生请求自动复位）。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { isAffirmation, isInabilityStatement } from "../inabilityDetect"
import { buildInterventionAccountKey } from "../interventionAccounting"
import type { StudentInteractionLog } from "../types"
import { ev } from "./__fixtures__/events"

const ask = (raw: string, category: StudentInteractionLog["category"] = "code_generation"): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", category, hasCode: false, hasCodeBlock: false, rawContent: raw })

const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")

/**
 * 【P6/T9 fix F1】取 `src` 里 [start, end) 的切片。
 * 锚点缺失/顺序颠倒直接抛错 —— 否则断言会在空串上**恒真**（结构断言最常见的假绿来源）。
 */
const sliceBetween = (src: string, start: string, end: string): string => {
	const from = src.indexOf(start)
	const to = src.indexOf(end, from + start.length)
	if (from < 0 || to <= from) {
		throw new Error(`slice anchors not found: from=${from} to=${to} (start=${start})`)
	}
	return src.slice(from, to)
}

describe("【P6/T9】b+c 服从流程", () => {
	it("★ (b) 判定：自述写不出才算；索要完整实现不算", () => {
		for (const t of ["我不会写", "我实在写不出来", "我写不出来", "我看不懂这段", "我完全没有思路", "你别问了直接给我"]) {
			expect(isInabilityStatement(t), t).to.equal(true)
		}
		for (const t of ["请提供完整实现", "帮我实现完整的冒泡排序程序", "什么是冒泡排序", ""]) {
			expect(isInabilityStatement(t), t).to.equal(false)
		}
	})

	it("★ (c) 确认判定保守", () => {
		for (const t of ["是", "好", "可以", "可以，谢谢", "给我", "就这样"]) {
			expect(isAffirmation(t), t).to.equal(true)
		}
		for (const t of ["不是", "先不要", "我自己写", "为什么"]) {
			expect(isAffirmation(t), t).to.equal(false)
		}
	})

	it("★ 询问文案必须告知「3 次直接编码会触发阻断」", () => {
		const src = fs.readFileSync(path.join(__dirname, "..", "..", "..", "teaching", "conceptModeConstraint.ts"), "utf-8")
		expect(src).to.include("DEMAND_COMPLIANCE_ASK_TEXT")
		expect(src).to.match(/连续\s*3\s*次直接编码/)
		expect(src).to.include("阻断式干预")
	})

	it("★ 状态机：none → asked → granted；下一个学生请求复位为 none", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ask("我不会写，你直接给我吧"))
		expect(m.isCurrentRequestInability()).to.equal(true)
		expect(m.getDemandComplianceState()).to.equal("none")

		m.markDemandComplianceAsked()
		expect(m.getDemandComplianceState()).to.equal("asked")

		m.markDemandComplianceGranted()
		expect(m.getDemandComplianceState()).to.equal("granted")

		m.ingest(ask("那再讲讲选择排序")) // 新的学生请求
		expect(m.getDemandComplianceState()).to.equal("none")
		expect(m.isCurrentRequestInability()).to.equal(false)
	})

	it("★ 结构：服从轮不再注入概念护栏与拒答约束，改注入服从约束；且只询问一次", () => {
		expect(taskSrc).to.include("buildDemandComplianceConstraint()")
		expect(taskSrc).to.include('getDemandComplianceState() === "granted"')
		expect(taskSrc).to.include('getDemandComplianceState() === "none"')
		expect(taskSrc).to.include('await this.ask("followup", DEMAND_COMPLIANCE_ASK_TEXT)')
		expect(taskSrc).to.include('this.persistDemandComplianceEvent("asked")')
		expect(taskSrc).to.include('this.persistDemandComplianceEvent("granted")')
		expect(taskSrc).to.include('this.persistDemandComplianceEvent("denied")')
	})

	it("★ (fix F1) 否认后同一学生请求内不再重问；新学生请求才复位", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ask("我不会写，你直接给我吧"))
		expect(m.isCurrentRequestInability()).to.equal(true)

		m.markDemandComplianceAsked()
		m.markDemandComplianceDenied()
		expect(m.getDemandComplianceState()).to.equal("denied")

		// 同一学生请求内的助手事件（工具轮续写 / 首 chunk 重试 = `attemptApiRequest` 再次进入）：
		// `denied` 是**终态**，不得被打回 "none"（否则询问块门控重新武装 ⇒ 每隔一轮重问一次，
		// 且答复被 `ask` 吞掉、请求身份不变 ⇒ 学生无法自行脱离）
		m.ingest(ev({ eventType: "turn_message", role: "assistant", rawContent: "好的，我先读一下这个文件。" }))
		expect(m.getDemandComplianceState()).to.equal("denied")
		expect(m.isCurrentRequestInability()).to.equal(true)

		// 新的学生请求：终态复位，重新可问
		m.ingest(ask("那再讲讲选择排序"))
		expect(m.getDemandComplianceState()).to.equal("none")
		expect(m.isCurrentRequestInability()).to.equal(false)
	})

	it("★ (fix F1) 中止不卡死：ask 抛错路径落 `denied`，不停在 `asked`", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(ask("我实在写不出来"))
		m.markDemandComplianceAsked()
		expect(m.getDemandComplianceState()).to.equal("asked")
		// 接口语义：终态收敛到 `denied`（`index.ts` 的 catch 分支对真实 `ask` 抛错走同一动作）
		m.markDemandComplianceDenied()
		expect(m.getDemandComplianceState()).to.equal("denied")
		expect(m.getDemandComplianceState()).to.not.equal("asked")

		// 结构：`await this.ask(...)` 在 try 内，catch 分支落 `denied` 终态 + 记一条 `denied`
		const askBlock = sliceBetween(taskSrc, "const complianceMonitor = this.getBehaviorMonitor()", "const complianceGranted")
		expect(askBlock).to.include("try {")
		expect(askBlock).to.include('await this.ask("followup", DEMAND_COMPLIANCE_ASK_TEXT)')
		const catchIndex = askBlock.indexOf("} catch (error) {")
		expect(catchIndex, "询问块缺少 catch 分支").to.be.greaterThan(-1)
		const catchBranch = askBlock.slice(catchIndex)
		expect(catchBranch).to.include("markDemandComplianceDenied()")
		expect(catchBranch).to.include('this.persistDemandComplianceEvent("denied")')
		// 否认/中止路径**不再**回落到 `"none"`（`resetDemandCompliance()` 会让门控在同一请求内重新武装）
		expect(askBlock).to.not.include("resetDemandCompliance()")
		expect(taskSrc).to.include("markDemandComplianceDenied()")
	})

	it("★ (fix F1) 记账去重：`persistDemandComplianceEvent` 经过 `interventionAccountKey`", () => {
		// 记账去重键：kind 联合已扩为 decision/copy/compliance
		expect(taskSrc).to.include("private lastComplianceAccountKey: string | undefined")
		expect(taskSrc).to.include('kind: "decision" | "copy" | "compliance"')

		const persist = sliceBetween(taskSrc, "private persistDemandComplianceEvent(", "\n\tprivate ")
		// ⚠️ 键里额外带 `decision`（≠ brief 示例的 `this.interventionAccountKey("compliance")`）：
		// `asked` 与其后的 `granted`/`denied` 同属一个学生请求，共用一把键会把后者的记录一并吞掉，
		// 与「三态各记一次」冲突。故断言前缀（两种写法都覆盖）+ 实际形态。
		expect(persist).to.include('this.interventionAccountKey("compliance"')
		expect(persist).to.include('this.interventionAccountKey("compliance", decision)')
		expect(persist).to.include("demandCompliance: decision")
		// 键 = `taskId : 学生请求数 : kind`（`kind` 已支持 compliance）
		expect(buildInterventionAccountKey("t1", 1, "compliance")).to.equal("t1:1:compliance")
		expect(buildInterventionAccountKey("t1", 2, "compliance")).to.not.equal(
			buildInterventionAccountKey("t1", 1, "compliance"),
		)
	})
})
