import { expect } from "chai"
import { parseMcpArgs } from "../args"

describe("parseMcpArgs（v3：去周数）", () => {
	it("解析 --server", () => {
		const r = parseMcpArgs(["node", "srv.js", "--server", "http://localhost:4001"])
		expect(r.serverUrl).to.equal("http://localhost:4001")
	})

	it("缺少 --server 时回退为空串", () => {
		const r = parseMcpArgs(["node", "srv.js"])
		expect(r.serverUrl).to.equal("")
	})

	it("★ 旧参数 --week / --week-file 被静默忽略，且不会把其值当成 serverUrl", () => {
		const r = parseMcpArgs(["node", "srv.js", "--week", "7", "--week-file", "/tmp/w.json", "--server", "http://a:4001"])
		expect(r.serverUrl).to.equal("http://a:4001")
		// 返回值里不得再有 week 字段
		expect(Object.keys(r)).to.deep.equal(["serverUrl"])
	})

	it("serverUrl 去掉结尾斜杠", () => {
		expect(parseMcpArgs(["--server", "http://a:4001/"]).serverUrl).to.equal("http://a:4001")
	})

	it("★ 只有 --week 时 serverUrl 仍为空（旧配置不崩）", () => {
		expect(parseMcpArgs(["--week", "3"]).serverUrl).to.equal("")
	})
})
