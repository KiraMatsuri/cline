import { expect } from "chai"
import { buildConceptModeConstraint, detectConceptModeViolation, isConceptModeCategory } from "../conceptModeConstraint"

describe("buildConceptModeConstraint", () => {
	it("★ 必须明确禁止完整可运行实现，且明确允许关键步骤片段", () => {
		const t = buildConceptModeConstraint()
		expect(t).to.include("完整")
		expect(t).to.include("关键步骤")
		expect(t).to.include("交换")
	})

	it("必须覆盖'即使学生反复要求也不给'这一条", () => {
		expect(buildConceptModeConstraint()).to.match(/反复|持续|仍然/)
	})

	it("必须包含冒泡排序这一具体示例（供弱模型照做）", () => {
		expect(buildConceptModeConstraint()).to.include("冒泡排序")
	})
})

describe("detectConceptModeViolation（仅可见化，不拦截）", () => {
	const completeImplementation = [
		"冒泡排序的完整实现：",
		"```python",
		"def bubble_sort(arr):",
		"    n = len(arr)",
		"    for i in range(n - 1):",
		"        for j in range(n - 1 - i):",
		"            if arr[j] > arr[j + 1]:",
		"                arr[j], arr[j + 1] = arr[j + 1], arr[j]",
		"    return arr",
		"```",
	].join("\n")

	const keyStepOnly = "关键就是相邻比较与交换这一步：`arr[j], arr[j+1] = arr[j+1], arr[j]` —— 循环结构留给你自己写。"

	it("★ 含双重循环的完整实现 → 判为违规", () => {
		const r = detectConceptModeViolation(completeImplementation)
		expect(r.violated).to.equal(true)
		expect(r.blockLines).to.be.greaterThan(6)
	})

	it("★ 只给关键步骤片段 → 不违规", () => {
		expect(detectConceptModeViolation(keyStepOnly).violated).to.equal(false)
	})

	it("★ 纯文字解释 → 不违规", () => {
		expect(detectConceptModeViolation("每轮把最大的元素冒到末尾，重复 n-1 轮即可。").violated).to.equal(false)
	})

	it("★ 保守：长代码块但无循环（如数据定义）不判违规", () => {
		const dataOnly = ["```python", "GRADES = {", '    "甲": 90,', '    "乙": 80,', "}", "```"].join("\n")
		expect(detectConceptModeViolation(dataOnly).violated).to.equal(false)
	})
})

describe("isConceptModeCategory（概念模式判定，供注入门控复用）", () => {
	it("explanation / algorithm → true", () => {
		expect(isConceptModeCategory("explanation")).to.equal(true)
		expect(isConceptModeCategory("algorithm")).to.equal(true)
	})

	it("code_generation / other / undefined → false", () => {
		expect(isConceptModeCategory("code_generation")).to.equal(false)
		expect(isConceptModeCategory("other")).to.equal(false)
		expect(isConceptModeCategory(undefined)).to.equal(false)
	})
})
