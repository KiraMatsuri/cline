import { expect } from "chai"
import { buildWikiServerEntry, decideWriteAction, mergeWikiServerEntry } from "../WikiMcpRegistrar"

const base = {
	execPath: "C:/vscode/Code.exe",
	scriptPath: "C:/ext/dist/mcp-wiki-server.js",
	week: 5,
	serverUrl: "http://a:4001",
}

describe("buildWikiServerEntry", () => {
	it("生成 stdio 条目并把 week/server 放进 args", () => {
		const e = buildWikiServerEntry(base)
		expect(e.type).to.equal("stdio")
		expect(e.command).to.equal(base.execPath)
		expect(e.args).to.deep.equal([base.scriptPath, "--week", "5", "--server", "http://a:4001"])
		expect(e.env?.ELECTRON_RUN_AS_NODE).to.equal("1")
	})

	it("预置 autoApprove 白名单（三个只读工具）", () => {
		const e = buildWikiServerEntry(base)
		expect(e.autoApprove).to.deep.equal(["search_wiki", "read_wiki_chunk", "list_wiki_weeks"])
	})

	it("week 越界被 clamp", () => {
		expect(buildWikiServerEntry({ ...base, week: 99 }).args).to.contain("18")
		expect(buildWikiServerEntry({ ...base, week: 0 }).args).to.contain("1")
	})
})

describe("mergeWikiServerEntry", () => {
	it("条目缺失 → 写入并标记 changed", () => {
		const r = mergeWikiServerEntry({}, buildWikiServerEntry(base))
		expect(r.changed).to.equal(true)
		expect(r.next.wiki).to.exist
	})

	it("内容一致 → 不写入（幂等）", () => {
		const first = mergeWikiServerEntry({}, buildWikiServerEntry(base))
		const second = mergeWikiServerEntry(first.next, buildWikiServerEntry(base))
		expect(second.changed).to.equal(false)
	})

	it("week 变化 → 重写 args", () => {
		const first = mergeWikiServerEntry({}, buildWikiServerEntry(base))
		const r = mergeWikiServerEntry(first.next, buildWikiServerEntry({ ...base, week: 9 }))
		expect(r.changed).to.equal(true)
		expect(r.next.wiki.args).to.contain("9")
	})

	it("★ 尊重 disabled=true（不覆盖学生的禁用选择）", () => {
		const first = mergeWikiServerEntry({}, buildWikiServerEntry(base))
		first.next.wiki.disabled = true
		const r = mergeWikiServerEntry(first.next, buildWikiServerEntry(base))
		expect(r.changed).to.equal(false)
		expect(r.next.wiki.disabled).to.equal(true)
	})

	it("不破坏其它 server 条目", () => {
		const existing = { other: { type: "stdio", command: "node" } }
		const r = mergeWikiServerEntry(existing as never, buildWikiServerEntry(base))
		expect(r.next.other).to.exist
		expect(r.next.wiki).to.exist
	})

	it("command/args 被篡改 → 覆盖回正确值", () => {
		const existing = { wiki: { type: "stdio", command: "bad", args: ["nope"] } }
		const r = mergeWikiServerEntry(existing as never, buildWikiServerEntry(base))
		expect(r.changed).to.equal(true)
		expect(r.next.wiki.command).to.equal(base.execPath)
	})
})

describe("decideWriteAction", () => {
	it("文件不存在 + 有变化 → 写入", () => {
		expect(decideWriteAction("missing", true)).to.equal("write")
	})

	it("文件正常 + 无变化 → 跳过", () => {
		expect(decideWriteAction("ok", false)).to.equal("skip")
	})

	it("文件正常 + 有变化 → 写入", () => {
		expect(decideWriteAction("ok", true)).to.equal("write")
	})

	it("★ 文件存在但解析失败 → 无论如何都 abort（不得清空其它 MCP server）", () => {
		expect(decideWriteAction("broken", true)).to.equal("abort")
		expect(decideWriteAction("broken", false)).to.equal("abort")
	})
})
