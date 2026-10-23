/**
 * 【P6/T1】两处实测缺陷的守卫（结构断言，见 plan-2 §12.6）：
 *  ① 记账去重键含 `apiRequestCount` ⇒ 干预回合被 Cline 记 mistake 重试时每次都换键，
 *     同一条学生消息落了 3 对 D/T（实测 13:01:18–13:01:28 共 9 对）。
 *  ② `needDecision = !carryOverHint || ...` ⇒ 顺延重投的回合**整轮跳过**干预决策与记账，
 *     导致"计数已达阈值却不提示"（实测 13:00:20 / 13:00:49 与 13:06:26 / 13:06:49 各一次）。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { buildInterventionAccountKey } from "../interventionAccounting"

const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")

describe("【P6/T1】记账键与顺延重投的结构不变量", () => {
	it("★ 纯函数：键 = taskId : 学生请求数 : 种类（同请求幂等、跨请求不同、种类不同）", () => {
		expect(buildInterventionAccountKey("t1", 1, "decision")).to.equal("t1:1:decision")
		expect(buildInterventionAccountKey("t1", 1, "copy")).to.equal("t1:1:copy")
		// 同一条学生消息被重试多次 ⇒ 键不变（这正是幂等的根据）
		expect(buildInterventionAccountKey("t1", 3, "decision")).to.equal(buildInterventionAccountKey("t1", 3, "decision"))
		// 学生在冷却期又发消息 ⇒ 键变化 ⇒ 仍会正常记一条
		expect(buildInterventionAccountKey("t1", 4, "decision")).to.not.equal(buildInterventionAccountKey("t1", 3, "decision"))
	})

	it("★ 接线：index.ts 用纯函数构造键；且不再含逐次重试都会变的 apiRequestCount", () => {
		expect(taskSrc).to.include("buildInterventionAccountKey(this.taskId, studentRequests, kind)")
		expect(/apiRequestCount\}:\$\{studentRequests\}/.test(taskSrc)).to.equal(false)
	})

	it("★ 顺延重投的回合不得跳过干预决策（needDecision 门控必须消失）", () => {
		expect(taskSrc).to.not.include("const needDecision = !carryOverHint")
		// 决策必须始终被应用：注入文本写入 pendingInterventionText
		expect(taskSrc).to.include("this.pendingInterventionText = decision.injectionText")
		// 不存在阻断式的应用分支（阻断能力已整体删除）
		expect(taskSrc).to.not.include('decision.interventionType === "blocking"')
	})
})
