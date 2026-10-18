/**
 * 【P7/T2】「完整可运行实现」判定的正/负例表。
 *
 * 这张表的作用不只是测函数，而是**锁定产品口径**：裁定 2 之后这个判定会推动
 * `ai_coding_rounds` 计数、3 次即阻断学生 60 秒 —— 误判的代价是真实的。
 * 因此每个负例都写明"为什么不能算"，尤其是 2026-10-18 实测里助手实际给出的那种填空模板。
 */
import { expect } from "chai"
import { detectFullImplementation } from "../fullImplementationDetect"

const fence = (lang: string, lines: readonly string[]): string => ["```" + lang, ...lines, "```"].join("\n")

describe("【P7/T2】detectFullImplementation", () => {
	it("★ 正例：完整可运行的函数实现（def + 双重循环 + return）", () => {
		const text = fence("python", [
			"def bubble_sort(arr):",
			"    n = len(arr)",
			"    for i in range(n - 1):",
			"        for j in range(n - 1 - i):",
			"            if arr[j] > arr[j + 1]:",
			"                arr[j], arr[j + 1] = arr[j + 1], arr[j]",
			"    return arr",
		])
		const r = detectFullImplementation(text)
		expect(r.detected).to.equal(true)
		expect(r.blockLines).to.be.greaterThan(5)
		expect(r.blockLang).to.equal("python")
	})

	it("★ 正例：TypeScript 完整函数同样算（不绑定 Python）", () => {
		const text = fence("ts", [
			"export function sum(xs: number[]): number {",
			"  let total = 0",
			"  for (const x of xs) {",
			"    total += x",
			"  }",
			"  return total",
			"}",
		])
		expect(detectFullImplementation(text).detected).to.equal(true)
	})

	it("★ 负例（实测原样）：填空模板含 `___` ⇒ 不算代写", () => {
		// 2026-10-18 实测中助手连续给出的就是这个（7 个有效行、含 for，但不可运行）
		const text = fence("python", [
			"def bubble_sort(a):",
			"    n = len(a)",
			"    for i in range(___):              # 外层：一共几轮",
			"        for j in range(___):          # 内层：每轮比较到哪",
			"            if a[j] > a[j + 1]:",
			"                ___                   # 交换",
			"    return a",
		])
		expect(detectFullImplementation(text).detected).to.equal(false)
	})

	it("★ 负例：中文伪代码（如果/交换）不算代写", () => {
		const text = fence("", [
			"for i 从 0 到 n-2:",
			"    for j 从 0 到 n-2-i:",
			"        如果 arr[j] > arr[j+1]:",
			"            交换 arr[j] 和 arr[j+1]",
			"            继续下一轮",
			"    结束内层",
		])
		expect(detectFullImplementation(text).detected).to.equal(false)
	})

	it("★ 负例：行数不足的片段（< 6 有效行）", () => {
		const text = fence("python", ["for i in range(n - 1):", "    print(i)", "n = 5", "print(n)"])
		expect(detectFullImplementation(text).detected).to.equal(false)
	})

	it("★ 负例：只有 print 的单行程序", () => {
		expect(detectFullImplementation(fence("python", ['print("Hello Python world!")'])).detected).to.equal(false)
	})

	it("★ 负例：含省略号 / TODO 的骨架", () => {
		const text = fence("python", [
			"def handler(a):",
			"    # TODO: 实现",
			"    for x in a:",
			"        ...",
			"    # 其余逻辑省略",
			"    return a",
		])
		expect(detectFullImplementation(text).detected).to.equal(false)
	})

	it("★ 合法中文注释与中文字符串不影响判定（剥离注释/字符串后再测）", () => {
		const text = fence("python", [
			"def greet(names):",
			'    """打印问候语"""',
			"    out = []",
			"    for name in names:",
			'        out.append("你好，" + name)   # 中文注释也合法',
			"    return out",
		])
		expect(detectFullImplementation(text).detected).to.equal(true)
	})

	it("★ 无代码块 / 空输入 ⇒ false", () => {
		expect(detectFullImplementation("冒泡排序就是相邻两两比较，交换位置。").detected).to.equal(false)
		expect(detectFullImplementation("").detected).to.equal(false)
	})
})
