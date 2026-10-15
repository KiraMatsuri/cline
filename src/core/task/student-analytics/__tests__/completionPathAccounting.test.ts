/**
 * 【P6/T4】实测：12:59:47 与 13:05:48 两条 gentle 决策**零可见文案**（M9' ③ 恰好差 2）。
 * 原因：整轮回答走 `attempt_completion`（模型只调这一个工具）⇒ 展示路径是
 * `AttemptCompletionHandler`，它只剥离回执块，**不追加兜底模板、不记账**，
 * 于是"模型没写回执块 ⇒ 用模板兜底"这条链（interventionDisplay 分支 ③）根本没被调用。
 *
 * ⚠️ 覆盖边界（review F1/F2 之后的契约）：
 * - **partial 帧**（`handlePartialBlock`）只剥离，**不得**调用展示钩子 —— 钩子含兜底 + 记账 + 置位，
 *   在流式中间帧调用会让兜底文案进不了学生最终保留的那条消息，并让记账名额被中间帧抢占。
 *   本文件用**真实调用 + 间谍钩子**钉住这条边界（第 3 个用例）。
 * - `execute()` 的两处（非 partial）展示点会真调钩子；它们需要完整 TaskConfig 测试基建
 *   （本仓库暂无，且真实调用会触发 hook 发现 / telemetry / checkpoint 等副作用），
 *   因此只能用**结构断言**（调用点恰好 2 处 + partial 段不含钩子）。
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
	it("★ 结构：钩子只在 execute() 的 2 处调用点出现，partial 路径一处都没有", () => {
		expect(cfg).to.include("applyInterventionDisplay")
		// 【F4】必填（唯一生产者 `ToolExecutor.asToolConfig()`，构造参数也是必填）：声明里没有 `?`
		expect(cfg).to.not.include("applyInterventionDisplay?:")
		// execute() 的两处 completion_result 展示点（计数断言，不做逐字空白匹配）
		const hookCalls = (handler.match(/config\.callbacks\.applyInterventionDisplay\?\.\(rest\)/g) ?? []).length
		expect(hookCalls, "execute() 的两处 completion_result 展示点").to.equal(2)
		// partial 路径不得调用钩子
		// （注释里会**提到**这个钩子的名字来解释契约，所以断言的是「调用形态」而不是裸子串）
		const partialStart = handler.indexOf("async handlePartialBlock")
		const partialEnd = handler.indexOf("async execute(", partialStart)
		expect(partialStart, "handlePartialBlock 必须存在").to.be.greaterThan(-1)
		expect(partialEnd, "execute 必须存在").to.be.greaterThan(partialStart)
		const partialSrc = handler.slice(partialStart, partialEnd)
		expect(partialSrc).to.not.include("callbacks.applyInterventionDisplay")
		expect((partialSrc.match(/applyInterventionDisplay\?\.\(/g) ?? []).length, "partial 段的钩子调用数").to.equal(0)
	})

	it("★ 结构（DRY）：Task 侧只实现一次（文本块路径复用同一方法）", () => {
		expect(taskSrc).to.include("private async applyInterventionDisplay(")
		expect(taskSrc).to.include("this.applyInterventionDisplay(content)")
		expect(taskSrc).to.include("(text: string) => this.applyInterventionDisplay(text)")
	})

	it("★ 真实调用 partial 展示：不调展示钩子（不兜底/不记账/不置位），回执块仍被剥离", async () => {
		const completionHandler = new AttemptCompletionHandler()
		let hookCalls = 0
		const said: Array<{ type: string; text?: string }> = []
		const helpers = {
			say: async (type: string, text?: string) => {
				said.push({ type, text })
				return undefined
			},
			removeClosingTag: (_block: unknown, _tag: string, text?: string) => text ?? "",
			// 间谍钩子：partial 帧哪怕只调一次也说明 F1 的边界被改坏
			// （兜底会进到一条随后被 `:117-127` 删掉的流式消息里；记账名额还会被中间帧抢占）。
			getConfig: () => ({
				callbacks: {
					applyInterventionDisplay: async (text: string) => {
						hookCalls++
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

		// ① partial 帧不得调钩子（F1 的核心边界）
		expect(hookCalls, "partial 帧不得调用展示钩子").to.equal(0)
		// ② 剥离仍生效：既没有回执块标签，也没有模型写进块里的文案（承接 F13 spec 的既有断言）
		expect(said).to.have.lengthOf(1)
		expect(said[0].type).to.equal("completion_result")
		expect(said[0].text).to.not.include("<teaching_intervention_copy")
		expect(said[0].text).to.not.include(copy)
		expect(said[0].text).to.include("正文内容。")
	})
})
