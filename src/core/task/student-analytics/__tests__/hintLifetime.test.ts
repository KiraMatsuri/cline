/**
 * 【P8/T6】提示生命周期判定表。
 *
 * 这组用例锁的是「学生还没换话题前，提示不能因为工具轮多而被丢掉」——
 * 2026-10-18 那轮 4 个工具轮就把提示丢了，学生既没看到、日志也没记。
 */
import { expect } from "chai"
import { decideHintLifetime } from "../interventionHintLifetime"

const base = {
	hasPending: true,
	delivered: false,
	decisionRequest: 2,
	currentRequest: 2,
	redeliveryLeft: 2,
}

describe("【P8/T6】decideHintLifetime", () => {
	it("★ 同一学生请求内：无论多少轮都保留，且不消耗跨请求额度", () => {
		const d = decideHintLifetime({ ...base, currentRequest: 2, redeliveryLeft: 0 })
		expect(d.carryOver).to.equal(true)
		expect(d.consumeRedelivery).to.equal(false)
	})

	it("★ 跨请求但仍有额度：保留并消耗一次", () => {
		const d = decideHintLifetime({ ...base, currentRequest: 3, redeliveryLeft: 1 })
		expect(d.carryOver).to.equal(true)
		expect(d.consumeRedelivery).to.equal(true)
	})

	it("★ 跨请求且额度用尽：丢弃（不污染新话题）", () => {
		const d = decideHintLifetime({ ...base, currentRequest: 3, redeliveryLeft: 0 })
		expect(d.carryOver).to.equal(false)
	})

	it("★ 已交付过：不再顺延", () => {
		const d = decideHintLifetime({ ...base, delivered: true })
		expect(d.carryOver).to.equal(false)
	})

	it("★ 没有待投递：不保留", () => {
		const d = decideHintLifetime({ ...base, hasPending: false })
		expect(d.carryOver).to.equal(false)
	})

	it("★ 请求序号未知（旧路径）：退回旧的「按次数顺延」口径", () => {
		expect(decideHintLifetime({ ...base, decisionRequest: undefined, redeliveryLeft: 2 }).carryOver).to.equal(true)
		expect(decideHintLifetime({ ...base, decisionRequest: undefined, redeliveryLeft: 0 }).carryOver).to.equal(false)
	})
})
