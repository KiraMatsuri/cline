import { expect } from "chai"
import { nextWeekSwitch } from "../weekSwitchNotice"

describe("F7 · 周数切换通知（纯函数）", () => {
	it("★ 首次（无上次记录）→ 不通知，只记录", () => {
		const r = nextWeekSwitch(undefined, 5)
		expect(r.notice).to.equal(null)
		expect(r.lastWeek).to.equal(5)
	})

	it("★ 同周 → 不重复通知", () => {
		expect(nextWeekSwitch(5, 5).notice).to.equal(null)
	})

	it("★ 周数变更 → 通知文本包含新旧周次", () => {
		const r = nextWeekSwitch(1, 18)
		expect(r.notice).to.be.a("string")
		expect(r.notice).to.include("第 1 周")
		expect(r.notice).to.include("第 18 周")
		expect(r.lastWeek).to.equal(18)
	})

	it("★ 连续两次变更各通知一次（状态被正确推进）", () => {
		const a = nextWeekSwitch(1, 5)
		expect(a.notice).to.be.a("string")
		const b = nextWeekSwitch(a.lastWeek, 9)
		expect(b.notice).to.include("第 5 周")
		expect(b.notice).to.include("第 9 周")
	})
})
