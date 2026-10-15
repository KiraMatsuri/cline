import { expect } from "chai"
import { DEFAULT_OPTIONS as MONITOR_DEFAULTS } from "../BehaviorMonitor"
import { formatInterventionForInjection, generateBlockingInterventionMessage } from "../InterventionMessageGenerator"
import { DEFAULT_OPTIONS as MANAGER_DEFAULTS } from "../TeachingInterventionManager"
import type { BehaviorAlert } from "../types"

describe("干预参数基线（方案 D 止血）", () => {
	it("★ 阻断冷却 60s（原 180s）", () => {
		expect(MANAGER_DEFAULTS.blockingCooldownMs).to.equal(60_000)
	})

	it("★ 同规则升级阈值 3（原 4 → 6 → 3），且两处副本必须一致", () => {
		expect(MONITOR_DEFAULTS.escalationBlockingThreshold).to.equal(3)
		// TeachingInterventionManager 的这份从未被读取（升级判定走 monitor.shouldEscalateToBlocking），
		// 两份不一致会造成"改了值却没生效"且无任何报错 —— 用测试锁住。
		expect(MANAGER_DEFAULTS.escalationBlockingThreshold).to.equal(MONITOR_DEFAULTS.escalationBlockingThreshold)
	})

	it("规则级冷却 120s（原 15s）", () => {
		expect(MONITOR_DEFAULTS.cooldownMs).to.equal(120_000)
	})

	it("★【P6/T6】独立阻断通道阈值 3（与告知学生的文案「连续 3 次直接编码会触发阻断」逐字一致）", () => {
		expect(MONITOR_DEFAULTS.aiCodingBlockingThreshold).to.equal(3)
	})

	it("AI 依赖阈值 0.85（原 0.7）、最少 6 条回合（原 4）", () => {
		expect(MONITOR_DEFAULTS.aiDependencyThreshold).to.equal(0.85)
		expect(MONITOR_DEFAULTS.minTurnsForDependency).to.equal(6)
	})

	it("无编辑连续阈值 3（【P5-A】单位改为「学生请求」后由 8 降到 3）", () => {
		// 原值 8 是「回合」口径下的 8 轮；单位改为学生请求后，8 次提问才提醒太迟，
		// 改为 3（连续 3 次提问没动手）→ 对齐 M4'/M6' 的阻断口径。
		expect(MONITOR_DEFAULTS.noEditTurnStreakThreshold).to.equal(3)
	})
})

describe("★ 阻断倒计时必须与实际冷却时长一致", () => {
	const alert: BehaviorAlert = {
		ruleId: "no_edit_streak",
		message: "test",
		triggeredAt: new Date().toISOString(),
		metricValue: 8,
		threshold: 8,
		escalationCount: 6,
	}

	it("60s 冷却 → countdownSeconds = 60（不得沿用模板里写死的 180）", () => {
		expect(generateBlockingInterventionMessage(alert, 60_000).countdownSeconds).to.equal(60)
	})

	it("注入文本显示 1 分钟，且不含 3 分钟", () => {
		const text = formatInterventionForInjection(generateBlockingInterventionMessage(alert, 60_000))
		expect(text).to.include("1 分钟")
		expect(text).to.not.include("3 分钟")
	})

	it("180s 冷却仍显示 3 分钟（不得把映射写反）", () => {
		const text = formatInterventionForInjection(generateBlockingInterventionMessage(alert, 180_000))
		expect(text).to.include("3 分钟")
	})
})
