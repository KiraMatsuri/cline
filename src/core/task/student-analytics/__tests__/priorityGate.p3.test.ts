/**
 * G3 · P3 优先级综合测试（L2 层）
 *
 * 覆盖 plan-2 §0 的四类检查：正常路径 / 边界条件 / 回归 / 核心流程可跑通。
 * P3 范围：F10（`hasDeliveredKeyCode` 由写文件工具武装）、F11（AI 落盘归属）、F13（回执块契约 + 两条展示路径剥离 + M9' 记账）。
 *
 * ⚠️ **诚实声明**：本文件的结构守卫（读源码文本做包含断言）是**变更探测器**，
 * **不是**端到端验证。「`apiConversationHistory` 里保留回执块、且学生看不到它」
 * 需要真实 `Task` + 一次真实请求，只能由人工验收 M9' 覆盖（同 G1/G2 的处理）。
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { AttemptCompletionHandler } from "@/core/task/tools/handlers/AttemptCompletionHandler"
import { extractInterventionCopy } from "@/shared/markdown/interventionCopy"
import { MAX_COPY_CHARS, SEVERITY_VOICE, validateCopy } from "../InterventionCopyContract"
import { formatInterventionForInjection } from "../InterventionMessageGenerator"
import { resolveInterventionCopyForDisplay } from "../interventionDisplay"
import { FILE_WRITING_TOOLS, nextHasDeliveredKeyCode } from "../keyCodeDelivery"
import type { InterventionMessage } from "../types"

const copyBlock = (copy: string, rule = "no_edit_streak", severity = "gentle"): string =>
	`<teaching_intervention_copy rule="${rule}" severity="${severity}">\n${copy}\n</teaching_intervention_copy>`

describe("G3 · 优先级综合（可跑通 + 边界）", () => {
	// ---------------- P3 专项断言 ①–⑤ ----------------

	it("【G3-①】回执块解析的六类边界（恒等 / 命中 / 未闭合 / 多块 / 中间 / 空块）", () => {
		// ① 无标签 ⇒ 恒等变换（逐字节）
		const plain = "## 插入排序\n\n这段代码的核心是内层循环。\n"
		expect(extractInterventionCopy(plain)).to.deep.equal({ found: null, rest: plain })

		// ② 命中 ⇒ 取内文为 copy，rest 为剥离后的正文
		const one = extractInterventionCopy(`${copyBlock("先动手写第一版？")}\n\n---\n\n正文`)
		expect(one.found?.copy).to.equal("先动手写第一版？")
		expect(one.found?.rule).to.equal("no_edit_streak")
		expect(one.found?.severity).to.equal("gentle")
		expect(one.rest).to.equal("---\n\n正文")

		// ③ 未闭合 ⇒ found=null 且 rest 与原文完全相同（恒等；流式中间态交给 partial 分支）
		const unclosed = `先动手试试：\n<teaching_intervention_copy rule="no_edit_streak" severity="gentle">\n我刚刚给了实现`
		expect(extractInterventionCopy(unclosed)).to.deep.equal({ found: null, rest: unclosed })

		// ④ 多块 ⇒ 首个为 found，其余一并剥离
		const multi = extractInterventionCopy(`${copyBlock("第一块")}\n\n中间正文\n\n${copyBlock("第二块")}`)
		expect(multi.found?.copy).to.equal("第一块")
		expect(multi.rest).to.equal("中间正文")
		expect(multi.rest).to.not.include("<teaching_intervention_copy")

		// ⑤ 块在正文中间 ⇒ 两侧文字保留、连续空行归一为至多一个空行
		expect(extractInterventionCopy(`上文\n\n${copyBlock("文案")}\n\n下文`).rest).to.equal("上文\n\n下文")

		// ⑥ 空块 ⇒ copy 为空串（交由校验拒绝），块仍被剥离
		const empty = extractInterventionCopy(
			`<teaching_intervention_copy rule="r" severity="gentle"></teaching_intervention_copy>\n\n正文`,
		)
		expect(empty.found?.copy).to.equal("")
		expect(empty.rest).to.equal("正文")
	})

	it("【G3-②】四条确定性校验失败 ⇒ 不采用模型文案：降级模板并记 copy_rejected", () => {
		const template = "💡 实践建议：最近 8 轮我们都在聊，还没动手改过代码。"
		const cases: Array<{ reason: string; copy: string }> = [
			{ reason: "too_long", copy: `💡 ${"啊".repeat(MAX_COPY_CHARS)}先动手试试？` },
			{ reason: "has_fenced_code", copy: "先动手写出这段逻辑，你会怎么写？```python\nprint(1)\n```" },
			{ reason: "no_blank", copy: "我刚刚给出了这段完整实现。" },
			{ reason: "forbidden_phrase", copy: "请不要提系统检测到的依赖问题，先自己动手写一版？" },
		]

		for (const { reason, copy } of cases) {
			const v = validateCopy(copy, { recentTexts: "" })
			expect(v.downgrade, reason).to.equal(true)
			expect(v.reasons, reason).to.include(reason)

			const shown = resolveInterventionCopyForDisplay({
				found: { rule: "no_edit_streak", severity: "gentle", copy },
				body: "",
				lastInjectionTemplate: template,
				recentTexts: "",
			})
			expect(shown.text, reason).to.equal(template) // 干预一次都不丢
			expect(shown.event?.copyDecision, reason).to.equal("copy_rejected")
			expect(shown.event?.copyVoice, reason).to.equal("template")
		}

		// 回归：恰好 MAX_COPY_CHARS 字（去 emoji）不算超长
		const suffix = "请先动手写一版？"
		const exact = "啊".repeat(MAX_COPY_CHARS - [...suffix].length) + suffix
		expect(validateCopy(exact, { recentTexts: "" }).reasons).to.not.include("too_long")
	})

	it("【G3-③】主题锚定是**启发式**：不降级、不改展示，只进 advisories", () => {
		const copy = "我刚刚给出了实现的思路。你打算先动手写哪一部分呢？"
		const recent = "请解释 二分查找 的原理"

		const v = validateCopy(copy, { recentTexts: recent })
		expect(v.ok).to.equal(true)
		expect(v.downgrade).to.equal(false)
		expect(v.advisories).to.include("topic_unanchored")

		const shown = resolveInterventionCopyForDisplay({
			found: { rule: "no_edit_streak", severity: "gentle", copy },
			body: "",
			lastInjectionTemplate: "模板兜底文案",
			recentTexts: recent,
		})
		expect(shown.text).to.equal(copy) // 仍然展示模型文案
		expect(shown.event?.copyDecision).to.equal("copy_accepted")
		expect(shown.event?.copyAdvisories).to.include("topic_unanchored")
	})

	it("【G3-④】两条展示路径都剥离回执块，且持久化路径不受影响", async () => {
		// 真实调用（该路径只需 uiHelpers.say + removeClosingTag，无需完整 TaskConfig）
		const handler = new AttemptCompletionHandler()
		const said: Array<{ type: string; text?: string }> = []
		const helpers = {
			say: async (type: string, text?: string) => {
				said.push({ type, text })
				return undefined
			},
			removeClosingTag: (_block: unknown, _tag: string, text?: string) => text ?? "",
			// 【P6/T4】`handlePartialBlock` 现在会向 Task 侧要展示钩子；未挂载时按“不附加文案”处理（`?? rest`）
			getConfig: () => ({ callbacks: {} }),
		} as unknown as Parameters<typeof handler.handlePartialBlock>[1]
		const copy = "我刚刚给了实现。你先动手写第一版？"
		await handler.handlePartialBlock(
			{ name: "attempt_completion", partial: true, params: { result: `${copyBlock(copy)}\n\n---\n\n正文内容。` } } as never,
			helpers,
		)
		expect(said).to.have.lengthOf(1)
		expect(said[0].text).to.not.include("<teaching_intervention_copy")
		expect(said[0].text).to.include("正文内容。")

		// 结构守卫（**变更探测器**）：say("text") 路径挂了剥离；持久化仍走 assistantTextOnly
		const taskDir = path.join(__dirname, "..", "..") // src/core/task
		const taskSrc = fs.readFileSync(path.join(taskDir, "index.ts"), "utf-8")
		const handlerSrc = fs.readFileSync(path.join(taskDir, "tools", "handlers", "AttemptCompletionHandler.ts"), "utf-8")
		// 【P6/T4】文本块路径的剥离/兜底/记账已搬进 `Task.applyInterventionDisplay()`（两条展示路径共用）
		expect(taskSrc).to.include("this.applyInterventionDisplay(content)")
		expect(taskSrc).to.include("private async applyInterventionDisplay(")
		expect(taskSrc).to.include("resolveInterventionCopyForDisplay")
		expect(handlerSrc).to.include("extractInterventionCopy(result)")
		// F13 硬要求 2：剥离只喂展示，历史累积仍是原始 chunk 文本
		expect(taskSrc).to.include("assistantTextOnly += chunk.text")
		expect(handlerSrc).to.not.include("addToApiConversationHistory")
		// 【P3 复审 C1】一次决策只投递一条文案：同回合「已交付」标志必须存在、随回合入口重置、并传给纯函数
		expect(taskSrc).to.include("copyAlreadyDelivered: this.interventionCopyDeliveredThisTurn")
		expect(taskSrc).to.include("this.interventionCopyDeliveredThisTurn = false") // 回合入口重置
		expect(taskSrc).to.include("this.interventionCopyDeliveredThisTurn = true") // 交付后置位
	})

	it("【G3-⑤】关键实现武装：正文 fenced 块**或**写文件工具（F10），且单任务内单调", () => {
		expect(FILE_WRITING_TOOLS.has("write_to_file")).to.equal(true)
		expect(FILE_WRITING_TOOLS.has("replace_in_file")).to.equal(true)
		// 只读工具不得武装
		expect(FILE_WRITING_TOOLS.has("read_file")).to.equal(false)

		expect(nextHasDeliveredKeyCode(false, false, ["write_to_file"])).to.equal(true)
		expect(nextHasDeliveredKeyCode(false, true, [])).to.equal(true)
		expect(nextHasDeliveredKeyCode(false, false, ["read_file"])).to.equal(false)
		expect(nextHasDeliveredKeyCode(true, false, [])).to.equal(true) // 单调，不回落
	})

	// ---------------- 核心流程可跑通（跨模块串联） ----------------

	it("★ 核心流程：任务书 → 模型回执 → 展示剥离 → M9' 记账字段齐备", () => {
		const templateText = "💡 实践建议：最近 8 轮我们都在聊，还没动手改过代码。想不想挑一处小地方试试？"
		const intervention: InterventionMessage = {
			content: templateText,
			ruleId: "no_edit_streak",
			severity: "gentle",
			style: "hint",
			interventionType: "normal",
			generatedAt: new Date().toISOString(),
			cooldownUntil: new Date(Date.now() + 60_000).toISOString(),
		}

		// ① 下发的任务书：外层 <teaching_intervention>，内层回执示例，力度档原文与语义基准齐备
		const injectionText = formatInterventionForInjection(intervention, [])
		expect(injectionText.startsWith('<teaching_intervention rule="no_edit_streak" severity="gentle">')).to.equal(true)
		expect(injectionText.trimEnd().endsWith("</teaching_intervention>")).to.equal(true)
		expect(injectionText).to.include(`<teaching_intervention_copy rule="no_edit_streak" severity="gentle">`)
		expect(injectionText).to.include(SEVERITY_VOICE.gentle)
		expect(injectionText).to.include(templateText) // 语义/力度锚点

		// ② 模型按契约回复：回执块 + 分隔线 + 正文（回执块承载"学生可见的那段文案"）
		const modelCopy = "我刚把插入排序的完整实现写完了。你先写一遍内层循环，再回来对照？"
		const modelReply = `${copyBlock(modelCopy)}\n\n---\n\n下面是插入排序的说明。`

		// ③ 展示层：剥离 + 记账，学生看不到 XML 残渣
		const { found, rest } = extractInterventionCopy(modelReply)
		const shown = resolveInterventionCopyForDisplay({
			found,
			body: rest,
			lastInjectionTemplate: templateText,
			recentTexts: "帮我看看插入排序",
			interventionRuleId: "no_edit_streak",
			interventionSeverity: "gentle",
			interventionStyle: "hint",
		})
		const displayed = shown.text ? `${shown.text}\n\n---\n\n${rest}` : rest
		expect(displayed).to.not.include("<teaching_intervention_copy")
		expect(displayed).to.include(modelCopy)
		expect(displayed).to.include("下面是插入排序的说明。")

		// ④ 记账字段齐备（M9' 的 C/T/N 与 rule/severity/style/voice 全可对账）
		expect(shown.event?.copyDecision).to.equal("copy_accepted")
		expect(shown.event?.copyReasons).to.deep.equal([])
		expect(shown.event?.copyVoice).to.equal("model")
		expect(shown.event?.interventionRuleId).to.equal("no_edit_streak")
		expect(shown.event?.interventionSeverity).to.equal("gentle")
		expect(shown.event?.interventionStyle).to.equal("hint")

		// ⑤ 纯函数级：剥离结果（= 展示正文）不含 XML，但正文文字一字不少
		// ⚠️ 这里**不能**用 `expect(modelReply).to.include("<teaching_intervention_copy")` 来声称
		// 「历史里保留了回执块」—— 那断言的是本测试自己拼出的字符串常量，**恒真**（P3 复审 M2）。
		// 历史侧的真实覆盖只能由人工验收 M9' 或 G3-④ 的结构守卫承担。
		expect(rest).to.not.include("<teaching_intervention_copy")
		expect(rest).to.include("下面是插入排序的说明。")
	})
})
