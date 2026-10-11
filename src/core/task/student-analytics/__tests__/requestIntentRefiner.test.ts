import { expect } from "chai"
import { refineStudentCategory } from "../RequestIntentRefiner"

describe("refineStudentCategory（方案 C-3）", () => {
	it("★ 关键实现已给出 + 学生索要「完整代码」→ 从 explanation 翻转为 code_generation", () => {
		expect(refineStudentCategory("还是不懂，直接把完整的冒泡排序代码给我", "explanation", true)).to.equal("code_generation")
		expect(refineStudentCategory("给我一份能跑的完整实现", "explanation", true)).to.equal("code_generation")
		expect(refineStudentCategory("把全部代码发我", "explanation", true)).to.equal("code_generation")
	})

	it("★ 尚未给出关键实现时不得翻转（避免过早放弃讲解）", () => {
		expect(refineStudentCategory("还是不懂，直接把完整的冒泡排序代码给我", "explanation", false)).to.equal("explanation")
	})

	it("★ 只是在问概念 / 问细节，不得翻转", () => {
		expect(refineStudentCategory("为什么外层循环是 n-1 轮？", "explanation", true)).to.equal("explanation")
		expect(refineStudentCategory("交换那一步是怎么保证顺序的？", "explanation", true)).to.equal("explanation")
	})

	it("★ algorithm 分类同样适用翻转规则", () => {
		expect(refineStudentCategory("直接给我完整可运行的实现", "algorithm", true)).to.equal("code_generation")
	})

	it("★ 本来就是 code_generation 的任务不受影响", () => {
		expect(refineStudentCategory("帮我写一个完整的排序程序", "code_generation", true)).to.equal("code_generation")
	})

	it("★ 跑题/其它分类不被翻转（只处理概念类）", () => {
		expect(refineStudentCategory("给我完整代码", "other", true)).to.equal("other")
		expect(refineStudentCategory("今天天气怎么样", "explanation", true)).to.equal("explanation")
	})
})
