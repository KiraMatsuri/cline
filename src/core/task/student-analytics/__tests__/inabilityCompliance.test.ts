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
import type { StudentInteractionLog } from "../types"
import { ev } from "./__fixtures__/events"

const ask = (raw: string, category: StudentInteractionLog["category"] = "code_generation"): StudentInteractionLog =>
	ev({ eventType: "turn_message", role: "user", category, hasCode: false, hasCodeBlock: false, rawContent: raw })

const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")

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
})
