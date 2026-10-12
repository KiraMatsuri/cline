import { expect } from "chai"
import { appendEphemeralIntervention } from "../ephemeralIntervention"

describe("F6 · 干预作为本轮一次性 system prompt 后缀", () => {
	it("★ 有干预时追加到 system prompt 末尾，且 applied=true", () => {
		const r = appendEphemeralIntervention("BASE", '<teaching_intervention rule="no_edit_streak">x</teaching_intervention>')
		expect(r.applied).to.equal(true)
		expect(r.systemPrompt.startsWith("BASE")).to.equal(true)
		expect(r.systemPrompt).to.include("teaching_intervention")
		expect(r.systemPrompt.length).to.be.greaterThan("BASE".length)
	})

	it("★ 无干预时原样返回、applied=false（不得凭空产出文本）", () => {
		for (const v of [undefined, null, "", "   "]) {
			const r = appendEphemeralIntervention("BASE", v as never)
			expect(r.applied).to.equal(false)
			expect(r.systemPrompt).to.equal("BASE")
		}
	})

	it("★ 幂等/纯度：不得修改入参，多次调用结果一致", () => {
		const base = "BASE"
		const a = appendEphemeralIntervention(base, "P")
		const b = appendEphemeralIntervention(base, "P")
		expect(base).to.equal("BASE")
		expect(a.systemPrompt).to.equal(b.systemPrompt)
	})
})
