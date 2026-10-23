import { expect } from "chai"
import fs from "fs"
import os from "os"
import path from "path"
import {
	BEHAVIOR_DEMAND_LADDER,
	BEHAVIOR_SIGNALS_MAX_LENGTH,
	classifyAssistantTurn,
	classifyStudentMessage,
	detectCodeKind,
	formatBehaviorSignals,
	toLegacyQueryType,
} from "../behaviorClassify"
import { BEHAVIOR_WEIGHTS } from "../metricsSpec"
import { DEMAND_LADDER } from "../../TeachingSessionMode"
import { StudentLogPersister } from "../../../task/student-analytics/StudentLogPersister"
import type { StudentInteractionLog } from "../../../task/student-analytics/types"

/** 一份可直接运行的完整 Python 实现（fenced，≥6 行、有结构、无占位符、无中文伪代码） */
const FULL_PYTHON_IMPL = [
	"```python",
	"def bubble_sort(arr):",
	"    n = len(arr)",
	"    for i in range(n):",
	"        for j in range(n - i - 1):",
	"            if arr[j] > arr[j + 1]:",
	"                arr[j], arr[j + 1] = arr[j + 1], arr[j]",
	"    return arr",
	"",
	"print(bubble_sort([3, 1, 2]))",
	"```",
].join("\n")

/** 中文完整伪代码：步骤 1..n + 控制流 + 输入输出，无占位符 */
const COMPLETE_PSEUDO_CODE = [
	"步骤1：输入一个数组",
	"步骤2：循环遍历数组的每个元素",
	"步骤3：判断相邻两个元素的大小，如果前面比后面大就交换",
	"步骤4：重复以上过程直到没有交换发生",
	"步骤5：输出排序后的数组",
].join("\n")

/** 方向性伪代码：含占位符「这里自己补」 */
const PARTIAL_PSEUDO_CODE = ["步骤1：输入数组", "步骤2：这里自己补", "步骤3：输出结果"].join("\n")

describe("behaviorClassify — 六类行为分类器（P2-1）", () => {
	describe("detectCodeKind — R1 伪代码判定", () => {
		it("完整可运行的 fenced 实现 → full", () => {
			expect(detectCodeKind(FULL_PYTHON_IMPL)).to.equal("full")
		})

		it("中文完整伪代码（签名/步骤 + 控制流 + 输出 + 要点词）→ pseudo_complete", () => {
			expect(detectCodeKind(COMPLETE_PSEUDO_CODE)).to.equal("pseudo_complete")
		})

		it("含占位符（TODO / 省略 / 自行补充 / …）→ pseudo_partial", () => {
			expect(detectCodeKind(PARTIAL_PSEUDO_CODE)).to.equal("pseudo_partial")
			expect(detectCodeKind("```python\n# TODO: 补全排序逻辑\nreturn arr\n```")).to.equal("pseudo_partial")
			expect(detectCodeKind("```python\ndef f():\n    ...\n```")).to.equal("pseudo_partial")
			expect(detectCodeKind("```\n步骤1：读取输入\n步骤2：自行补充\n```")).to.equal("pseudo_partial")
		})

		it("不足 5 行且无签名/无控制流 → snippet", () => {
			expect(detectCodeKind("```py\nprint(a)\nprint(b)\n```")).to.equal("snippet")
			expect(detectCodeKind("")).to.equal("snippet")
			expect(detectCodeKind(undefined)).to.equal("snippet")
			expect(detectCodeKind(null)).to.equal("snippet")
		})

		it("自然语言讲解（含 for/if/return 字样）不被误判成伪代码 → snippet", () => {
			expect(detectCodeKind("这段代码的作用是先遍历数组，然后判断条件，最后返回结果。")).to.equal("snippet")
		})

		it("BN-31：10 万字符不卡死（<300ms）", () => {
			const huge = `什么是列表？${"a".repeat(100_000)}`
			const startedAt = Date.now()
			const result = detectCodeKind(huge)
			const elapsed = Date.now() - startedAt
			expect(result).to.be.oneOf(["snippet", "pseudo_partial", "pseudo_complete", "full"])
			expect(elapsed).to.be.lessThan(300)
		})
	})

	describe("classifyStudentMessage — 计划断言 1/2/3/9/10 与优先级", () => {
		it("断言 1：「什么是列表」→ concept 0.25", () => {
			const result = classifyStudentMessage({ text: "什么是列表" })
			expect(result.type).to.equal("concept")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.concept)
			expect(result.signals).to.contain("什么是")
		})

		it("断言 2：「这个功能该怎么设计」→ design 0.75", () => {
			const result = classifyStudentMessage({ text: "这个功能该怎么设计" })
			expect(result.type).to.equal("design")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.design)
			expect(result.signals).to.contain("怎么设计")
		})

		it("断言 3：「报错 KeyError 怎么解决」→ error_help 1.0（含最近失败运行信号）", () => {
			const result = classifyStudentMessage({ text: "报错 KeyError 怎么解决", hasRecentError: true })
			expect(result.type).to.equal("error_help")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.error_help)
			expect(result.signals).to.contain("recent_run_failed")
			// 无最近失败运行、仅文本信号也判 error_help
			expect(classifyStudentMessage({ text: "报错 KeyError 怎么解决" }).type).to.equal("error_help")
		})

		it("断言 9：「你好」「谢谢」→ other，权重 0（不入分子分母）", () => {
			for (const text of ["你好", "谢谢", "hello", "好的"]) {
				const result = classifyStudentMessage({ text })
				expect(result.type).to.equal("other")
				expect(result.weight).to.equal(0)
				expect(result.signals.length).to.be.at.most(BEHAVIOR_SIGNALS_MAX_LENGTH)
				expect(result.signals).to.equal("greeting")
			}
		})

		it("断言 10：同一条消息既报错又索要完整实现 → error_help（优先级）", () => {
			const result = classifyStudentMessage({ text: "报错了，直接给我完整代码", demandCount: 1 })
			expect(result.type).to.equal("error_help")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.error_help)
			expect(result.signals).not.to.contain("full_impl_demand")
		})

		it("完整实现索要未放行 → design + full_impl_demand/demand_pending", () => {
			const result = classifyStudentMessage({ text: "直接给我完整代码", mode: "free", demandCount: 1 })
			expect(result.type).to.equal("design")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.design)
			expect(result.signals).to.contain("full_impl_demand")
			expect(result.signals).to.contain("demand_pending")
		})

		it("【P1-6】放行阶梯：free 第 3 次放行、experiment 第 3 次仍不放行", () => {
			expect(classifyStudentMessage({ text: "直接给我完整代码", mode: "free", demandCount: 3 }).signals).to.contain(
				"demand_released",
			)
			expect(
				classifyStudentMessage({ text: "直接给我完整代码", mode: "experiment", demandCount: 3 }).signals,
			).to.contain("demand_pending")
			expect(
				classifyStudentMessage({ text: "直接给我完整代码", mode: "experiment", demandCount: 4 }).signals,
			).to.contain("demand_released")
		})

		it("需求阶梯常量与 TeachingSessionMode.DEMAND_LADDER 一致（防漂移）", () => {
			expect(BEHAVIOR_DEMAND_LADDER).to.deep.equal({
				free: DEMAND_LADDER.free,
				experiment: DEMAND_LADDER.experiment,
			})
		})

		it("自述写不出来 → design + inability 信号", () => {
			const result = classifyStudentMessage({ text: "我写不出来" })
			expect(result.type).to.equal("design")
			expect(result.signals).to.contain("inability")
		})

		it("TaskClassifier 回退：重构请求 → design（category 信号）", () => {
			const result = classifyStudentMessage({ text: "帮我重构一下这段代码" })
			expect(result.type).to.equal("design")
			expect(result.signals).to.contain("category:refactoring")
		})

		it("TaskClassifier 回退：算法类问题 → concept", () => {
			const result = classifyStudentMessage({ text: "快速排序的时间复杂度" })
			expect(result.type).to.equal("concept")
			expect(result.signals).to.contain("category:algorithm")
		})

		it("design 优先于 concept：「什么是列表，怎么实现它」→ design", () => {
			expect(classifyStudentMessage({ text: "什么是列表，怎么实现它" }).type).to.equal("design")
		})

		it("栈 ≥3 行即使没有报错关键词也判 error_help", () => {
			const stack = ["at foo (a.js:1:2)", "at bar (b.js:3:4)", "at baz (c.js:5:6)"].join("\n")
			const result = classifyStudentMessage({ text: stack })
			expect(result.type).to.equal("error_help")
			expect(result.signals).to.contain("stack:3行")
		})

		it("BN-32：中英混排分类正确", () => {
			expect(classifyStudentMessage({ text: "What is 列表？和 linked list 有什么区别" }).type).to.equal("concept")
			expect(classifyStudentMessage({ text: "KeyError: 报错怎么解决" }).type).to.equal("error_help")
			expect(classifyStudentMessage({ text: "How should I design this 功能" }).type).to.equal("design")
		})

		it("BN-31：10 万字符文本分类不卡死（<300ms）", () => {
			const huge = `什么是列表？${"a".repeat(100_000)}`
			const startedAt = Date.now()
			const result = classifyStudentMessage({ text: huge })
			const elapsed = Date.now() - startedAt
			expect(result.type).to.equal("concept")
			expect(elapsed).to.be.lessThan(300)
		})

		it("BN-34：无信号历史消息 → other 且权重 0", () => {
			const result = classifyStudentMessage({ text: "嗯" })
			expect(result.type).to.equal("other")
			expect(result.weight).to.equal(0)
		})

		it("空输入 / null 输入不抛错 → other", () => {
			expect(classifyStudentMessage().type).to.equal("other")
			expect(classifyStudentMessage(null).type).to.equal("other")
			expect(classifyStudentMessage({ text: "" }).type).to.equal("other")
			expect(classifyStudentMessage({ text: undefined }).weight).to.equal(0)
		})

		it("带代码但无关键词 → design（hasCode 信号）", () => {
			const result = classifyStudentMessage({ text: "看看这个", hasCode: true })
			expect(result.type).to.equal("design")
			expect(result.signals).to.contain("hasCode")
		})

		it("behaviorSignals 始终 ≤120 字", () => {
			const noisy = `报错 ${"Traceback Error Exception 异常 undefined 段错误 编译错误 崩溃 ".repeat(10)}`
			expect(classifyStudentMessage({ text: noisy }).signals.length).to.be.at.most(BEHAVIOR_SIGNALS_MAX_LENGTH)
		})
	})

	describe("classifyAssistantTurn — 计划断言 5/6/7/8", () => {
		it("断言 5：write_to_file 整文件落盘 → ai_code 1.2（codeKind=full）", () => {
			const result = classifyAssistantTurn({ text: "已写入文件", toolsUsed: ["write_to_file"] })
			expect(result.type).to.equal("ai_code")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.ai_code)
			expect(result.codeKind).to.equal("full")
			expect(result.signals).to.contain("tools:write_to_file")
		})

		it("完整代码块 → ai_code（codeKind=full）", () => {
			const result = classifyAssistantTurn({ text: FULL_PYTHON_IMPL })
			expect(result.type).to.equal("ai_code")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.ai_code)
			expect(result.codeKind).to.equal("full")
		})

		it("断言 6：完整伪代码（无占位符）→ ai_code（codeKind=pseudo_complete）", () => {
			const result = classifyAssistantTurn({ text: COMPLETE_PSEUDO_CODE })
			expect(result.type).to.equal("ai_code")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.ai_code)
			expect(result.codeKind).to.equal("pseudo_complete")
		})

		it("断言 7：方向性伪代码（含「这里自己补」）→ design 0.75", () => {
			const result = classifyAssistantTurn({ text: PARTIAL_PSEUDO_CODE })
			expect(result.type).to.equal("design")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.design)
			expect(result.codeKind).to.equal("pseudo_partial")
		})

		it("BN-33：代码块含 TODO 但正文完整 → pseudo_partial + signals 记录理由", () => {
			const text = [
				"实现思路已经很完整：先遍历数组，再交换相邻元素。",
				"```python",
				"def sort(arr):",
				"    # TODO: 补全排序逻辑",
				"    return arr",
				"```",
			].join("\n")
			const result = classifyAssistantTurn({ text, hasFullImpl: false })
			expect(result.type).to.equal("design")
			expect(result.codeKind).to.equal("pseudo_partial")
			expect(result.signals).to.contain("placeholder:TODO")
		})

		it("断言 8：3 行片段 → design 0.75（codeKind=snippet）", () => {
			const result = classifyAssistantTurn({ text: "```py\nprint(a)\nprint(b)\n```" })
			expect(result.type).to.equal("design")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.design)
			expect(result.codeKind).to.equal("snippet")
		})

		it("纯讲解（无代码诉求）→ design", () => {
			const result = classifyAssistantTurn({ text: "这段代码的作用是把两个数相加，并返回结果。" })
			expect(result.type).to.equal("design")
			expect(result.weight).to.equal(BEHAVIOR_WEIGHTS.design)
		})

		it("寒暄 → other 权重 0", () => {
			for (const text of ["你好", "谢谢", "hello"]) {
				const result = classifyAssistantTurn({ text })
				expect(result.type).to.equal("other")
				expect(result.weight).to.equal(0)
			}
		})

		it("空回合（无文本无工具）→ other", () => {
			expect(classifyAssistantTurn({}).type).to.equal("other")
			expect(classifyAssistantTurn(null).type).to.equal("other")
		})

		it("hasFullImpl 显式 true 时不重复检测 → ai_code", () => {
			const result = classifyAssistantTurn({ text: "可以", hasFullImpl: true })
			expect(result.type).to.equal("ai_code")
			expect(result.codeKind).to.equal("full")
		})

		it("显式 codeKind 覆盖检测（调用方已算好时优先）", () => {
			expect(classifyAssistantTurn({ text: "随便说说", codeKind: "full" }).type).to.equal("ai_code")
			expect(classifyAssistantTurn({ text: FULL_PYTHON_IMPL, codeKind: "snippet" }).type).to.equal("design")
		})

		it("非写文件工具 + 纯解释 → 仍是 design", () => {
			const result = classifyAssistantTurn({ text: "这段代码的作用是把两个数相加，并返回结果。", toolsUsed: ["execute_command"] })
			expect(result.type).to.equal("design")
		})

		it("behaviorSignals 始终 ≤120 字", () => {
			const result = classifyAssistantTurn({
				text: "```python\n# TODO\n```",
				toolsUsed: ["write_to_file", "replace_in_file", "execute_command", "read_file", "search_files"],
			})
			expect(result.signals.length).to.be.at.most(BEHAVIOR_SIGNALS_MAX_LENGTH)
		})
	})

	describe("formatBehaviorSignals — 字符串格式", () => {
		it("逗号连接、去重、空输入兜底", () => {
			expect(formatBehaviorSignals([])).to.equal("no_signal")
			expect(formatBehaviorSignals(["a", "a", "b"])).to.equal("a,b")
			expect(formatBehaviorSignals(["   ", "x"])).to.equal("x")
		})

		it("超长时丢弃尾部 token 并保持 ≤120 字", () => {
			const tokens = Array.from({ length: 30 }, (_, index) => `signal_${index}`)
			const result = formatBehaviorSignals(tokens)
			expect(result.length).to.be.at.most(BEHAVIOR_SIGNALS_MAX_LENGTH)
			expect(result.startsWith("signal_0")).to.equal(true)
		})
	})

	describe("toLegacyQueryType — 旧 queryType 字段映射（设计 §5.1）", () => {
		it("concept→concept、design|error_help→coding、other→other", () => {
			expect(toLegacyQueryType("concept")).to.equal("concept")
			expect(toLegacyQueryType("design")).to.equal("coding")
			expect(toLegacyQueryType("error_help")).to.equal("coding")
			expect(toLegacyQueryType("other")).to.equal("other")
			// self_code / ai_code 不是消息类事件，兜底归 coding
			expect(toLegacyQueryType("self_code")).to.equal("coding")
			expect(toLegacyQueryType("ai_code")).to.equal("coding")
		})
	})

	describe("StudentLogPersister 透传 P2-1 新字段", () => {
		const baseLog = (overrides: Partial<StudentInteractionLog> = {}): StudentInteractionLog => ({
			ts: "2026-10-20T10:00:00.000Z",
			taskId: "task-1",
			eventType: "turn_message",
			role: "user",
			category: "other",
			queryType: "concept",
			dependencyWeight: 0.25,
			contentLength: 5,
			hasCode: false,
			languageHint: "unknown",
			imageCount: 0,
			fileCount: 0,
			turnIndex: 0,
			...overrides,
		})

		it("persist 后读回：behaviorType/behaviorWeight/behaviorSource/behaviorSignals/codeKind 全部保留", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-behavior-log-"))
			try {
				const persister = new StudentLogPersister(dir)
				await persister.persist(
					baseLog({
						behaviorType: "concept",
						behaviorWeight: 0.25,
						behaviorSource: "rule",
						behaviorSignals: "什么是",
						codeKind: "snippet",
					}),
				)
				const [persisted] = await persister.readAll()
				expect(persisted.behaviorType).to.equal("concept")
				expect(persisted.behaviorWeight).to.equal(0.25)
				expect(persisted.behaviorSource).to.equal("rule")
				expect(persisted.behaviorSignals).to.equal("什么是")
				expect(persisted.codeKind).to.equal("snippet")
				// 旧字段不受影响
				expect(persisted.queryType).to.equal("concept")
				expect(persisted.dependencyWeight).to.equal(0.25)
			} finally {
				fs.rmSync(dir, { recursive: true, force: true })
			}
		})

		it("setContext 盖章 mode/experimentId 时新字段仍然透传", async () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-behavior-log-"))
			try {
				const persister = new StudentLogPersister(dir)
				persister.setContext({ mode: "experiment", experimentId: "exp-1" })
				await persister.persist(
					baseLog({
						behaviorType: "ai_code",
						behaviorWeight: 1.2,
						behaviorSource: "rule",
						behaviorSignals: "hasFullImpl,codeKind=full",
						codeKind: "full",
					}),
				)
				const [persisted] = await persister.readAll()
				expect(persisted.mode).to.equal("experiment")
				expect(persisted.experimentId).to.equal("exp-1")
				expect(persisted.behaviorType).to.equal("ai_code")
				expect(persisted.behaviorWeight).to.equal(1.2)
				expect(persisted.behaviorSignals).to.equal("hasFullImpl,codeKind=full")
				expect(persisted.codeKind).to.equal("full")
			} finally {
				fs.rmSync(dir, { recursive: true, force: true })
			}
		})
	})
})
