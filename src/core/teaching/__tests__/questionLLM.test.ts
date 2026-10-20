import "should"
import { describe, it } from "mocha"

import {
	describeLLMFailure,
	describeLLMUnavailable,
	formatQuestionLLMTarget,
	isAuthFailure,
	resolveQuestionLLMTarget,
	resolveQuestionLLMTargets,
} from "../submission/questionLLM"

// v2.13.1：出题直接复用 Cline 自带设置里的 provider / API Key / 模型。
// 这里只覆盖纯解析逻辑。早期版本读 `config.apiProvider`（Cline 里根本没有这个字段），
// 于是「明明配好了模型也永远退化成通用题」，学生只好去工作区 .env 里另填 key。
describe("questionLLM（出题复用 Cline 的模型配置）", () => {
	describe("resolveQuestionLLMTarget", () => {
		it("优先使用 act 模式（主对话默认配置）", () => {
			const target = resolveQuestionLLMTarget({
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-sonnet-4",
				planModeApiProvider: "openrouter",
				planModeApiModelId: "deepseek/deepseek-chat",
			})
			target?.mode.should.equal("act")
			target?.provider.should.equal("anthropic")
			target?.model?.should.equal("claude-sonnet-4")
		})

		it("act 未配置时退回 plan 模式及其模型", () => {
			const target = resolveQuestionLLMTarget({
				actModeApiProvider: "",
				planModeApiProvider: "openrouter",
				planModeApiModelId: "deepseek/deepseek-chat",
			})
			target?.mode.should.equal("plan")
			target?.provider.should.equal("openrouter")
			target?.model?.should.equal("deepseek/deepseek-chat")
		})

		it("act 有 provider 但没有模型 id 时模型为空（交给 provider 默认模型）", () => {
			const target = resolveQuestionLLMTarget({ actModeApiProvider: "cline" })
			target?.provider.should.equal("cline")
			const hasModel = target?.model !== undefined
			hasModel.should.equal(false)
		})

		it("两种模式都没配 provider 时返回 null", () => {
			const blank = resolveQuestionLLMTarget({ actModeApiProvider: "  ", planModeApiProvider: "" })
			const none = resolveQuestionLLMTarget(null)
			const undef = resolveQuestionLLMTarget(undefined)
			const allNull = blank === null && none === null && undef === null
			allNull.should.equal(true)
		})

		it("纯空格的 provider 视为未配置，不会把空串当模型", () => {
			const target = resolveQuestionLLMTarget({
				actModeApiProvider: "   ",
				planModeApiProvider: " openrouter ",
				planModeApiModelId: "   ",
			})
			target?.mode.should.equal("plan")
			target?.provider.should.equal("openrouter")
			const hasModel = target?.model !== undefined
			hasModel.should.equal(false)
		})
	})

	describe("resolveQuestionLLMTargets", () => {
		it("act 与 plan 都配置且不同时，先 act 后 plan（各自带模型）", () => {
			const targets = resolveQuestionLLMTargets({
				actModeApiProvider: "anthropic",
				actModeApiModelId: "claude-sonnet-4",
				planModeApiProvider: "openrouter",
				planModeApiModelId: "deepseek/deepseek-chat",
			})
			targets.length.should.equal(2)
			targets[0].mode.should.equal("act")
			targets[0].provider.should.equal("anthropic")
			targets[1].mode.should.equal("plan")
			targets[1].model?.should.equal("deepseek/deepseek-chat")
		})

		it("只配了 act 时只有一个目标", () => {
			const targets = resolveQuestionLLMTargets({ actModeApiProvider: "cline" })
			targets.length.should.equal(1)
			targets[0].provider.should.equal("cline")
		})

		it("只配了 plan 时不会重复吐出同一个 plan 目标", () => {
			const targets = resolveQuestionLLMTargets({
				actModeApiProvider: "",
				planModeApiProvider: "openrouter",
				planModeApiModelId: "deepseek/deepseek-chat",
			})
			targets.length.should.equal(1)
			targets[0].mode.should.equal("plan")
		})

		it("act 与 plan 是同一个 provider 时只保留 act（避免同一次失败重试两遍）", () => {
			const targets = resolveQuestionLLMTargets({
				actModeApiProvider: "anthropic",
				planModeApiProvider: "anthropic",
			})
			targets.length.should.equal(1)
			targets[0].mode.should.equal("act")
		})

		it("两种模式都为空时返回空数组", () => {
			const empty = resolveQuestionLLMTargets({})
			const none = resolveQuestionLLMTargets(null)
			const bothEmpty = empty.length === 0 && none.length === 0
			bothEmpty.should.equal(true)
		})
	})

	describe("isAuthFailure", () => {
		it("401 / 403 / 缺 key / 额度不足判为鉴权类", () => {
			const samples = [
				new Error("401 Unauthorized"),
				new Error("403 Forbidden"),
				new Error("invalid api key"),
				new Error("No API key configured for provider"),
				new Error("insufficient credit balance"),
			]
			const allAuth = samples.every((error) => isAuthFailure(error))
			allAuth.should.equal(true)
		})

		it("网络类错误不判为鉴权失败（换模型也没用）", () => {
			const samples = [new Error("socket hang up"), new Error("model overloaded, retry later"), new Error("ETIMEDOUT")]
			const noneAuth = samples.every((error) => !isAuthFailure(error))
			noneAuth.should.equal(true)
		})

		it("非 Error 入参也不抛异常", () => {
			isAuthFailure(undefined).should.equal(false)
			isAuthFailure("401").should.equal(true)
		})
	})

	describe("formatQuestionLLMTarget", () => {
		it("带模型时输出 provider · model", () => {
			const caption = formatQuestionLLMTarget({
				mode: "act",
				provider: "openrouter",
				model: "deepseek/deepseek-chat",
			})
			;(caption ?? "").should.equal("openrouter · deepseek/deepseek-chat")
		})

		it("没有模型时只输出 provider；没有 target 时返回 undefined", () => {
			const only = formatQuestionLLMTarget({ mode: "act", provider: "ollama" })
			;(only ?? "").should.equal("ollama")

			const missing = formatQuestionLLMTarget(null)
			const isUndefined = missing === undefined
			isUndefined.should.equal(true)
		})
	})

	describe("describeLLMUnavailable", () => {
		it("未配置模型时指向 Cline 设置项", () => {
			const text = describeLLMUnavailable({})
			text.should.containEql("Cline")
			text.should.containEql("API 配置")
		})

		it("已配置但出题未成功时点名模型", () => {
			const text = describeLLMUnavailable({ actModeApiProvider: "anthropic", actModeApiModelId: "claude-sonnet-4" })
			text.should.containEql("anthropic · claude-sonnet-4")
			text.should.containEql("通用思考题")
		})
	})

	describe("describeLLMFailure", () => {
		const target = { mode: "act" as const, provider: "openrouter", model: "deepseek/deepseek-chat" }

		it("401 / 缺 key 翻译成去 Cline 设置检查密钥", () => {
			const text = describeLLMFailure(new Error("401 Unauthorized: invalid api key"), target)
			text.should.containEql("API Key")
			text.should.containEql("Cline 设置")
			text.should.not.containEql("401")
		})

		it("普通错误保留原文并带上模型名", () => {
			const text = describeLLMFailure(new Error("model overloaded, retry later"), target)
			text.should.containEql("openrouter · deepseek/deepseek-chat")
			text.should.containEql("model overloaded")
		})

		it("超长错误被截断；非 Error 入参也能处理", () => {
			const long = `socket hang up ${"x".repeat(500)}`
			const text = describeLLMFailure(long, target, { maxLength: 40 })
			text.length.should.be.below(120)
			describeLLMFailure(undefined, target).should.containEql("调用失败")
		})
	})
})
