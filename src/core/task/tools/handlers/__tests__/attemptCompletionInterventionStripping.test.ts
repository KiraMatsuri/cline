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
 * `uiHelpers.say` + `uiHelpers.removeClosingTag`，无需完整 TaskConfig，故可真实执行）；
 * `execute()` 的两处调用的真实覆盖需要完整 TaskConfig 测试基建（本仓库暂无），
 * 因此那两处只能落在结构守卫里。
 */
const blockText = (copy: string): string =>
	`<teaching_intervention_copy rule="no_edit_streak" severity="gentle">\n${copy}\n</teaching_intervention_copy>`

describe("F13 · 展示路径剥离（AttemptCompletionHandler）", () => {
	it("★ 真实调用 handlePartialBlock：completion_result 中不带回执块残渣", async () => {
		const handler = new AttemptCompletionHandler()
		const said: Array<{ type: string; text?: string }> = []
		const fakeHelpers = {
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
			{ name: "attempt_completion", partial: true, params: { result: `${blockText(copy)}\n\n---\n\n正文内容。` } } as never,
			fakeHelpers,
		)

		expect(said).to.have.lengthOf(1)
		expect(said[0].type).to.equal("completion_result")
		expect(said[0].text).to.not.include("<teaching_intervention_copy")
		// 剥离只动回执块，正文一字不动
		expect(said[0].text).to.include("正文内容。")
		expect(said[0].text).to.not.include(copy)
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
