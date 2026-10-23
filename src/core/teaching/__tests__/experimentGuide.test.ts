import { expect } from "chai"
import {
	buildFallbackGuide,
	buildGuidePrompt,
	MAX_GUIDE_SOURCE_CHARS,
	normalizeGuideMarkdown,
	validateGuide,
} from "../experimentGuide"

/**
 * P1-4 · 实验指导书生成
 *
 * 这里守的不是「文案好不好」，而是**实验模式的硬约束**：
 * 指导书不许给出完整可运行实现（BN-24），否则整个「引导式答疑」就自相矛盾了。
 */
describe("experimentGuide — 实验指导书生成", () => {
	describe("buildGuidePrompt", () => {
		it("★ 硬约束写进 system：不许完整实现 + 四个二级标题", () => {
			const { system } = buildGuidePrompt({ assignmentTitle: "统计列表" })
			expect(system).to.include("不得给出任何可直接运行的完整代码")
			expect(system).to.include("## 实验目标")
			expect(system).to.include("## 自检与提交")
			expect(system).to.include("第二人称")
		})

		it("★ user 里带任务要求 / 教师指导书 / 模板代码 / 教材片段", () => {
			const { user } = buildGuidePrompt({
				assignmentTitle: "统计列表",
				assignmentDescription: "统计列表中的偶数个数",
				teacherGuide: "先讲 for 循环",
				templateCode: "def main():\n    pass\n",
				snippets: ["列表推导式是构造列表的简洁写法"],
			})
			expect(user).to.include("统计列表")
			expect(user).to.include("统计列表中的偶数个数")
			expect(user).to.include("先讲 for 循环")
			expect(user).to.include("def main()")
			expect(user).to.include("列表推导式")
		})

		it("★ 教师指导书超长被截断（不把整本书塞进 prompt）", () => {
			const { user } = buildGuidePrompt({
				assignmentTitle: "t",
				teacherGuide: "甲".repeat(MAX_GUIDE_SOURCE_CHARS + 500),
			})
			expect(user).to.include("（已截断）")
			expect(user.length).to.be.lessThan(MAX_GUIDE_SOURCE_CHARS + 2000)
		})

		it("★ 教材片段最多 3 段，且空片段被丢弃", () => {
			const { user } = buildGuidePrompt({
				assignmentTitle: "t",
				snippets: ["a", "  ", "b", "c", "d"],
			})
			expect(user).to.include("a")
			expect(user).to.include("c")
			expect(user.includes("d")).to.equal(false)
		})
	})

	describe("validateGuide", () => {
		it("★ 纯文字指导书通过", () => {
			const text = "## 实验目标\n\n- 学会 for 循环\n\n## 实验步骤\n\n1. 读题\n2. 拆解\n"
			const res = validateGuide(text)
			expect(res.ok).to.equal(true)
			expect(res.violations.length).to.equal(0)
			expect(res.sanitized).to.equal(text.trim())
		})

		it("★ BN-24：≥5 行可运行代码块 → 不通过并替换为提示", () => {
			const text = [
				"## 实验步骤",
				"",
				"```python",
				"def count_even(items):",
				"    total = 0",
				"    for it in items:",
				"        if it % 2 == 0:",
				"            total += 1",
				"    return total",
				"```",
				"",
				"## 自检与提交",
			].join("\n")
			const res = validateGuide(text)
			expect(res.ok).to.equal(false)
			expect(res.violations[0].kind).to.equal("code_block")
			expect(res.sanitized).to.include("已移除")
			expect(res.sanitized.includes("def count_even")).to.equal(false)
		})

		it("★ ≤4 行语法示意允许（不误杀）", () => {
			const text = "## 实验步骤\n\n```python\nfor i in range(3):\n    print(i)\n```\n"
			const res = validateGuide(text)
			expect(res.ok).to.equal(true)
		})

		it("★ 注释行不计入可运行行数", () => {
			const text = "```python\n# 说明\n# 说明\n# 说明\n# 说明\n# 说明\n# 说明\n```"
			const res = validateGuide(text)
			expect(res.ok).to.equal(true)
		})

		it("★ 违禁表述（完整代码 / 完整实现）被标记", () => {
			const res = validateGuide("## 实验目标\n\n这里是完整代码，请复制。\n")
			expect(res.ok).to.equal(false)
			expect(res.violations.map((v) => v.kind)).to.include("forbidden_phrase")
			// 违禁词文件仍可用（不给整份丢掉）
			expect(res.sanitized).to.include("## 实验目标")
		})

		it("★ 空内容 → empty 违规", () => {
			const res = validateGuide("   \n\n")
			expect(res.ok).to.equal(false)
			expect(res.violations[0].kind).to.equal("empty")
			expect(res.sanitized).to.equal("")
		})
	})

	describe("buildFallbackGuide / normalizeGuideMarkdown", () => {
		it("★ 降级模板四段齐全，且只给结构不给答案", () => {
			const g = buildFallbackGuide({ assignmentTitle: "统计列表", assignmentDescription: "数偶数" })
			expect(g).to.include("# 统计列表 · 实验指导")
			expect(g).to.include("## 实验目标")
			expect(g).to.include("## 涉及知识点")
			expect(g).to.include("## 实验步骤")
			expect(g).to.include("## 自检与提交")
			expect(g).to.include("数偶数")
			expect(g.includes("def ")).to.equal(false)
		})

		it("★ 降级模板提及教师附件（当有指导书原文时）", () => {
			const g = buildFallbackGuide({ assignmentTitle: "t", teacherGuide: "很长的指导书" })
			expect(g).to.include("教师附件《实验指导书》")
		})

		it("★ normalizeGuideMarkdown 拆掉整份 markdown 围栏", () => {
			const out = normalizeGuideMarkdown("```markdown\n## 实验目标\n\nx\n```", "任务A")
			expect(out).to.include("# 任务A · 实验指导")
			expect(out.includes("```")).to.equal(false)
			expect(out.endsWith("\n")).to.equal(true)
		})

		it("★ 已有 # 标题时不再重复加", () => {
			const out = normalizeGuideMarkdown("# 我的指导\n\n正文", "任务A")
			expect(out.startsWith("# 我的指导")).to.equal(true)
			expect(out.includes("任务A · 实验指导")).to.equal(false)
		})

		it("★ 空输入 → 空串（调用方据此走降级模板）", () => {
			expect(normalizeGuideMarkdown("   ", "任务A")).to.equal("")
		})
	})
})
