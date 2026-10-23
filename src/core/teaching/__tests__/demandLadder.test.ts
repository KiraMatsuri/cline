import { expect } from "chai"
import fs from "fs"
import os from "os"
import * as path from "path"

import { experimentPseudoCodePromptSection, freeModeReleasePromptSection } from "../TeachingContext"
import {
	DEMAND_COUNT_CAP,
	DEMAND_COUNTER_FILE,
	DEMAND_LADDER,
	attachDemandCount,
	bumpDemandCounter,
	loadDemandCounter,
	resolveSessionContext,
	resetDemandCounter,
	saveDemandCounter,
	shouldOfferPseudo,
	shouldReleaseFullCode,
	shouldRunIntervention,
	switchSessionMode,
	type SessionContext,
	type SessionMode,
} from "../TeachingSessionMode"

/**
 * P1-6 · 索要完整实现的行为阶梯
 *
 * 为什么单独测：阶梯直接决定「学生要几次才给答案」，是产品语义最敏感的一段；
 * 计多一次会让实验任务提前放水，计少一次会让学生反复索取却拿不到代码。
 */
describe("demandLadder — 索要完整实现的阶梯（P1-6）", () => {
	const makeCtx = (mode: SessionMode): SessionContext => resolveSessionContext({ cwd: "/tmp/teaching-workspace", mode })
	const demand = "直接给我完整代码"
	const chat = "为什么这段循环要写成 i < n？"

	let tempDirs: string[] = []

	const makeTaskDir = (): string => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demand-ladder-"))
		tempDirs.push(dir)
		return dir
	}

	afterEach(() => {
		for (const dir of tempDirs) {
			fs.rmSync(dir, { recursive: true, force: true })
		}
		tempDirs = []
	})

	it("★ 自由模式：第 1、2 次明确索要仍不放行，第 3 次才放行完整实现", () => {
		const ctx = makeCtx("free")

		expect(bumpDemandCounter(ctx, demand)).to.deep.equal({ action: "counted", count: 1 })
		expect(shouldReleaseFullCode(ctx)).to.equal(false)
		expect(bumpDemandCounter(ctx, demand)).to.deep.equal({ action: "counted", count: 2 })
		expect(shouldReleaseFullCode(ctx)).to.equal(false)
		expect(bumpDemandCounter(ctx, demand)).to.deep.equal({ action: "counted", count: 3 })
		expect(shouldReleaseFullCode(ctx)).to.equal(true)
		// 实验模式的伪代码阶梯在自由模式不生效
		expect(shouldOfferPseudo(ctx)).to.equal(false)
	})

	it("★ 实验模式：前 3 次明确索要都不给伪代码，第 4 次才给；完整实现恒不放行", () => {
		const ctx = makeCtx("experiment")

		bumpDemandCounter(ctx, demand)
		bumpDemandCounter(ctx, demand)
		bumpDemandCounter(ctx, demand)
		expect(shouldOfferPseudo(ctx)).to.equal(false)
		expect(shouldReleaseFullCode(ctx)).to.equal(false)

		bumpDemandCounter(ctx, demand)
		expect(shouldOfferPseudo(ctx)).to.equal(true)
		expect(shouldReleaseFullCode(ctx)).to.equal(false)
	})

	it("★ 非索要消息不计数，也不会把已有计数清零", () => {
		const ctx = makeCtx("free")
		bumpDemandCounter(ctx, demand)

		expect(bumpDemandCounter(ctx, chat)).to.deep.equal({ action: "none", count: 1 })
		expect(bumpDemandCounter(ctx, "")).to.deep.equal({ action: "none", count: 1 })
		expect(ctx.demandCount).to.equal(1)
	})

	it("★ 一次消息里多次索要只计 1 次（BN-30）", () => {
		const ctx = makeCtx("free")
		const twice = "给我完整代码！快点，直接给我完整实现！"

		expect(bumpDemandCounter(ctx, twice)).to.deep.equal({ action: "counted", count: 1 })
		expect(ctx.demandCount).to.equal(1)
	})

	it("★ 索要与概念问题混在同一句也按 1 次计（BN-29）", () => {
		const ctx = makeCtx("experiment")
		const mixed = "先讲一下递归的概念，然后直接给我完整代码吧"

		expect(bumpDemandCounter(ctx, mixed)).to.deep.equal({ action: "counted", count: 1 })
		expect(ctx.demandCount).to.equal(1)
	})

	it("★ 学生自己贴出完整实现（self_code 信号）→ 计数清零，阶梯重新开始", () => {
		const ctx = makeCtx("experiment")
		bumpDemandCounter(ctx, demand)
		bumpDemandCounter(ctx, demand)
		bumpDemandCounter(ctx, demand)
		expect(ctx.demandCount).to.equal(3)

		const studentCode = [
			"我按思路写出来了，帮我看看这个结果对不对：",
			"```python",
			"def solve(n):",
			"    total = 0",
			"    for i in range(n):",
			"        total += i",
			"    return total",
			"print(solve(10))",
			"```",
		].join("\n")

		expect(bumpDemandCounter(ctx, studentCode)).to.deep.equal({ action: "reset", count: 0 })
		expect(shouldOfferPseudo(ctx)).to.equal(false)
	})

	it("★ 第 10 次之后计数不再增长（不会溢出成「永远放行」的假象）", () => {
		const ctx = makeCtx("experiment")
		for (let i = 0; i < 15; i += 1) {
			bumpDemandCounter(ctx, demand)
		}
		expect(ctx.demandCount).to.equal(DEMAND_COUNT_CAP)
		expect(DEMAND_COUNT_CAP).to.equal(10)
		expect(shouldOfferPseudo(ctx)).to.equal(true)
	})

	it("★ 落盘后恢复会话不重置：写 2 次 → 新进程读回 2 → 再要 2 次到达伪代码阶梯", () => {
		const taskDir = makeTaskDir()
		const firstSession = attachDemandCount(makeCtx("experiment"), loadDemandCounter(taskDir, "experiment"))
		bumpDemandCounter(firstSession, demand)
		bumpDemandCounter(firstSession, demand)
		saveDemandCounter(taskDir, "experiment", firstSession.demandCount ?? 0)

		// 模拟重新打开任务：Task 从任务目录读回计数
		const restored = loadDemandCounter(taskDir, "experiment")
		expect(restored).to.equal(2)
		const resumed = attachDemandCount(makeCtx("experiment"), restored)
		expect(shouldOfferPseudo(resumed)).to.equal(false)
		bumpDemandCounter(resumed, demand)
		bumpDemandCounter(resumed, demand)
		expect(shouldOfferPseudo(resumed)).to.equal(true)
		expect(fs.existsSync(path.join(taskDir, DEMAND_COUNTER_FILE))).to.equal(true)
	})

	it("★ 切模式清零：自由模式攒的 3 次不能带到实验模式", () => {
		const taskDir = makeTaskDir()
		saveDemandCounter(taskDir, "free", 3)
		expect(loadDemandCounter(taskDir, "free")).to.equal(3)
		expect(loadDemandCounter(taskDir, "experiment")).to.equal(0)

		const freeCtx = makeCtx("free")
		freeCtx.demandCount = 3
		const switched = switchSessionMode(freeCtx, "experiment")
		expect(switched.mode).to.equal("experiment")
		expect(switched.ladderLimit).to.equal(DEMAND_LADDER.experiment)
		expect(switched.demandCount).to.equal(0)
		expect(shouldReleaseFullCode(switched)).to.equal(false)
		expect(shouldOfferPseudo(switched)).to.equal(false)
	})

	it("★ 新任务（新任务目录）天然从 0 开始，旧任务计数互不影响", () => {
		const dirA = makeTaskDir()
		const dirB = makeTaskDir()
		saveDemandCounter(dirA, "free", 3)
		expect(loadDemandCounter(dirB, "free")).to.equal(0)
		expect(loadDemandCounter(dirA, "free")).to.equal(3)
	})

	it("★ 计数文件缺失 / JSON 损坏都返回 0，不抛错", () => {
		const taskDir = makeTaskDir()
		expect(loadDemandCounter(taskDir, "experiment")).to.equal(0)

		fs.writeFileSync(path.join(taskDir, DEMAND_COUNTER_FILE), "{ 这不是 JSON", "utf8")
		expect(loadDemandCounter(taskDir, "experiment")).to.equal(0)

		fs.writeFileSync(path.join(taskDir, DEMAND_COUNTER_FILE), JSON.stringify({ count: 999, mode: "experiment" }), "utf8")
		expect(loadDemandCounter(taskDir, "experiment")).to.equal(DEMAND_COUNT_CAP)
	})

	it("★ free 模式不跑干预，experiment 模式才跑", () => {
		expect(shouldRunIntervention(makeCtx("free"))).to.equal(false)
		expect(shouldRunIntervention(makeCtx("experiment"))).to.equal(true)
	})

	it("★ resetDemandCounter 显式清零", () => {
		const ctx = makeCtx("free")
		bumpDemandCounter(ctx, demand)
		bumpDemandCounter(ctx, demand)
		expect(ctx.demandCount).to.equal(2)
		resetDemandCounter(ctx)
		expect(ctx.demandCount).to.equal(0)
		expect(shouldReleaseFullCode(ctx)).to.equal(false)
	})

	it("★ 放行文本：自由模式第 3 次可给完整实现（逐段中文注释），实验模式第 4 次只给伪代码", () => {
		const freeCtx = makeCtx("free")
		bumpDemandCounter(freeCtx, demand)
		bumpDemandCounter(freeCtx, demand)
		bumpDemandCounter(freeCtx, demand)
		expect(shouldReleaseFullCode(freeCtx)).to.equal(true)
		expect(freeModeReleasePromptSection()).to.include("逐段中文注释")

		const experimentCtx = makeCtx("experiment")
		for (let i = 0; i < 4; i += 1) {
			bumpDemandCounter(experimentCtx, demand)
		}
		expect(shouldOfferPseudo(experimentCtx)).to.equal(true)
		expect(experimentPseudoCodePromptSection()).to.include("伪代码")
		// 只禁止「放行完整实现」的许可措辞；文本里的「不得给出完整实现」是禁止语，属于预期
		expect(experimentPseudoCodePromptSection()).to.not.include("可以给完整实现")
		expect(experimentPseudoCodePromptSection()).to.not.include("可提供完整实现")
	})
})
