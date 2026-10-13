import { expect } from "chai"
import { TaskClassifier } from "../TaskClassifier"

const cls = (text: string) => new TaskClassifier().classify(text)

describe("F5/F11 · 关键词词边界（ASCII 不得子串误命中）", () => {
	it("★ 'go' 不得命中 'algorithm' / 'going'", () => {
		// language_request 规则里含关键词 `go`；algorithm 规则只声明中文关键词"算法"，
		// 所以裸 includes 会把 "algorithm" 里的 "go" 当成 language_request（实测 4 分）。
		expect(cls("algorithm")).to.equal("other")
		expect(cls("going home")).to.equal("other")
	})

	it("★ 'js' 不得命中 'json'", () => {
		expect(cls("这段 json 怎么解析")).to.equal("other")
	})

	it("★ 'c++' / 'c#' 这类以非单词字符结尾的关键词仍能被正常命中", () => {
		// 若改用 `\b`，`\bc\+\+\b` / `\bc#\b` 在任何文本上都不成立；词边界必须按首/尾字符分别加断言。
		expect(cls("c++")).to.equal("language_request")
		expect(cls("c#")).to.equal("language_request")
	})

	it("★ 精确的独立词仍能命中", () => {
		expect(cls("go 的 goroutine 怎么用")).to.equal("language_request")
	})

	it("★ 中文关键词不受词边界影响（CJK 仍走 includes）", () => {
		// "排序"(algorithm, w10) 与 "实现"(code_generation, w7) 都走 includes 分支；中文无词边界概念。
		expect(cls("排序与实现")).to.equal("algorithm")
	})

	it("★【裁定 2.a】已收录的屈折形/复合形必须命中", () => {
		const cases: Array<[string, string]> = [
			["testing 怎么做", "testing"],
			["python3 的语法", "language_request"],
			["nodejs 怎么写", "language_request"],
			["报错了 errors 一堆", "debugging"],
			["failed 了怎么办", "debugging"],
			["sorting 的思路", "algorithm"],
			["refactoring 一下", "refactoring"],
			["optimized 之后的性能", "refactoring"],
			["writing 一个类", "code_generation"],
			["explains 一下", "explanation"],
		]
		for (const [text, expected] of cases) {
			expect(cls(text), `"${text}" 应归为 ${expected}`).to.equal(expected)
		}
	})

	it("★ 取舍声明：只做整词匹配，不做词形还原（未收录的屈折形不会命中）", () => {
		// 若将来要做词形还原/词干化，这条用例应被**反向改写**为"必须命中"
		//
		// 【实测校准】简报给出的两句期望是 other，但实测都不是（不改规则、不删关键词，按实测值锁定）：
		//   - "optimized the function" → refactoring：`optimized` 已被 (a) 半收进 refactoring 关键词（w6）
		//   - "simplified the code" → code_generation：`code` 早就在 code_generation 表里（w7），命中 "the code"
		// 也就是说这两句不再是"未收录"的屈折形；为守住本条声明的本意，下面补两句**真正未收录**的派生形：
		// `debug` / `fix` 在表里，但 `debugger` / `fixes` 不在 ⇒ 整词匹配下必须不命中。
		expect(cls("optimized the function")).to.equal("refactoring")
		expect(cls("simplified the code")).to.equal("code_generation")
		expect(cls("debugger 怎么用")).to.equal("other")
		expect(cls("fixes 一下")).to.equal("other")
	})
})
