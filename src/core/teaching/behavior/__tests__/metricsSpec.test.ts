import { expect } from "chai"
import {
	ADOPTION_WINDOW_TURNS,
	BEHAVIOR_TYPES,
	BEHAVIOR_WEIGHTS,
	DEPENDENCY_DIVISOR,
	ERROR_WINDOW_TURNS,
	GUIDANCE_WINDOW_TURNS,
	MAX_BEHAVIOR_WEIGHT,
	METRICS_SCHEMA,
	QUERY_TYPE_FALLBACK,
	adoptionDeepening,
	behaviorMix,
	computeDependenceMetrics,
	dependencyCount,
	depIndex,
	errorResolutionRate,
	eventWeight,
	guidanceEffect,
	resolveBehaviorType,
	round6,
	selfCodingRatio,
	weightedMean,
} from "../metricsSpec"
import type { MetricsEvent } from "../metricsSpec"

/** 事件工厂：默认是一条普通用户消息事件 */
function event(overrides: Partial<MetricsEvent> = {}): MetricsEvent {
	return {
		ts: "2026-10-20T10:00:00.000Z",
		taskId: "task-1",
		eventType: "turn_message",
		role: "user",
		turnIndex: 0,
		...overrides,
	}
}

function asEventList(value: unknown): readonly MetricsEvent[] {
	return value as readonly MetricsEvent[]
}

/** 捕获 console.warn 调用（BN-40 断言用），结束后恢复原函数 */
function captureWarnings(run: () => void): unknown[][] {
	const original = console.warn
	const calls: unknown[][] = []
	console.warn = (...args: unknown[]) => {
		calls.push(args)
	}
	try {
		run()
	} finally {
		console.warn = original
	}
	return calls
}

describe("metricsSpec — 行为加权指标契约（P2-1/P2-4）", () => {
	describe("常量与 round6", () => {
		it("常量逐字符合 docs/design/metrics-spec.md", () => {
			expect(METRICS_SCHEMA).to.equal("behavior-weighted/v1")
			expect(BEHAVIOR_TYPES).to.deep.equal(["concept", "design", "error_help", "self_code", "ai_code", "other"])
			expect(BEHAVIOR_WEIGHTS).to.deep.equal({
				concept: 0.25,
				design: 0.75,
				error_help: 1.0,
				self_code: 0,
				ai_code: 1.2,
			})
			expect(DEPENDENCY_DIVISOR).to.equal(1.2)
			expect(MAX_BEHAVIOR_WEIGHT).to.equal(1.2)
			expect(ADOPTION_WINDOW_TURNS).to.equal(5)
			expect(GUIDANCE_WINDOW_TURNS).to.equal(3)
			expect(ERROR_WINDOW_TURNS).to.equal(5)
			expect(QUERY_TYPE_FALLBACK).to.deep.equal({
				concept: "concept",
				design: "design",
				error_help: "error_help",
				coding: "design",
				other: "other",
			})
		})

		it("round6 按 Math.round(x * 1e6) / 1e6 舍入到 6 位", () => {
			expect(round6(1 / 3)).to.equal(0.333333)
			expect(round6(0.10416666666666667)).to.equal(0.104167)
			expect(round6(1.75 / 2.4)).to.equal(0.729167)
			expect(round6(-1.2345678)).to.equal(-1.234568)
		})

		it("round6 对整数与契约内权重保持原值", () => {
			expect(round6(0)).to.equal(0)
			expect(round6(1)).to.equal(1)
			expect(round6(1.2)).to.equal(1.2)
			expect(round6(0.25)).to.equal(0.25)
		})
	})

	describe("resolveBehaviorType — 契约 §3 优先级", () => {
		it("新字段 behaviorType 永远优先（BN-41）", () => {
			for (const type of BEHAVIOR_TYPES) {
				expect(resolveBehaviorType(event({ behaviorType: type }))).to.equal(type)
			}
			// 与低优先级规则冲突时，新字段仍然胜出
			expect(resolveBehaviorType(event({ behaviorType: "concept", eventType: "code_edit", editor: "ai" }))).to.equal(
				"concept",
			)
			expect(
				resolveBehaviorType(event({ behaviorType: "self_code", queryType: "concept", role: "assistant", hasFullImpl: true })),
			).to.equal("self_code")
		})

		it("behaviorType 非法值时回退到后续规则", () => {
			expect(resolveBehaviorType(event({ behaviorType: "bogus", queryType: "coding" }))).to.equal("design")
		})

		it("code_edit 按 editor 归属解析（缺省按人工）", () => {
			expect(resolveBehaviorType(event({ eventType: "code_edit", editor: "ai" }))).to.equal("ai_code")
			expect(resolveBehaviorType(event({ eventType: "code_edit", editor: "user" }))).to.equal("self_code")
			expect(resolveBehaviorType(event({ eventType: "code_edit" }))).to.equal("self_code")
		})

		it("file_save 记自主编码", () => {
			expect(resolveBehaviorType(event({ eventType: "file_save", editor: "ai" }))).to.equal("self_code")
		})

		it("旧事件回退：queryType 全映射（PLAN 测试 15）", () => {
			for (const [queryType, expected] of Object.entries(QUERY_TYPE_FALLBACK)) {
				expect(resolveBehaviorType(event({ queryType }))).to.equal(expected)
			}
			expect(resolveBehaviorType(event({ queryType: "concept" }))).to.equal("concept")
			expect(resolveBehaviorType(event({ queryType: "coding" }))).to.equal("design")
			expect(resolveBehaviorType(event({ queryType: "other" }))).to.equal("other")
		})

		it("queryType 非法值（含原型链键）不参与映射 → other", () => {
			expect(resolveBehaviorType(event({ queryType: "toString" }))).to.equal("other")
			expect(resolveBehaviorType(event({ queryType: "unknown" }))).to.equal("other")
		})

		it("助手轮 hasFullImpl=true → ai_code", () => {
			expect(resolveBehaviorType(event({ role: "assistant", hasFullImpl: true }))).to.equal("ai_code")
			expect(resolveBehaviorType(event({ role: "assistant", hasFullImpl: false }))).to.equal("other")
			// 伪代码结构体 + hasFullImpl=false 不产生 ai_code（字段优先于事件类型推断）
			expect(resolveBehaviorType(event({ role: "assistant", eventType: "turn_message" }))).to.equal("other")
		})

		it("无任何已知字段 → other（BN-34）", () => {
			expect(resolveBehaviorType(event({ role: "user" }))).to.equal("other")
			expect(resolveBehaviorType(event({ eventType: "unknown_event" }))).to.equal("other")
		})

		it("null / undefined 事件不抛错", () => {
			expect(resolveBehaviorType(null)).to.equal("other")
			expect(resolveBehaviorType(undefined)).to.equal("other")
		})
	})

	describe("eventWeight — 契约 §3 与 BN-40", () => {
		it("缺省权重按类型查表", () => {
			expect(eventWeight(event({ behaviorType: "concept" }))).to.equal(0.25)
			expect(eventWeight(event({ behaviorType: "design" }))).to.equal(0.75)
			expect(eventWeight(event({ behaviorType: "error_help" }))).to.equal(1.0)
			expect(eventWeight(event({ behaviorType: "self_code" }))).to.equal(0)
			expect(eventWeight(event({ behaviorType: "ai_code" }))).to.equal(1.2)
			expect(eventWeight(event({ eventType: "code_edit", editor: "user" }))).to.equal(0)
			expect(eventWeight(event({ role: "assistant", hasFullImpl: true }))).to.equal(1.2)
		})

		it("other 恒为 0（即使带 behaviorWeight）", () => {
			expect(eventWeight(event({ behaviorType: "other", behaviorWeight: 1.0 }))).to.equal(0)
			expect(eventWeight(event({}))).to.equal(0)
			expect(eventWeight(null)).to.equal(0)
		})

		it("合法 behaviorWeight 原样使用", () => {
			expect(eventWeight(event({ behaviorType: "concept", behaviorWeight: 1.0 }))).to.equal(1.0)
			expect(eventWeight(event({ behaviorType: "design", behaviorWeight: 0 }))).to.equal(0)
			expect(eventWeight(event({ behaviorType: "error_help", behaviorWeight: 1.2 }))).to.equal(1.2)
		})

		it("BN-40：上界越界夹取到 1.2 并告警", () => {
			const warnings = captureWarnings(() => {
				expect(eventWeight(event({ behaviorType: "ai_code", behaviorWeight: 5 }))).to.equal(1.2)
			})
			expect(warnings).to.have.length(1)
			expect(warnings[0][0]).to.equal("[metricsSpec] behaviorWeight 越界，已夹取")
		})

		it("BN-40：下界越界夹取到 0 并告警", () => {
			const warnings = captureWarnings(() => {
				expect(eventWeight(event({ behaviorType: "design", behaviorWeight: -3 }))).to.equal(0)
			})
			expect(warnings).to.have.length(1)
			expect(warnings[0][0]).to.equal("[metricsSpec] behaviorWeight 越界，已夹取")
		})

		it("非有限 behaviorWeight 回退查表", () => {
			expect(eventWeight(event({ behaviorType: "design", behaviorWeight: Number.NaN }))).to.equal(0.75)
			expect(eventWeight(event({ behaviorType: "concept", behaviorWeight: Number.POSITIVE_INFINITY }))).to.equal(0.25)
		})
	})

	describe("behaviorMix / dependencyCount", () => {
		it("behaviorMix 统计六类计数", () => {
			const mix = behaviorMix([
				event({ behaviorType: "concept" }),
				event({ behaviorType: "concept" }),
				event({ behaviorType: "design" }),
				event({ behaviorType: "error_help" }),
				event({ behaviorType: "self_code" }),
				event({ eventType: "code_edit", editor: "ai" }),
				event({}),
			])
			expect(mix).to.deep.equal({
				concept: 2,
				design: 1,
				error_help: 1,
				self_code: 1,
				ai_code: 1,
				other: 1,
			})
		})

		it("空数组 / 非数组 → 全 0，且不修改输入", () => {
			expect(behaviorMix([])).to.deep.equal({
				concept: 0,
				design: 0,
				error_help: 0,
				self_code: 0,
				ai_code: 0,
				other: 0,
			})
			expect(behaviorMix(undefined)).to.deep.equal({
				concept: 0,
				design: 0,
				error_help: 0,
				self_code: 0,
				ai_code: 0,
				other: 0,
			})
			expect(behaviorMix(asEventList({ length: 2 }))).to.deep.equal({
				concept: 0,
				design: 0,
				error_help: 0,
				self_code: 0,
				ai_code: 0,
				other: 0,
			})
			const list = [event({ behaviorType: "concept" })]
			behaviorMix(list)
			expect(list).to.have.length(1)
			expect(list[0].behaviorType).to.equal("concept")
		})

		it("dependencyCount 排除 other（计划断言 9/12 的分母语义）", () => {
			expect(dependencyCount([])).to.equal(0)
			expect(
				dependencyCount([
					event({ behaviorType: "self_code" }),
					event({ behaviorType: "ai_code" }),
					event({}),
					event({}),
					event({}),
				]),
			).to.equal(2)
		})
	})

	describe("depIndex / weightedMean — 契约 §2", () => {
		it("全 self_code → depIndex=0、weightedMean=0（断言 11）", () => {
			const events = [event({ behaviorType: "self_code" }), event({ behaviorType: "self_code" })]
			expect(depIndex(events)).to.equal(0)
			expect(weightedMean(events)).to.equal(0)
		})

		it("全 ai_code → depIndex=1、weightedMean=1.2（断言 11）", () => {
			const events = [event({ behaviorType: "ai_code" }), event({ behaviorType: "ai_code" })]
			expect(depIndex(events)).to.equal(1)
			expect(weightedMean(events)).to.equal(1.2)
		})

		it("概念+自主各半 → depIndex=0.104167、weightedMean=0.125（断言 11 备注）", () => {
			const events = [event({ behaviorType: "concept" }), event({ behaviorType: "self_code" })]
			expect(depIndex(events)).to.equal(0.104167)
			expect(weightedMean(events)).to.equal(0.125)
		})

		it("design + error_help → 0.729167 / 0.875", () => {
			const events = [event({ behaviorType: "design" }), event({ behaviorType: "error_help" })]
			expect(depIndex(events)).to.equal(0.729167)
			expect(weightedMean(events)).to.equal(0.875)
		})

		it("other 混入不改变 depIndex（断言 12，同分母）", () => {
			const core = [event({ behaviorType: "ai_code" }), event({ behaviorType: "concept" })]
			const withOthers = [...core, event({}), event({}), event({ eventType: "unknown_event" })]
			const expected = depIndex(core)
			expect(expected).to.equal(0.604167)
			expect(depIndex(withOthers)).to.equal(expected)
			expect(weightedMean(withOthers)).to.equal(weightedMean(core))
		})

		it("空数组 / undefined / 非数组 → null，不抛错（断言 14）", () => {
			for (const input of [undefined, null, [], asEventList({ length: 3 }), asEventList("nope")]) {
				expect(depIndex(input)).to.equal(null)
				expect(weightedMean(input)).to.equal(null)
			}
		})

		it("BN-39：缺 ts 的事件不丢、正常计分", () => {
			const noTs: MetricsEvent = { eventType: "turn_message", role: "assistant", hasFullImpl: true }
			const events = [noTs, noTs]
			expect(behaviorMix(events).ai_code).to.equal(2)
			expect(depIndex(events)).to.equal(1)
			expect(weightedMean(events)).to.equal(1.2)
		})

		it("显式 behaviorWeight 参与 ΣW；NaN 回退查表", () => {
			expect(depIndex([event({ behaviorType: "design", behaviorWeight: 1.0 })])).to.equal(0.833333)
			expect(depIndex([event({ behaviorType: "design", behaviorWeight: Number.NaN })])).to.equal(0.625)
		})

		it("BN-40：越界权重按 1.2 计入 depIndex", () => {
			expect(depIndex([event({ behaviorType: "ai_code", behaviorWeight: 99 })])).to.equal(1)
			expect(depIndex([event({ behaviorType: "concept", behaviorWeight: -99 })])).to.equal(0)
		})
	})

	describe("selfCodingRatio — 契约 §2", () => {
		it("无 self_code / ai_code → null（断言 13）", () => {
			expect(selfCodingRatio([event({ behaviorType: "concept" }), event({ behaviorType: "design" })])).to.equal(null)
			expect(selfCodingRatio([])).to.equal(null)
			expect(selfCodingRatio(undefined)).to.equal(null)
		})

		it("按 self_code/(self_code+ai_code) 计算", () => {
			expect(
				selfCodingRatio([event({ behaviorType: "self_code" }), event({ behaviorType: "ai_code" })]),
			).to.equal(0.5)
			expect(
				selfCodingRatio([event({ behaviorType: "self_code" }), event({ behaviorType: "self_code", behaviorWeight: 1 })]),
			).to.equal(1)
			expect(selfCodingRatio([event({ behaviorType: "ai_code" })])).to.equal(0)
		})
	})

	describe("adoptionDeepening — 契约 §4 窗口", () => {
		// 显式传 `turnIndex: undefined` 表示「字段缺失」，用于验证回退数组下标的窗口路径
		const adopted = (turnIndex?: number) => event({ eventType: "adoption_infer", adoptionStatus: "adopted", turnIndex })
		const selfCode = (turnIndex?: number) => event({ behaviorType: "self_code", turnIndex })

		it("无 adopted → null", () => {
			expect(adoptionDeepening([event({ behaviorType: "self_code" })])).to.equal(null)
			expect(adoptionDeepening([])).to.equal(null)
		})

		it("采纳后窗口内出现 self_code → 1（含 turnIndex 差 5 的边界）", () => {
			expect(adoptionDeepening([adopted(1), selfCode(2)])).to.equal(1)
			expect(adoptionDeepening([adopted(1), selfCode(6)])).to.equal(1)
		})

		it("超出窗口（turnIndex 差 6）→ 0；self_code 在 adopted 之前不计", () => {
			expect(adoptionDeepening([adopted(1), selfCode(7)])).to.equal(0)
			expect(adoptionDeepening([selfCode(1), adopted(2)])).to.equal(0)
			expect(adoptionDeepening([adopted(1), event({ behaviorType: "ai_code", turnIndex: 2 })])).to.equal(0)
		})

		it("两个 adopted 只深化一个 → 0.5", () => {
			const events = [adopted(1), selfCode(2), adopted(10), event({ behaviorType: "ai_code", turnIndex: 11 })]
			expect(adoptionDeepening(events)).to.equal(0.5)
		})

		it("turnIndex 缺失时回退数组下标窗口（差 5 命中、差 6 超出）", () => {
			const others = () => [event({}), event({}), event({}), event({}), event({})]
			const hit = [adopted(), selfCode(), ...others()]
			expect(hit.length).to.equal(7)
			// adopted 位于下标 0，self_code 位于下标 1：命中
			expect(adoptionDeepening([adopted(), selfCode()])).to.equal(1)
			// 下标差恰为 5 也命中
			expect(adoptionDeepening([adopted(), event({}), event({}), event({}), event({}), selfCode()])).to.equal(1)
			// 下标差 6 超出窗口
			expect(
				adoptionDeepening([adopted(), event({}), event({}), event({}), event({}), event({}), selfCode()]),
			).to.equal(0)
		})

		it("turnIndex 双方存在时优先于数组下标", () => {
			// 数组下标只差 1，但 turnIndex 差 6 → 不在窗口
			expect(adoptionDeepening([adopted(1), selfCode(7)])).to.equal(0)
			// 数组下标差 6，但 turnIndex 差 5 → 在窗口
			const events = [adopted(1), event({ turnIndex: 2 }), event({ turnIndex: 3 }), event({ turnIndex: 4 }), event({ turnIndex: 5 }), event({ turnIndex: 6 }), selfCode(6)]
			expect(adoptionDeepening(events)).to.equal(1)
		})
	})

	describe("errorResolutionRate — 契约 §4 窗口", () => {
		const errorHelp = (turnIndex?: number) =>
			event({
				behaviorType: "error_help",
				...(turnIndex === undefined ? {} : { turnIndex }),
			})
		const runTrace = (exitCode: number | string | undefined, turnIndex?: number) =>
			event({
				eventType: "run_trace",
				...(exitCode === undefined ? {} : { exit_code: exitCode }),
				...(turnIndex === undefined ? {} : { turnIndex }),
			})

		it("无 error_help → null", () => {
			expect(errorResolutionRate([event({ behaviorType: "concept" })])).to.equal(null)
			expect(errorResolutionRate([])).to.equal(null)
		})

		it("报错后窗口内 exit_code=0（数字或字符串）→ 1", () => {
			expect(errorResolutionRate([errorHelp(1), runTrace(0, 2)])).to.equal(1)
			expect(errorResolutionRate([errorHelp(1), runTrace("0", 6)])).to.equal(1)
		})

		it("exit_code 非 0 / 缺失 / 窗口外不计", () => {
			expect(errorResolutionRate([errorHelp(1), runTrace(1, 2)])).to.equal(0)
			expect(errorResolutionRate([errorHelp(1), runTrace(undefined, 2)])).to.equal(0)
			expect(errorResolutionRate([errorHelp(1), runTrace(0, 7)])).to.equal(0)
			// run_trace 在报错之前不算解决
			expect(errorResolutionRate([runTrace(0, 1), errorHelp(2)])).to.equal(0)
		})

		it("两个 error_help 只解决一个 → 0.5", () => {
			const events = [errorHelp(1), runTrace(0, 2), errorHelp(5), runTrace(1, 6)]
			expect(errorResolutionRate(events)).to.equal(0.5)
		})
	})

	describe("guidanceEffect — 契约 §2", () => {
		it("无 demands → null；旧规则 ID complete_impl_demand 不计入", () => {
			expect(guidanceEffect([event({ behaviorType: "ai_code" })])).to.equal(null)
			expect(guidanceEffect([])).to.equal(null)
			expect(
				guidanceEffect([event({ interventionRuleId: "complete_impl_demand" }), event({ behaviorType: "ai_code" })]),
			).to.equal(null)
		})

		it("behaviorSignals 含 full_impl_demand 计入 demands", () => {
			const events = [
				event({ behaviorSignals: "full_impl_demand,demand_pending" }),
				event({ behaviorType: "ai_code" }),
			]
			expect(guidanceEffect(events)).to.equal(0)
			expect(guidanceEffect([event({ behaviorSignals: "full_impl_demand" }), event({ behaviorType: "concept" })])).to.equal(1)
		})

		it("interventionRuleId=full_impl_demand 也计入 → 1 - ai_code/demands", () => {
			const events = [
				event({ interventionRuleId: "full_impl_demand" }),
				event({ behaviorSignals: "no_signal" }),
				event({ behaviorType: "ai_code" }),
			]
			// demands=1（只有第一条 interventionRuleId 命中），ai_code=1 → 1 - 1/1 = 0
			expect(guidanceEffect(events)).to.equal(0)
			expect(
				guidanceEffect([
					event({ interventionRuleId: "full_impl_demand" }),
					event({ behaviorSignals: "full_impl_demand" }),
					event({ behaviorType: "ai_code" }),
				]),
			).to.equal(0.5)
		})
	})

	describe("computeDependenceMetrics — 契约 §5", () => {
		it("返回 8 个契约字段；空输入全 null", () => {
			const metrics = computeDependenceMetrics([])
			expect(Object.keys(metrics)).to.deep.equal([
				"depIndex",
				"weightedMean",
				"selfCodingRatio",
				"adoptionDeepening",
				"guidanceEffect",
				"errorResolutionRate",
				"behaviorMix",
				"metricsSchema",
			])
			expect(metrics.depIndex).to.equal(null)
			expect(metrics.weightedMean).to.equal(null)
			expect(metrics.selfCodingRatio).to.equal(null)
			expect(metrics.adoptionDeepening).to.equal(null)
			expect(metrics.guidanceEffect).to.equal(null)
			expect(metrics.errorResolutionRate).to.equal(null)
			expect(metrics.behaviorMix).to.deep.equal({
				concept: 0,
				design: 0,
				error_help: 0,
				self_code: 0,
				ai_code: 0,
				other: 0,
			})
			expect(metrics.metricsSchema).to.equal(METRICS_SCHEMA)
		})

		it("与单指标函数在同一事件流上结果一致", () => {
			const events = [
				event({ behaviorType: "concept", turnIndex: 0 }),
				event({ behaviorType: "design", turnIndex: 1 }),
				event({ behaviorType: "error_help", turnIndex: 2 }),
				event({ behaviorType: "ai_code", behaviorWeight: 1.2, turnIndex: 3 }),
				event({ eventType: "adoption_infer", adoptionStatus: "adopted", turnIndex: 4 }),
				event({ behaviorType: "self_code", turnIndex: 5 }),
			]
			const metrics = computeDependenceMetrics(events)
			expect(metrics.depIndex).to.equal(depIndex(events))
			expect(metrics.weightedMean).to.equal(weightedMean(events))
			expect(metrics.selfCodingRatio).to.equal(selfCodingRatio(events))
			expect(metrics.adoptionDeepening).to.equal(adoptionDeepening(events))
			expect(metrics.guidanceEffect).to.equal(guidanceEffect(events))
			expect(metrics.errorResolutionRate).to.equal(errorResolutionRate(events))
			expect(metrics.behaviorMix).to.deep.equal(behaviorMix(events))
			expect(metrics.metricsSchema).to.equal(METRICS_SCHEMA)
			expect(metrics.adoptionDeepening).to.equal(1)
		})

		it("BN-40：compute 中每个越界事件最多告警一次", () => {
			const events = [event({ behaviorType: "concept", behaviorWeight: 9 })]
			const warnings = captureWarnings(() => {
				const metrics = computeDependenceMetrics(events)
				expect(metrics.depIndex).to.equal(1)
			})
			expect(warnings).to.have.length(1)
			expect(warnings[0][0]).to.equal("[metricsSpec] behaviorWeight 越界，已夹取")
		})
	})
})
