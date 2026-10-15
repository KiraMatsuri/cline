/**
 * 【P6/T4】实测：12:59:47 与 13:05:48 两条 gentle 决策**零可见文案**（M9' ③ 恰好差 2）。
 * 原因：整轮回答走 `attempt_completion`（模型只调这一个工具）⇒ 展示路径是
 * `AttemptCompletionHandler`，它只剥离回执块，**不追加兜底模板、不记账**，
 * 于是"模型没写回执块 ⇒ 用模板兜底"这条链（interventionDisplay 分支 ③）根本没被调用。
 *
 * ⚠️ 结构断言（本文件前两个用例）是**变更探测器**，不是端到端验证；第 3 个用例是**真实调用**
 * `AttemptCompletionHandler.handlePartialBlock`（该路径只需 `uiHelpers.say` / `removeClosingTag`
 * / `getConfig`，无需完整 TaskConfig，故可真实执行）。`execute()` 的两处展示点需要完整
 * TaskConfig 测试基建（本仓库暂无），只能落在结构守卫里。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
// 无扩展名的相对导入：ESM 解析会 `ERR_MODULE_NOT_FOUND` ⇒ mocha 回落到 `require`（ts-node CJS）
// ⇒ 模块级 `__dirname` 可用（同 blockingIdempotence.test.ts / priorityGate.p5.test.ts 的仓库惯例）。
import { AttemptCompletionHandler } from "../../tools/handlers/AttemptCompletionHandler"

const cfg = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "types", "TaskConfig.ts"), "utf-8")
const handler = fs.readFileSync(path.join(__dirname, "..", "..", "tools", "handlers", "AttemptCompletionHandler.ts"), "utf-8")
const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")

const copyBlock = (copy: string): string =>
	`<teaching_intervention_copy rule="no_edit_streak" severity="gentle">\n${copy}\n</teaching_intervention_copy>`

describe("【P6/T4】attempt_completion 展示路径", () => {
	it("★ 回调已声明并被 handler 的两处具体调用点使用", () => {
		expect(cfg).to.include("applyInterventionDisplay?")
		expect(handler).to.include("uiHelpers.getConfig().callbacks.applyInterventionDisplay?.(rest)") // partial 阶段
		expect(handler).to.include("config.callbacks.applyInterventionDisplay?.(rest)") // 两处 completion_result 展示
	})

	it("★ Task 侧只实现一次（DRY）：文本块路径复用同一方法", () => {
		expect(taskSrc).to.include("private async applyInterventionDisplay(")
		expect(taskSrc).to.include("this.applyInterventionDisplay(")
		expect(taskSrc).to.include("applyInterventionDisplay: (text: string) => this.applyInterventionDisplay(text)")
	})

	it("★ 真实调用 partial 展示：正文交给回调，且回调返回值被用进学生可见文案", async () => {
		const completionHandler = new AttemptCompletionHandler()
		const hookInput: string[] = []
		const said: Array<{ type: string; text?: string }> = []
		const helpers = {
			say: async (type: string, text?: string) => {
				said.push({ type, text })
				return undefined
			},
			removeClosingTag: (_block: unknown, _tag: string, text?: string) => text ?? "",
			getConfig: () => ({
				callbacks: {
					// 最小替身：复刻 Task 侧「兜底文案前置」的可见语义（真实实现见 Task.applyInterventionDisplay）。
					// 断言点在**回调被调用且返回值生效** —— 旧代码根本不调回调 ⇒ 兜底文案永不出现。
					applyInterventionDisplay: async (text: string) => {
						hookInput.push(text)
						return `💡 模板兜底：先动手写一版。\n\n---\n\n${text}`
					},
				},
			}),
		} as unknown as Parameters<typeof completionHandler.handlePartialBlock>[1]

		const copy = "我刚刚给了实现。你先动手写第一版？"
		await completionHandler.handlePartialBlock(
			{ name: "attempt_completion", partial: true, params: { result: `${copyBlock(copy)}\n\n---\n\n正文内容。` } } as never,
			helpers,
		)

		// ① 回调被真实调用，且拿到的是**已剥离回执块**的正文（模型文案不进回调参数）
		expect(hookInput).to.have.lengthOf(1)
		expect(hookInput[0]).to.not.include("<teaching_intervention_copy")
		expect(hookInput[0]).to.include("正文内容。")
		// ② 回调的返回值进入学生可见文案（兜底模板这次真的发得出去）
		expect(said).to.have.lengthOf(1)
		expect(said[0].type).to.equal("completion_result")
		expect(said[0].text).to.include("💡 模板兜底：先动手写一版。")
		expect(said[0].text).to.not.include("<teaching_intervention_copy")
	})
})
