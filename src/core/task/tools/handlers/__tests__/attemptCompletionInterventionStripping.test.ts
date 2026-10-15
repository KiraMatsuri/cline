import { expect } from "chai"
import fs from "fs"
import path from "path"
import { extractInterventionCopy } from "@/shared/markdown/interventionCopy"
import { AttemptCompletionHandler } from "../AttemptCompletionHandler"

/**
 * 【F13】两条展示路径的剥离守护（G3 断言 ④）。
 *
 * ⚠️ **诚实声明**：本文件的第 2 个用例是**变更探测器**（读取源码文本做结构断言），
 * **不是**端到端验证 —— 它只能证明「代码里确实挂了剥离」，不能证明运行时行为了符合预期。
 * 第 1 个用例是**真实调用** `AttemptCompletionHandler.handlePartialBlock`（该路径只需
 * `uiHelpers.say` + `removeClosingTag`，无需完整 TaskConfig，故可真实执行），覆盖**未闭合**流式帧；
 * 已闭合块的真实调用（剥离 + "partial 不调展示钩子"）在
 * `student-analytics/__tests__/completionPathAccounting.test.ts`（review F3：同一行为只留一处真实调用）。
 * `execute()` 的两处调用的真实覆盖需要完整 TaskConfig 测试基建（本仓库暂无），
 * 因此那两处只能落在结构守卫里。
 */
const blockText = (copy: string): string =>
	`<teaching_intervention_copy rule="no_edit_streak" severity="gentle">\n${copy}\n</teaching_intervention_copy>`

describe("F13 · 展示路径剥离（AttemptCompletionHandler）", () => {
	it("★ 真实调用 handlePartialBlock（流式未闭合帧）：开标签及其后内容整体丢弃，只留前缀", async () => {
		const handler = new AttemptCompletionHandler()
		const said: Array<{ type: string; text?: string }> = []
		const fakeHelpers = {
			say: async (type: string, text?: string) => {
				said.push({ type, text })
				return undefined
			},
			removeClosingTag: (_block: unknown, _tag: string, text?: string) => text ?? "",
		} as unknown as Parameters<typeof handler.handlePartialBlock>[1]

		// 流式中间帧：回执块还没闭合 ⇒ `extractInterventionCopy()` 按契约 ④ 恒等返回，
		// 由 `dropUnclosedInterventionCopy()` 丢掉开标签及其后全部内容；否则开标签会被 webview 直接渲染出来。
		// 【F1】该路径**不得**调用展示钩子（钩子含兜底/记账/置位，只允许在非 partial 的最终展示点调用）
		// ⇒ mock 里没有 `getConfig`。
		await handler.handlePartialBlock(
			{
				name: "attempt_completion",
				partial: true,
				params: {
					result: `正在查看改动前的现状。\n<teaching_intervention_copy rule="no_edit_streak" severity="gentle">\n我刚刚`,
				},
			} as never,
			fakeHelpers,
		)

		expect(said).to.have.lengthOf(1)
		expect(said[0].type).to.equal("completion_result")
		expect(said[0].text).to.not.include("<teaching_intervention_copy")
		// 只预览开标签之前的文本
		expect(said[0].text).to.equal("正在查看改动前的现状。")
	})

	it("★ 结构守卫（**变更探测器，非端到端验证**）：两条展示路径都挂了解析与剥离", () => {
		const handlerSrc = fs.readFileSync(path.join(__dirname, "..", "AttemptCompletionHandler.ts"), "utf8")
		const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "..", "index.ts"), "utf8")

		// AttemptCompletionHandler：一次 import + 三处**逐字相同**的剥离调用
		// （不用裸子串计数：`rest` 可被无关文本满足 —— P3 复审 M3）
		expect(handlerSrc).to.include("extractInterventionCopy")
		expect(handlerSrc).to.include('from "@/shared/markdown/interventionCopy"')
		expect((handlerSrc.match(/const \{ rest \} = extractInterventionCopy\(result\)/g) ?? []).length).to.equal(3)
		// 只有 say（展示），不得有持久化路径 —— F13 硬要求 2 的前置条件
		expect(handlerSrc).to.not.include("addToApiConversationHistory")

		// index.ts：display 路径解析 + 剥离；【P6/T4】文本块路径已**委托**给 `Task.applyInterventionDisplay()`，
		// 剥离/兜底/记账逐字仍在，只是搬进了那个方法（DRY：两条展示路径共用）。
		expect(taskSrc).to.include("this.applyInterventionDisplay(content)")
		expect(taskSrc).to.include("private async applyInterventionDisplay(")
		expect(taskSrc).to.include("extractInterventionCopy(rawContent)")
		expect(taskSrc).to.include("resolveInterventionCopyForDisplay")
	})

	it("★ 纯函数级：extractInterventionCopy(x).rest 不含块（剥离本身有效）", () => {
		const r = extractInterventionCopy(`前\n${blockText("我刚刚给了实现。你先动手写第一版？")}\n后`)
		expect(r.found).to.not.equal(null)
		expect(r.rest).to.not.include("<teaching_intervention_copy")
		expect(r.rest).to.equal("前\n后")
	})
})
