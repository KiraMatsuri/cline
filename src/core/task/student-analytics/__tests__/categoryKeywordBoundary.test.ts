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
})
