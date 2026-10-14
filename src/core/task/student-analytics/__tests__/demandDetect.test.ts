/**
 * 【P5/T16】「索要完整实现」判定（纯函数）。
 *
 * 为什么要单测一条正则集合：实测 M4'/M6' 表明，学生在**概念型任务**里索要完整实现时
 * 没有任何可计数、可升级的规则（`rulePolicy` 把代码类规则整体停用），
 * 于是"能不能识别出这类索要"变成了整个干预链路的**唯一入口** ——
 * 漏判 ⇒ 永远零干预（M6' 实测行为）；误判 ⇒ 正常提问被当成索要（更糟）。
 * 因此正例必须覆盖**实测原句**，反例必须覆盖"含'完整'但不索要代码"的常见表述。
 */

import { expect } from "chai"
import { isCompleteImplDemand } from "../demandDetect"

describe("isCompleteImplDemand（【P5/T16】索要完整实现的判定）", () => {
	it("★ 正例：实测原句（M4' / M6' / M7'）必须命中", () => {
		for (const text of [
			"帮我写一个完整的冒泡排序程序", // M4' 的 task_start 原文
			"直接把完整代码给我", // M6' 的追问原文
			"不要解释了，直接给我代码",
		]) {
			expect(isCompleteImplDemand(text), text).to.equal(true)
		}
	})

	it("★ 正例：常见变体（全套 / 可运行 / 我要 / 提供一份）", () => {
		for (const text of [
			"把完整代码发给我",
			"给我全套代码",
			"可以提供可运行的代码吗",
			"我要完整的实现",
			"请你提供一个完整的实现",
			"直接输出结果就行",
			"完整版本发我",
		]) {
			expect(isCompleteImplDemand(text), text).to.equal(true)
		}
	})

	it("★ 反例：正常提问（含「完整」/「代码」字样但不是在索要成品）不得误判", () => {
		for (const text of [
			"冒泡排序的原理是什么", // M2' 风格：概念提问
			"帮我解释一下装饰器",
			"完整讲一下冒泡排序的思路", // 有"完整"，但讲的是**思路**
			"这段代码为什么会报错",
			"我想自己写，你先别给代码", // 明确不要代码
			"写一个完整的思路给我", // 有"写一个完整的"，但收尾不是代码类名词
			"把代码改成 Python 版本", // 有"代码"和"版本"，但不是索要完整实现
		]) {
			expect(isCompleteImplDemand(text), text).to.equal(false)
		}
	})

	it("★ 边界：空串 / 纯空白 / undefined ⇒ 一律 false（不臆造）", () => {
		expect(isCompleteImplDemand("")).to.equal(false)
		expect(isCompleteImplDemand("   \n\t ")).to.equal(false)
		expect(isCompleteImplDemand(undefined)).to.equal(false)
	})

	it("★ 边界：夹杂在长句中的索要仍应命中（实测学生常把话写在上下文里）", () => {
		expect(isCompleteImplDemand("我看了你上面的解释，但还是不太懂，帮我写一个完整的冒泡排序程序吧，谢谢")).to.equal(true)
	})
})
