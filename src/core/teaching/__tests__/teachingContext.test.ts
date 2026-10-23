import { expect } from "chai"

import {
	EXPERIMENT_HARD_CONSTRAINT,
	TEACHING_CONTEXT_BUDGET,
	TEACHING_CONTEXT_QUOTAS,
	assembleTeachingContext,
	codePointLength,
	experimentPseudoCodePromptSection,
	freeModeReleasePromptSection,
	truncateByCodePoints,
} from "../TeachingContext"

/**
 * P1-5 · 教学上下文装配（纯函数层）
 *
 * 为什么单独测这一层：系统 prompt 的上下文预算一旦算错，模型要么看不到实验指导，
 * 要么把整段附件塞爆窗口；而「哪些段被丢弃」是排障的关键线索，必须当作契约测。
 */
describe("teachingContext — assembleTeachingContext 教学上下文装配（P1-5）", () => {
	/** 按 Unicode 码点重复生成指定长度的文本（emoji 也不会被切坏） */
	const fill = (unit: string, total: number): string => Array.from(unit.repeat(total)).slice(0, total).join("")

	it("★ 实验模式：四段固定顺序（guide→attachments→template→recall），总字符不超 6000", () => {
		const result = assembleTeachingContext({
			mode: "experiment",
			guide: fill("指", 4000),
			attachments: [fill("附", 1000), fill("件", 1000)],
			template: fill("模", 1000),
			recall: fill("检", 900),
		})

		expect(result.sections.map((section) => section.name)).to.deep.equal(["guide", "attachments", "template", "recall"])
		expect(result.totalChars).to.equal(TEACHING_CONTEXT_BUDGET)
		expect(result.totalChars).to.be.at.most(TEACHING_CONTEXT_BUDGET)
		expect(result.sections.map((section) => section.chars)).to.deep.equal([
			TEACHING_CONTEXT_QUOTAS.guide,
			TEACHING_CONTEXT_QUOTAS.attachments,
			TEACHING_CONTEXT_QUOTAS.template,
			TEACHING_CONTEXT_QUOTAS.recall,
		])
		// 四段都超了各自的配额，所以都被标记为 dropped
		expect(result.dropped).to.include.members(["guide", "attachments", "template", "recall"])
	})

	it("★ guide 4000 字符截到 3000，并记录 dropped=guide", () => {
		const result = assembleTeachingContext({ mode: "experiment", guide: fill("指", 4000) })
		const guide = result.sections.find((section) => section.name === "guide")

		expect(guide).to.not.equal(undefined)
		expect(guide?.content).to.equal(fill("指", 3000))
		expect(guide?.chars).to.equal(TEACHING_CONTEXT_QUOTAS.guide)
		expect(guide?.truncated).to.equal(true)
		expect(result.dropped).to.include("guide")
	})

	it("★ 附件缺失：跳过该段且不抛错（BN-27）", () => {
		const result = assembleTeachingContext({ mode: "experiment", guide: "# 实验指导\n步骤一。" })

		expect(result.sections.map((section) => section.name)).to.deep.equal(["guide"])
		expect(result.sections.some((section) => section.name === "attachments")).to.equal(false)
		expect(result.dropped).to.include("attachments")
	})

	it("★ 自由模式只产出「教材索引 + 检索片段」，不装实验指导/附件/模板", () => {
		const result = assembleTeachingContext({
			mode: "free",
			index: "## 教材索引\n1. 排序",
			recall: "## 参考片段\n快速排序的核心是分区。",
			// 自由模式下这几个字段即使被误传也不该出现
			guide: "# 不该出现",
			attachments: ["不该出现"],
			template: "不该出现",
		})

		expect(result.sections.map((section) => section.name)).to.deep.equal(["index", "recall"])
		expect(result.hardConstraint).to.equal(null)
		expect(result.prompt).to.include("## 教材资料索引")
		expect(result.prompt).to.include("## 参考教材片段（自动检索）")
		expect(result.prompt).to.not.include("不该出现")
		expect(result.prompt).to.not.include("实验模式硬约束")
	})

	it("★ 实验模式额外产出硬约束段：只给方向，第 4 次索要才可给伪代码", () => {
		const result = assembleTeachingContext({ mode: "experiment", guide: "# 实验指导" })

		expect(result.hardConstraint).to.not.equal(null)
		expect(result.hardConstraint?.content).to.equal(EXPERIMENT_HARD_CONSTRAINT)
		expect(result.hardConstraint?.content).to.include("只给方向")
		expect(result.hardConstraint?.content).to.include("第 4 次索要")
		expect(result.hardConstraint?.content).to.include("伪代码")
		// 硬约束渲染在内容段之前
		expect(result.prompt.indexOf("## 实验模式硬约束")).to.be.lessThan(result.prompt.indexOf("## 实验指导（GUIDE.md）"))
	})

	it("★ 模板为空：省略该段并记录 dropped", () => {
		const result = assembleTeachingContext({ mode: "experiment", guide: "# 实验指导", template: "" })

		expect(result.sections.some((section) => section.name === "template")).to.equal(false)
		expect(result.dropped).to.include("template")
	})

	it("★ recall 为空 / 全输入为空：省略段、不抛错，prompt 只剩硬约束（BN-27）", () => {
		const withEmptyRecall = assembleTeachingContext({ mode: "experiment", guide: "# 指导", recall: "" })
		expect(withEmptyRecall.sections.some((section) => section.name === "recall")).to.equal(false)
		expect(withEmptyRecall.dropped).to.include("recall")

		const emptyExperiment = assembleTeachingContext({ mode: "experiment" })
		expect(emptyExperiment.sections).to.deep.equal([])
		expect(emptyExperiment.totalChars).to.equal(0)
		expect(emptyExperiment.prompt).to.equal(`## 实验模式硬约束\n${EXPERIMENT_HARD_CONSTRAINT}`)
		expect(emptyExperiment.dropped).to.include.members(["guide", "attachments", "template", "recall"])

		const emptyFree = assembleTeachingContext({ mode: "free" })
		expect(emptyFree.sections).to.deep.equal([])
		expect(emptyFree.prompt).to.equal("")
	})

	it("★ totalChars 与实际字符串长度一致（含标点）", () => {
		const result = assembleTeachingContext({
			mode: "free",
			index: "## 索引\n1、第一章，概述。",
			recall: "## 参考\n结论：先排序，再二分！？",
		})
		const expectedPrompt = result.sections.map((section) => `## ${section.label}\n${section.content}`).join("\n\n")

		expect(result.prompt).to.equal(expectedPrompt)
		expect(result.totalChars).to.equal(result.sections.reduce((sum, section) => sum + codePointLength(section.content), 0))
		for (const section of result.sections) {
			expect(section.chars).to.equal(Array.from(section.content).length)
		}
	})

	it("★ 中文按字符计数，而不是按 UTF-8 字节", () => {
		const result = assembleTeachingContext({ mode: "experiment", guide: fill("中", 4000) })
		const guide = result.sections.find((section) => section.name === "guide")

		expect(guide?.content.length).to.equal(3000)
		expect(codePointLength(guide?.content ?? "")).to.equal(3000)
		expect(Buffer.byteLength(guide?.content ?? "", "utf8")).to.equal(9000)
	})

	it("★ emoji 不会在代理对中间被截断（BN-28）", () => {
		const result = assembleTeachingContext({ mode: "experiment", guide: fill("😀", 4000) })
		const guide = result.sections.find((section) => section.name === "guide")
		const content = guide?.content ?? ""

		expect(Array.from(content).length).to.equal(3000)
		expect(content).to.equal(fill("😀", 3000))
		// 不能出现孤立高代理或孤立低代理
		expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(content)).to.equal(false)
		expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)).to.equal(false)

		const unit = truncateByCodePoints("😀😀", 1)
		expect(unit.text).to.equal("😀")
		expect(unit.truncated).to.equal(true)
	})

	it("★ 两种模式交替装配互不串上下文（输入与结果都不共享可变状态）", () => {
		const attachments = [fill("附", 2000)]
		const experiment = assembleTeachingContext({
			mode: "experiment",
			guide: "# 实验指导",
			attachments,
			template: "print(1)",
			recall: "## 参考\n实验片段",
		})
		const free = assembleTeachingContext({
			mode: "free",
			index: "## 索引\n实验相关章节",
			recall: "## 参考\n实验片段",
			guide: "# 实验指导",
			attachments,
			template: "print(1)",
		})

		expect(experiment.sections.map((section) => section.name)).to.deep.equal(["guide", "attachments", "template", "recall"])
		expect(free.sections.map((section) => section.name)).to.deep.equal(["index", "recall"])
		expect(free.prompt).to.not.include("## 实验指导（GUIDE.md）")
		expect(experiment.sections).to.not.equal(free.sections)
		expect(attachments).to.deep.equal([fill("附", 2000)])
	})

	it("★ 预算小于单段配额时按优先级分配，后面的段被丢弃", () => {
		const result = assembleTeachingContext({
			mode: "experiment",
			budget: 1000,
			guide: fill("指", 2000),
			template: fill("模", 500),
		})

		expect(result.budget).to.equal(1000)
		expect(result.totalChars).to.equal(1000)
		expect(result.sections.map((section) => section.name)).to.deep.equal(["guide"])
		expect(result.dropped).to.include.members(["guide", "template"])
	})

	it("★ 放行提示文本契约：自由模式含逐段中文注释，实验模式只放行伪代码", () => {
		const freeRelease = freeModeReleasePromptSection()
		expect(freeRelease).to.include("逐段中文注释")
		expect(freeRelease).to.include("你需要自己改的地方")
		expect(freeRelease).to.include("完整实现")

		const pseudo = experimentPseudoCodePromptSection()
		expect(pseudo).to.include("伪代码")
		expect(pseudo).to.not.include("可以给完整实现")
		expect(pseudo).to.not.include("可提供完整实现")
		expect(pseudo).to.not.include("逐段中文注释")
	})
})
