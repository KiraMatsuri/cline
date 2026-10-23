/**
 * 【P2-2】阻断式干预已整体移除 —— 本文件守护「不存在阻断路径」。
 *
 * 原文件（P6/T2）断言「阻断分支以 ask 挂起 + return true 结束、幂等键 = 学生请求序号」；
 * P2-2 删除阻断后，同一份测试改为**反向断言**：
 * - `task/index.ts` 不再有阻断回合（`isBlockingActive` / `blockingNoticeRequestKey` / 阻断 ask / `return true` 早退）；
 * - `student-analytics` 四个模块不再有 `*blocking*` 成员/文案/白名单；
 * - 回合编排纯函数不再接受 `isBlocking`（旧「阻断例外」已删）；
 * - 前端不再有 `TeachingBlockingBanner` / `teachingBlocking` 横幅渲染路径。
 *
 * 注意：`types.ts` 的 `InterventionType = "normal" | "blocking"` 仍保留（旧日志读取兼容），
 * 本文件只断言**代码路径**不存在，不要求历史日志字段消失。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { planInterventionTurn } from "../interventionTurnPlan"

const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")
const analyticsDir = path.join(__dirname, "..")
const repoRoot = path.join(__dirname, "..", "..", "..", "..", "..")
const readAnalytics = (file: string): string => fs.readFileSync(path.join(analyticsDir, file), "utf-8")
const readRepo = (...segments: string[]): string => fs.readFileSync(path.join(repoRoot, ...segments), "utf-8")

/** 被 P2-2 清理的四个模块（阻断相关成员/常量/文案都必须消失） */
const PURGED_MODULES = [
	"TeachingInterventionManager.ts",
	"InterventionMessageGenerator.ts",
	"rulePolicy.ts",
	"BehaviorMonitor.ts",
]

describe("【P2-2】阻断式干预已移除（blocking / intervention）", () => {
	it("★ 结构：task/index.ts 不存在阻断回合与阻断文案（blocking）", () => {
		expect(taskSrc, "阻断态检查分支必须删除").to.not.include("isBlockingActive")
		expect(taskSrc, "阻断幂等键必须删除").to.not.include("blockingNoticeRequestKey")
		expect(taskSrc, "阻断文案脱敏函数必须不再被引用").to.not.include("toStudentVisibleBlockingText")
		expect(taskSrc, "阻断挂起回合必须删除").to.not.include('await this.ask("followup", blockingText)')
		expect(taskSrc, "阻断日志必须删除").to.not.include("BLOCKING ENFORCED")
	})

	it("★ 结构：教学干预段不存在 return true 早退（intervention）", () => {
		const start = taskSrc.indexOf("// ========== 教学干预检查 ==========")
		expect(start, "教学干预检查段必须存在").to.be.greaterThan(-1)
		const end = taskSrc.indexOf("} catch (error) {", start)
		expect(end, "教学干预检查段必须仍有 catch 收口").to.be.greaterThan(start)
		const block = taskSrc.slice(start, end)
		expect(block, "干预段不得存在阻断式 return true（结束回合）").to.not.include("return true")
		expect(block, "干预段不得存在阻断式 ask 挂起").to.not.include('ask("followup"')
	})

	it("★ 结构：student-analytics 四个模块不再有 *blocking* 成员/文案/白名单（blocking）", () => {
		for (const file of PURGED_MODULES) {
			const source = readAnalytics(file)
			expect(source, `${file} 不得再出现 blocking（成员/常量/文案）`).to.not.match(/blocking/i)
		}
	})

	it("★ 纯函数：回合级编排矩阵不再接受 isBlocking（intervention）", () => {
		expect(planInterventionTurn({ carryOverHint: false, hasDecision: true })).to.deep.equal({
			inject: true,
			overwritePending: true,
		})
		expect(planInterventionTurn({ carryOverHint: true, hasDecision: true })).to.deep.equal({
			inject: true,
			overwritePending: false,
		})
		expect(planInterventionTurn({ carryOverHint: false, hasDecision: false })).to.deep.equal({
			inject: false,
			overwritePending: false,
		})
		// 纯函数源码层面也不得再保留阻断例外
		expect(readAnalytics("interventionTurnPlan.ts")).to.not.include("isBlocking")
	})

	it("★ 前端：不存在阻断横幅组件与 teachingBlocking 状态渲染路径（blocking banner）", () => {
		expect(fs.existsSync(path.join(repoRoot, "webview-ui", "src", "components", "chat", "TeachingBlockingBanner.tsx"))).to.equal(
			false,
			"TeachingBlockingBanner.tsx 必须整文件删除",
		)
		expect(readRepo("webview-ui", "src", "components", "chat", "ChatView.tsx")).to.not.include("TeachingBlockingBanner")
		expect(readRepo("src", "shared", "ExtensionMessage.ts")).to.not.include("teachingBlocking")
		expect(readRepo("webview-ui", "src", "context", "ExtensionStateContext.tsx")).to.not.include("teachingBlocking")
	})
})
