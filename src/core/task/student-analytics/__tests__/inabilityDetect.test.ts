/**
 * 【P7/T1】`isInabilityStatement()` 的检测面（裁定 1 = A + B）。
 *
 * 为什么要有这张表：本轮实测（2026-10-18）里学生说「即使这样我还是**无法理解**，直接把完整代码给我」，
 * 而 b+c 询问一次都没触发 —— 因为旧模式只认「我 + 不会/不懂/写不出来」与「我看不懂」。
 * 扩充模式时必须同时钉死**负例**：`我不会放弃` / `这题不难理解` 这类句子绝不能被当成"自述写不出来"，
 * 否则每聊几句就被追问一次「要我直接给完整实现吗」。
 */
import { expect } from "chai"
import { isAffirmation, isInabilityStatement } from "../inabilityDetect"

describe("【P7/T1】写不出来 / 无法理解的识别", () => {
	it("★ 正例：本次实测暴露的自然说法（裁定 1-B 组合判定）", () => {
		// 实测原句（taskId=1792299354229，末轮）——旧实现漏的就是它
		expect(isInabilityStatement("即使这样我还是无法理解，直接把完整代码给我")).to.equal(true)
		expect(isInabilityStatement("我还是无法理解")).to.equal(true)
		expect(isInabilityStatement("我完全看不懂这段")).to.equal(true)
		expect(isInabilityStatement("这里搞不明白")).to.equal(true)
	})

	it("★ 正例：扩充的口语 / 放弃类自述（裁定 1-A）", () => {
		// 【P8/T4】2026-10-18 第二轮实测漏判的原句（旧模式只允许「实在/真的」插在「我」与「写不出来」之间）
		expect(isInabilityStatement("我还是写不出来，请直接帮我实现")).to.equal(true)
		expect(isInabilityStatement("我仍然写不出")).to.equal(true)
		expect(isInabilityStatement("我搞不定这个循环")).to.equal(true)
		expect(isInabilityStatement("我没思路")).to.equal(true)
		expect(isInabilityStatement("我放弃了")).to.equal(true)
		expect(isInabilityStatement("照抄也写不出来")).to.equal(true)
	})

	it("★ 负例：绝不能误判（否则每轮都被追问一次）", () => {
		// 同一次实测里紧邻的下一句 —— 若被判成 inability 就会在"已经理解"之后问一次，非常突兀
		expect(isInabilityStatement("我已经理解了核心原理，但我需要你帮我编写完整程序")).to.equal(false)
		// 「不会」后面跟的是坚持/继续，不是能力不足（旧实现会误判）
		expect(isInabilityStatement("我不会放弃的，让我再试试")).to.equal(false)
		// 否定的是"难"，不是"能力"
		expect(isInabilityStatement("这题不难理解，直接给我完整代码")).to.equal(false)
		// 索要 ≠ 自述写不出来
		expect(isInabilityStatement("直接把完整代码给我")).to.equal(false)
		expect(isInabilityStatement("你能理解我的意思吗")).to.equal(false)
		// 【P8/T4】新增「还是」后仍不得误判：说的是“我想自己写”，不是“我写不出来”
		expect(isInabilityStatement("我还是想自己写")).to.equal(false)
		expect(isInabilityStatement(undefined)).to.equal(false)
	})

	it("★ 肯定答复仍只认整句肯定（不受本次扩充影响）", () => {
		expect(isAffirmation("可以")).to.equal(true)
		expect(isAffirmation("是的。")).to.equal(true)
		expect(isAffirmation("不是")).to.equal(false)
		expect(isAffirmation("先不要")).to.equal(false)
	})
})
