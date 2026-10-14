/**
 * 【P6/T2】阻断回合 `return false` 会被 `initiateTaskLoop` 当成"模型没用工具"⇒ `consecutiveMistakeCount++`
 * ⇒ 重新进入生成器 ⇒ 再展示一次阻断、再记一对 D/T；3 次后还会冒出「AI 连续 3 次没能正确调用工具」。
 * 实测证据：13:01:18–13:01:28 与 13:07:04–13:07:05 各 3 对 D/T（会话里共 9 对）。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { planInterventionTurn } from "../interventionTurnPlan"

// ⚠️ 本文件**不**用 `__dirname`：若它只有 `node:`/裸包导入（没有相对导入），Node 24 的原生 TS 支持会把它
// 当 **ESM** 装载（`__dirname` 未定义 ⇒ 装载期就崩）。`npm run test:unit` 恒以仓库根为工作目录。
const taskSrc = fs.readFileSync(path.join(process.cwd(), "src", "core", "task", "index.ts"), "utf-8")

describe("【P6/T2】阻断回合幂等", () => {
	it("★ 结构：阻断分支以 return true 结束，并有幂等键", () => {
		expect(taskSrc).to.include("blockingNoticeRequestKey")
		// 阻断分支内部不得再用 return false（那会被当成 mistake 重试）
		const start = taskSrc.indexOf("BLOCKING ENFORCED")
		const block = taskSrc.slice(start, start + 900)
		expect(block).to.include("return true")
		expect(block).to.not.include("return false")
	})

	it("★ 结构：阻断文案展示前脱敏；幂等键取自学生请求序号（重试期间不变）", () => {
		expect(taskSrc).to.include("toStudentVisibleBlockingText(rawBlockingText)")
		// 键若含 apiRequestCount 就会随每次 mistake 重试而变 ⇒ 又变回"一条消息展示 3 次"
		const requestKeyRe = /const requestKey = `\$\{this\.taskId\}:\$\{monitor\?\.getStudentRequestCount\(\) \?\? 0\}`/
		expect(requestKeyRe.test(taskSrc), "阻断幂等键必须来自学生请求序号").to.equal(true)
	})

	it("★ 结构：顺延回合不覆盖待投递文案（普通分支以 plan.overwritePending 门控）", () => {
		expect(taskSrc).to.include("if (decision && plan.overwritePending)")
	})

	it("★ 纯函数：回合级编排矩阵", () => {
		expect(planInterventionTurn({ carryOverHint: false, hasDecision: true, isBlocking: false })).to.deep.equal({
			inject: true,
			overwritePending: true,
			accountDecision: true,
		})
		expect(planInterventionTurn({ carryOverHint: true, hasDecision: true, isBlocking: false })).to.deep.equal({
			inject: true,
			overwritePending: false,
			accountDecision: false,
		})
		expect(planInterventionTurn({ carryOverHint: true, hasDecision: true, isBlocking: true })).to.deep.equal({
			inject: true,
			overwritePending: true,
			accountDecision: true,
		})
		expect(planInterventionTurn({ carryOverHint: false, hasDecision: false, isBlocking: false })).to.deep.equal({
			inject: false,
			overwritePending: false,
			accountDecision: false,
		})
	})
})
