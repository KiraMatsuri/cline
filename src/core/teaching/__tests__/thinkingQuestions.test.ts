/**
 * thinkingQuestions 单测：题数自适应（设计文档 §7.3.1）+ 模板出题基本约束
 *
 * 运行：
 *   $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'
 *   npx mocha --require ts-node/register --require tsconfig-paths/register --grep "思考题"
 */
import "should"
import {
	buildTemplateQuestions,
	countForQuestions,
	type QuestionSignals,
	scoreForQuestions,
} from "../submission/thinkingQuestions"

const EMPTY: QuestionSignals = {
	codeLineCount: 0,
	fileCount: 0,
	runCount: 0,
	failureCount: 0,
	descriptionChars: 0,
	codeEditCount: 0,
}

function signals(patch: Partial<QuestionSignals>): QuestionSignals {
	return { ...EMPTY, ...patch }
}

describe("thinkingQuestions（需求 2：思考题生成）", () => {
	describe("scoreForQuestions", () => {
		it("全空提交得 0 分", () => {
			scoreForQuestions(EMPTY).should.equal(0)
		})

		it("代码 40 行起 +1，80 行起 +2（不叠加）", () => {
			scoreForQuestions(signals({ codeLineCount: 39 })).should.equal(0)
			scoreForQuestions(signals({ codeLineCount: 40 })).should.equal(1)
			scoreForQuestions(signals({ codeLineCount: 79 })).should.equal(1)
			scoreForQuestions(signals({ codeLineCount: 80 })).should.equal(2)
		})

		it("文件数、运行次数、报错次数、描述字数、编辑次数按阈值累加", () => {
			scoreForQuestions(signals({ fileCount: 3 })).should.equal(1)
			scoreForQuestions(signals({ runCount: 1 })).should.equal(1)
			scoreForQuestions(signals({ runCount: 4 })).should.equal(2)
			scoreForQuestions(signals({ failureCount: 1 })).should.equal(1)
			scoreForQuestions(signals({ failureCount: 3 })).should.equal(2)
			scoreForQuestions(signals({ descriptionChars: 300 })).should.equal(1)
			scoreForQuestions(signals({ codeEditCount: 10 })).should.equal(1)
		})

		it("典型丰富提交得高分", () => {
			const rich = signals({
				codeLineCount: 120,
				fileCount: 4,
				runCount: 6,
				failureCount: 2,
				descriptionChars: 420,
				codeEditCount: 15,
			})
			scoreForQuestions(rich).should.equal(8)
		})
	})

	describe("countForQuestions", () => {
		it("极瘦提交（<10 行且没运行）固定 3 题", () => {
			countForQuestions(signals({ codeLineCount: 5, descriptionChars: 900, codeEditCount: 30 })).should.equal(3)
		})

		it("分数 <2 出 3 题", () => {
			countForQuestions(signals({ codeLineCount: 50 })).should.equal(3)
		})

		it("分数 2~4 出 4 题", () => {
			countForQuestions(signals({ codeLineCount: 50, runCount: 2, failureCount: 1 })).should.equal(4)
		})

		it("分数 >=5 出 5 题", () => {
			countForQuestions(signals({ codeLineCount: 120, fileCount: 3, runCount: 4, failureCount: 1 })).should.equal(5)
		})

		it("结果永远落在 3~5 之间", () => {
			const samples: QuestionSignals[] = [
				EMPTY,
				signals({ codeLineCount: 1 }),
				signals({
					codeLineCount: 1000,
					fileCount: 20,
					runCount: 50,
					failureCount: 50,
					descriptionChars: 5000,
					codeEditCount: 200,
				}),
			]
			for (const sample of samples) {
				const count = countForQuestions(sample)
				count.should.be.aboveOrEqual(3)
				count.should.be.belowOrEqual(5)
			}
		})
	})

	describe("buildTemplateQuestions", () => {
		it("seq 从 1 连续递增，source 为 template，题面非空", () => {
			const questions = buildTemplateQuestions({
				assignmentTitle: "链表反转",
				signals: signals({ codeLineCount: 120, fileCount: 3, runCount: 4, failureCount: 1 }),
			})
			questions.length.should.equal(5)
			questions.forEach((question, index) => {
				question.seq.should.equal(index + 1)
				question.source!.should.equal("template")
				question.question.length.should.be.above(10)
			})
		})

		it("没有运行记录时问「你会设计哪些测试用例」", () => {
			const questions = buildTemplateQuestions({ assignmentTitle: "排序", signals: signals({ codeLineCount: 30 }) })
			questions.some((q) => q.question.includes("测试用例")).should.be.true()
		})

		it("有运行记录时带出运行次数与报错次数", () => {
			const questions = buildTemplateQuestions({
				assignmentTitle: "排序",
				signals: signals({ codeLineCount: 30, runCount: 7, failureCount: 3 }),
			})
			const joined = questions.map((q) => q.question).join("\n")
			joined.should.containEql("7 次")
			joined.should.containEql("3 次报错")
		})

		it("描述 >=300 字时会追问取舍", () => {
			const questions = buildTemplateQuestions({
				assignmentTitle: "排序",
				signals: signals({ codeLineCount: 30, descriptionChars: 400 }),
			})
			questions.some((q) => q.question.includes("取舍")).should.be.true()
		})

		it("缺标题时用兜底称呼，不会出现 undefined", () => {
			const questions = buildTemplateQuestions({ assignmentTitle: "", signals: signals({ codeLineCount: 30 }) })
			questions
				.map((q) => q.question)
				.join("\n")
				.should.not.containEql("undefined")
			questions[0].question.should.containEql("本次实验")
		})
	})
})
