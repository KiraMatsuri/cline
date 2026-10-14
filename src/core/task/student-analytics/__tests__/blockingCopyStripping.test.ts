/**
 * 【P6/T3】实测（会话原文）：阻断提示把注入包裹 `‹teaching_intervention rule="…" …›` 与
 * 内部指令（"请在你的回复中严格执行以下要求: 1. 首先显示上述阻断通知…"）**原样展示给了学生**。
 * 注入文本是给模型的，不是给学生看的。
 */
import { expect } from "chai"
import { toStudentVisibleBlockingText } from "../interventionDisplay"

const INJECTION = [
	'<teaching_intervention rule="complete_impl_demand" severity="strong" style="blocking" interventionType="blocking">',
	"🚫 【教学干预 — 阻断模式】",
	"",
	"系统检测到……",
	"",
	"⚠️ 已禁用功能: code_generation, tool_execution",
	"⏳ 冷却倒计时: 1 分钟",
	"",
	"📝 反思练习:",
	"  1. 你最近连续请求了代码生成……",
	"",
	"请在你的回复中严格执行以下要求:",
	"1. 首先显示上述阻断通知和禁用信息",
	"2. 然后呈现反思练习问题",
	"3. 不要提供任何代码生成或工具执行的帮助",
	"4. 只回答反思相关的问题，鼓励学生独立思考和实践",
	"</teaching_intervention>",
].join("\n")

describe("【P6/T3】阻断文案脱敏", () => {
	it("★ 去掉包裹标签与内部指令段，保留对学生有意义的内容", () => {
		const out = toStudentVisibleBlockingText(INJECTION)
		expect(out).to.not.include("teaching_intervention")
		expect(out).to.not.include("请在你的回复中严格执行")
		expect(out).to.not.include("首先显示上述阻断通知")
		expect(out).to.include("🚫 【教学干预 — 阻断模式】")
		expect(out).to.include("已禁用功能")
		expect(out).to.include("反思练习")
	})

	it("★ 无包裹的文案（冷却期提醒）逐字返回（去除首尾空白）", () => {
		const plain = "⏳ 【阻断冷却中 — 剩余 0 分 51 秒】\n\n系统仍处于阻断模式。"
		expect(toStudentVisibleBlockingText(`\n${plain}\n`)).to.equal(plain)
	})

	it("★ 幂等：重复调用结果不变", () => {
		const once = toStudentVisibleBlockingText(INJECTION)
		expect(toStudentVisibleBlockingText(once)).to.equal(once)
	})
})
