/**
 * 【P6/T2】阻断回合的幂等与挂起语义。
 *
 * 背景（实测证据）：阻断回合原本以 `return false` 结束 ⇒ `initiateTaskLoop` 把它当成“模型没用工具”
 * ⇒ `consecutiveMistakeCount++` ⇒ 重新进入生成器 ⇒ 再展示一次阻断、再记一对 D/T；3 次后还会冒出
 * 「AI 连续 3 次没能正确调用工具」。实测 13:01:18–13:01:28 与 13:07:04–13:07:05 各 3 对 D/T（会话共 9 对）。
 *
 * 现行为：阻断分支用 `ask("followup")` **挂起**（通知交付给学生 + 学生这条消息当场被收下），
 * 随后 `return true` 结束本轮。幂等键 = 学生请求序号（不含 `apiRequestCount`）。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { planInterventionTurn } from "../interventionTurnPlan"

// 【P6/T2 fix】回到仓库惯例 `__dirname`。本文件有无扩展名的相对导入（上一行）⇒ ESM 解析
// `ERR_MODULE_NOT_FOUND` ⇒ mocha 回落到 `require`（ts-node CJS）⇒ `__dirname` 可用。
const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")

describe("【P6/T2】阻断回合幂等", () => {
	it("★ 结构：阻断分支以 ask 挂起 + return true 结束，并有幂等键", () => {
		expect(taskSrc).to.include("blockingNoticeRequestKey")
		// 【P6/T2 fix2】按**分支边界**取切片，切片严格限制在阻断分支内：
		// 末端锚取阻断分支之后**紧跟**的普通提醒分支注释 `// 普通干预：`（不再取远在 catch 之后的 `// 【F7】`，
		// 那会让否定断言面横跨普通分支与 catch ⇒ 普通分支新增 `return false` 就会造成假失败）。
		const start = taskSrc.indexOf("if (interventionManager.isBlockingActive()) {")
		expect(start, "阻断分支必须存在").to.be.greaterThan(-1)
		const end = taskSrc.indexOf("// 普通干预：", start)
		expect(end, "阻断分支之后必须紧跟普通提醒分支的注释锚点").to.be.greaterThan(start)
		const block = taskSrc.slice(start, end)
		expect(block).to.include('await this.ask("followup", blockingText)')
		expect(block).to.include("return true")
		expect(block).to.not.include("return false")
	})

	it("★ 结构：阻断文案展示前脱敏；幂等键取自学生请求序号（不含 apiRequestCount）", () => {
		expect(taskSrc).to.include("toStudentVisibleBlockingText(rawBlockingText)")
		// 键若含 apiRequestCount 就会随每次助手重试而变 ⇒ 又变回“一条消息展示多次”
		expect(taskSrc, "阻断幂等键必须来自学生请求序号").to.include(
			"const requestKey = String(monitor?.getStudentRequestCount() ?? 0)",
		)
	})

	it("★ 结构：顺延回合不覆盖待投递文案（普通分支以 plan.overwritePending 门控）", () => {
		expect(taskSrc).to.include("if (decision && plan.overwritePending)")
	})

	it("★ 纯函数：回合级编排矩阵", () => {
		expect(planInterventionTurn({ carryOverHint: false, hasDecision: true, isBlocking: false })).to.deep.equal({
			inject: true,
			overwritePending: true,
		})
		expect(planInterventionTurn({ carryOverHint: true, hasDecision: true, isBlocking: false })).to.deep.equal({
			inject: true,
			overwritePending: false,
		})
		expect(planInterventionTurn({ carryOverHint: true, hasDecision: true, isBlocking: true })).to.deep.equal({
			inject: true,
			overwritePending: true,
		})
		expect(planInterventionTurn({ carryOverHint: false, hasDecision: false, isBlocking: false })).to.deep.equal({
			inject: false,
			overwritePending: false,
		})
	})
})
