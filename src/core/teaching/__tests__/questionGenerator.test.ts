import "should"
import { describe, it } from "mocha"

import { decideQuestionCount, MAX_QUESTIONS, MIN_QUESTIONS } from "../submission/QuestionCountPolicy"
import { fillWithTemplates, generateThinkingQuestions, parseQuestionsJson } from "../submission/QuestionGenerator"
import type { QuestionSignals } from "../submission/thinkingQuestions"

// 六个特征：L 代码有效行数 / F 文件数 / R 运行次数 / E 失败次数 / D 描述字数 / W code_edit 次数
function signals(partial: Partial<QuestionSignals>): QuestionSignals {
	return {
		codeLineCount: 0,
		fileCount: 1,
		runCount: 0,
		failureCount: 0,
		descriptionChars: 0,
		codeEditCount: 0,
		...partial,
	}
}

const ASSIGNMENT = { id: "hw-1", title: "实现一个 LRU 缓存", description: "用你熟悉的语言实现 LRU，并写测试。" }
const CODE = [{ relPath: "lru.py", content: "class LRU:\n    pass\n" }]

function llmReturning(text: string, spy?: { system?: string; user?: string }) {
	return async (system: string, user: string): Promise<string> => {
		if (spy) {
			spy.system = system
			spy.user = user
		}
		return text
	}
}

function jsonQuestions(count: number): string {
	return JSON.stringify(
		Array.from({ length: count }, (_, i) => ({
			question: `模型出的第 ${i + 1} 题：为什么这样设计？`,
			intent: "考察设计动机",
			difficulty: i === 0 ? "easy" : "medium",
		})),
	)
}

describe("思考题自适应数量（P1-1 / Q-1~Q-4）", () => {
	it("Q-1 材料极简 → 3 题（auto）", () => {
		const decision = decideQuestionCount(signals({ descriptionChars: 120 }))
		decision.count.should.equal(3)
		decision.mode.should.equal("auto")
	})

	it("Q-2 中等材料 → 4 题", () => {
		// L=50 → +1；D=350 → +1；合计 2 分 → 4 题
		const decision = decideQuestionCount(signals({ codeLineCount: 50, descriptionChars: 350, codeEditCount: 6 }))
		decision.count.should.equal(4)
		decision.score.should.equal(2)
	})

	it("Q-3 丰富材料 → 5 题", () => {
		const decision = decideQuestionCount(
			signals({
				codeLineCount: 120,
				fileCount: 3,
				runCount: 5,
				failureCount: 3,
				descriptionChars: 500,
				codeEditCount: 15,
			}),
		)
		decision.count.should.equal(MAX_QUESTIONS)
		decision.score.should.be.aboveOrEqual(5)
	})

	it("Q-3b 一行未写且没跑过 → 强制 3 题", () => {
		const decision = decideQuestionCount(signals({ codeLineCount: 8, descriptionChars: 900 }))
		decision.count.should.equal(MIN_QUESTIONS)
	})

	it("Q-4 关闭自适应 → 恒为配置值", () => {
		const rich = signals({ codeLineCount: 120, fileCount: 3, runCount: 5, failureCount: 3, descriptionChars: 500 })
		decideQuestionCount(rich, { auto: false, configuredCount: 3 }).count.should.equal(3)
		decideQuestionCount(rich, { auto: false, configuredCount: 4 }).count.should.equal(4)
		decideQuestionCount(rich, { auto: false, configuredCount: 4 }).mode.should.equal("fixed")
	})

	it("Q-4b 配置超出 [3,5] 会被夹住", () => {
		const poor = signals({})
		decideQuestionCount(poor, { auto: false, configuredCount: 9 }).count.should.equal(MAX_QUESTIONS)
		decideQuestionCount(poor, { auto: false, configuredCount: 1 }).count.should.equal(MIN_QUESTIONS)
	})
})

describe("思考题生成与降级（P1-1 / Q-5~Q-8）", () => {
	it("Q-1 无模型可用 → 3 道模板题 + 提示", async () => {
		const outcome = await generateThinkingQuestions({
			signals: signals({ descriptionChars: 120 }),
			assignment: ASSIGNMENT,
			codeFiles: CODE,
		})
		outcome.count.should.equal(3)
		outcome.generatedBy.should.equal("template")
		outcome.questions.every((q) => q.source === "template").should.be.true()
		;(outcome.warning ?? "").should.containEql("通用思考题")
	})

	it("Q-2 模型补齐到 4 题且 source=llm", async () => {
		const outcome = await generateThinkingQuestions(
			{
				signals: signals({ codeLineCount: 50, descriptionChars: 350, codeEditCount: 6 }),
				assignment: ASSIGNMENT,
				codeFiles: CODE,
			},
			{ callLLM: llmReturning(jsonQuestions(4)) },
		)
		outcome.count.should.equal(4)
		outcome.generatedBy.should.equal("llm")
		outcome.questions.map((q) => q.seq).should.eql([1, 2, 3, 4])
		outcome.questions.every((q) => q.source === "llm").should.be.true()
	})

	it("Q-5 模型只给 2 题 → 补 1 道模板，source 混记", async () => {
		const outcome = await generateThinkingQuestions(
			{ signals: signals({ descriptionChars: 120 }), assignment: ASSIGNMENT, codeFiles: CODE },
			{ callLLM: llmReturning(jsonQuestions(2)) },
		)
		outcome.count.should.equal(3)
		outcome.generatedBy.should.equal("mixed")
		outcome.questions.filter((q) => q.source === "llm").length.should.equal(2)
		outcome.questions.filter((q) => q.source === "template").length.should.equal(1)
		;(outcome.warning ?? "").should.containEql("补齐")
	})

	it("Q-6 模型给 7 题 → 截断到 5 题", async () => {
		const outcome = await generateThinkingQuestions(
			{
				signals: signals({
					codeLineCount: 120,
					fileCount: 3,
					runCount: 5,
					failureCount: 3,
					descriptionChars: 500,
					codeEditCount: 15,
				}),
				assignment: ASSIGNMENT,
				codeFiles: CODE,
			},
			{ callLLM: llmReturning(jsonQuestions(7)) },
		)
		outcome.count.should.equal(5)
		outcome.questions.length.should.equal(5)
	})

	it("Q-7 带 ```json 围栏也能解析", async () => {
		const fenced = "好的，题目如下：\n```json\n" + jsonQuestions(3) + "\n```\n希望有帮助。"
		const outcome = await generateThinkingQuestions(
			{ signals: signals({ descriptionChars: 120 }), assignment: ASSIGNMENT, codeFiles: CODE },
			{ callLLM: llmReturning(fenced) },
		)
		outcome.generatedBy.should.equal("llm")
		outcome.count.should.equal(3)
	})

	it("Q-7b 非法 JSON → 3 题模板，不抛错", async () => {
		const outcome = await generateThinkingQuestions(
			{ signals: signals({ descriptionChars: 120 }), assignment: ASSIGNMENT, codeFiles: CODE },
			{ callLLM: llmReturning("抱歉，我无法完成这个请求。") },
		)
		outcome.generatedBy.should.equal("template")
		outcome.count.should.equal(3)
	})

	it("Q-8 模型调用抛错 → 模板题 3 道 + 降级提示", async () => {
		const outcome = await generateThinkingQuestions(
			{ signals: signals({ descriptionChars: 120 }), assignment: ASSIGNMENT, codeFiles: CODE },
			{
				callLLM: async () => {
					throw new Error("fetch failed")
				},
			},
		)
		outcome.generatedBy.should.equal("template")
		outcome.count.should.equal(3)
		;(outcome.warning ?? "").should.containEql("模型调用失败")
	})

	it("prompt 里带上任务、代码与运行痕迹", async () => {
		const spy: { system?: string; user?: string } = {}
		await generateThinkingQuestions(
			{
				signals: signals({ codeLineCount: 12, runCount: 1, failureCount: 1, descriptionChars: 100 }),
				assignment: ASSIGNMENT,
				codeFiles: CODE,
				runTraces: [{ command: "python lru.py", exit_code: 1, stdout_tail: "KeyError: 'a'" }],
				logLineCount: 6,
			},
			{ callLLM: llmReturning(jsonQuestions(3), spy) },
		)
		;(spy.system ?? "").should.containEql("助教")
		;(spy.user ?? "").should.containEql("实现一个 LRU 缓存")
		;(spy.user ?? "").should.containEql("lru.py")
		;(spy.user ?? "").should.containEql("KeyError")
		;(spy.user ?? "").should.containEql("请出")
	})
})

describe("思考题解析细节（P1-1）", () => {
	it("支持 { questions: [...] } 包装", () => {
		const parsed = parseQuestionsJson(JSON.stringify({ questions: [{ question: "为什么用双向链表？" }] }), 5)
		parsed.length.should.equal(1)
		parsed[0].seq.should.equal(1)
		parsed[0].source!.should.equal("llm")
	})

	it("支持纯字符串数组与中文键名", () => {
		const parsed = parseQuestionsJson(JSON.stringify(["为什么要加锁？", { 题目: "边界条件怎么处理的？", 难度: "困难" }]), 5)
		parsed.length.should.equal(2)
		parsed[1].difficulty!.should.equal("hard")
	})

	it("过短/空题被丢弃，难度未知按 medium", () => {
		const parsed = parseQuestionsJson(JSON.stringify([{ question: "?" }, { question: "为什么要这样做？" }]), 5)
		parsed.length.should.equal(1)
		parsed[0].difficulty!.should.equal("medium")
	})

	it("fillWithTemplates 不重复插入同题", () => {
		const ctx = {
			assignmentTitle: "标题",
			signals: signals({ descriptionChars: 120 }),
		}
		const filled = fillWithTemplates([], ctx, 3)
		filled.questions.length.should.equal(3)
		const unique = new Set(filled.questions.map((q) => q.question))
		unique.size.should.equal(3)
		filled.mixed.should.be.true()
	})
})
