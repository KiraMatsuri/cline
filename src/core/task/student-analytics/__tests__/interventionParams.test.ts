/**
 * 干预参数基线（P2-2 删除阻断后的现行契约）。
 *
 * 只保留仍然生效的参数：规则级冷却 120s、AI 依赖阈值 0.85 / 最少 6 条回合、无编辑连续阈值 3、
 * 全局冷却 5s / 单任务最多 10 条 / 默认风格 hint。
 * 阻断相关参数（blockingCooldownMs / escalationBlockingThreshold / aiCodingBlockingThreshold）已从
 * BehaviorMonitorOptions / InterventionManagerOptions 中删除；此处只断言“不復存在”，
 * 由 noBlocking.test.ts 做更完整的「源码无 blocking 符号」守卫。
 */
import { expect } from "chai"
import { DEFAULT_OPTIONS as MONITOR_DEFAULTS } from "../BehaviorMonitor"
import { DEFAULT_OPTIONS as MANAGER_DEFAULTS } from "../TeachingInterventionManager"

describe("干预参数基线（P2-2 删除阻断后的现行契约）", () => {
	it("规则级冷却 120s（原 15s）", () => {
		expect(MONITOR_DEFAULTS.cooldownMs).to.equal(120_000)
	})

	it("AI 依赖阈值 0.85（原 0.7）、最少 6 条回合（原 4）", () => {
		expect(MONITOR_DEFAULTS.aiDependencyThreshold).to.equal(0.85)
		expect(MONITOR_DEFAULTS.minTurnsForDependency).to.equal(6)
	})

	it("无编辑连续阈值 3（【P5-A】单位改为「学生请求」后由 8 降到 3）", () => {
		// 原值 8 是「回合」口径下的 8 轮；单位改为学生请求后，8 次提问才提醒太迟，
		// 改为 3（连续 3 次提问没动手）→ 对齐 M4'/M6' 的软提示口径。
		expect(MONITOR_DEFAULTS.noEditTurnStreakThreshold).to.equal(3)
	})

	it("管理器默认值：全局冷却 5s、单任务最多 10 条、默认风格 hint", () => {
		expect(MANAGER_DEFAULTS.globalCooldownMs).to.equal(5_000)
		expect(MANAGER_DEFAULTS.maxInterventionsPerTask).to.equal(10)
		expect(MANAGER_DEFAULTS.preferredStyle).to.equal("hint")
	})

	it("★ 已删除的阻断参数不得重新出现在默认配置中", () => {
		const deleted = ["blockingCooldownMs", "escalationBlockingThreshold", "aiCodingBlockingThreshold"]
		for (const key of deleted) {
			expect(MONITOR_DEFAULTS as unknown as Record<string, unknown>, `BehaviorMonitor.DEFAULT_OPTIONS.${key}`).to.not.have.property(key)
			expect(MANAGER_DEFAULTS as unknown as Record<string, unknown>, `TeachingInterventionManager.DEFAULT_OPTIONS.${key}`).to.not.have.property(key)
		}
	})
})
