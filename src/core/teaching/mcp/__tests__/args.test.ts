import { expect } from "chai"
import { clampWeek, parseMcpArgs } from "../args"

describe("parseMcpArgs", () => {
	it("解析 --week 与 --server", () => {
		const r = parseMcpArgs(["node", "srv.js", "--week", "7", "--server", "http://localhost:4001"])
		expect(r.week).to.equal(7)
		expect(r.serverUrl).to.equal("http://localhost:4001")
	})

	it("缺少参数时回退为保守值", () => {
		const r = parseMcpArgs(["node", "srv.js"])
		expect(r.week).to.equal(1)
		expect(r.serverUrl).to.equal("")
	})

	it("week 越界被 clamp", () => {
		expect(parseMcpArgs(["--week", "99", "--server", "x"]).week).to.equal(18)
		expect(parseMcpArgs(["--week", "0", "--server", "x"]).week).to.equal(1)
		expect(parseMcpArgs(["--week", "abc", "--server", "x"]).week).to.equal(1)
	})

	it("serverUrl 去掉结尾斜杠", () => {
		expect(parseMcpArgs(["--server", "http://a:4001/"]).serverUrl).to.equal("http://a:4001")
	})
})

describe("clampWeek", () => {
	it("收紧到 [1,18]", () => {
		expect(clampWeek(5)).to.equal(5)
		expect(clampWeek(0)).to.equal(1)
		expect(clampWeek(19)).to.equal(18)
		expect(clampWeek("x")).to.equal(1)
	})
})
