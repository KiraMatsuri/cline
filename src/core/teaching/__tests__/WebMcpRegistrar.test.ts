import { expect } from "chai"
import {
	buildWebSearchServerEntry,
	mergeWebSearchServerEntry,
	removeWebSearchServerEntry,
	WEB_SEARCH_SERVER_NAME,
	WEB_SEARCH_TOOL_NAMES,
} from "../WebMcpRegistrar"
import type { McpServersMap } from "../WikiMcpRegistrar"

const base = {
	execPath: "C:/editor/Code.exe",
	scriptPath: "C:/ext/dist/mcp-web-search-server.js",
	serverUrl: "http://a:4001",
}

describe("F8 · buildWebSearchServerEntry", () => {
	it("★ 条目缺失 → 写入；args 含 --server，未提供 endpoint 时不追加 --endpoint", () => {
		const e = buildWebSearchServerEntry(base)
		expect(e.type).to.equal("stdio")
		expect(e.command).to.equal(base.execPath)
		expect(e.args).to.deep.equal([base.scriptPath, "--server", base.serverUrl])
		expect(e.args).to.not.include("--endpoint")
		expect(e.env?.ELECTRON_RUN_AS_NODE).to.equal("1")
		expect(e.autoApprove).to.deep.equal(["web_search"])
		expect(e.timeout).to.equal(30)
	})

	it("★ 提供 endpoint → 追加 --endpoint", () => {
		const e = buildWebSearchServerEntry({ ...base, endpoint: "/api/v1/web-search" })
		expect(e.args).to.deep.equal([base.scriptPath, "--server", base.serverUrl, "--endpoint", "/api/v1/web-search"])
	})

	it("服务名与工具白名单固定（provider 无关，只暴露 web_search）", () => {
		expect(WEB_SEARCH_SERVER_NAME).to.equal("web-search")
		expect(WEB_SEARCH_TOOL_NAMES).to.deep.equal(["web_search"])
	})
})

describe("F8 · mergeWebSearchServerEntry", () => {
	it("★ 条目缺失 → 写入（changed=true）", () => {
		const r = mergeWebSearchServerEntry({}, buildWebSearchServerEntry(base))
		expect(r.changed).to.equal(true)
		expect(r.next[WEB_SEARCH_SERVER_NAME]).to.exist
	})

	it("内容一致 → 不写入（幂等）", () => {
		const first = mergeWebSearchServerEntry({}, buildWebSearchServerEntry(base))
		const second = mergeWebSearchServerEntry(first.next, buildWebSearchServerEntry(base))
		expect(second.changed).to.equal(false)
	})

	it("★ disabled === true → 尊重，不改（changed=false）", () => {
		const first = mergeWebSearchServerEntry({}, buildWebSearchServerEntry(base))
		first.next[WEB_SEARCH_SERVER_NAME].disabled = true
		const r = mergeWebSearchServerEntry(first.next, buildWebSearchServerEntry(base))
		expect(r.changed).to.equal(false)
		expect(r.next[WEB_SEARCH_SERVER_NAME].disabled).to.equal(true)
	})

	it("★ command/args 被篡改 → 覆盖为正确值", () => {
		const existing: McpServersMap = {
			[WEB_SEARCH_SERVER_NAME]: { type: "stdio", command: "bad", args: ["nope"] },
		}
		const r = mergeWebSearchServerEntry(existing, buildWebSearchServerEntry(base))
		expect(r.changed).to.equal(true)
		expect(r.next[WEB_SEARCH_SERVER_NAME].command).to.equal(base.execPath)
		expect(r.next[WEB_SEARCH_SERVER_NAME].args).to.deep.equal(buildWebSearchServerEntry(base).args)
	})

	it("不破坏其它 server 条目", () => {
		const existing: McpServersMap = { other: { type: "stdio", command: "node", args: [] } }
		const r = mergeWebSearchServerEntry(existing, buildWebSearchServerEntry(base))
		expect(r.next.other).to.exist
		expect(r.next[WEB_SEARCH_SERVER_NAME]).to.exist
	})
})

describe("F8 · removeWebSearchServerEntry（开关关闭时用删除而非 disabled）", () => {
	it("★ 存在则删、不存在则 changed=false", () => {
		const present: McpServersMap = { [WEB_SEARCH_SERVER_NAME]: { type: "stdio", command: "c", args: [] } }
		const r1 = removeWebSearchServerEntry(present)
		expect(r1.changed).to.equal(true)
		expect(r1.next[WEB_SEARCH_SERVER_NAME]).to.equal(undefined)

		const r2 = removeWebSearchServerEntry({ other: { type: "stdio", command: "o", args: [] } })
		expect(r2.changed).to.equal(false)
	})

	it("★ 不破坏其它 server 条目", () => {
		const r = removeWebSearchServerEntry({
			[WEB_SEARCH_SERVER_NAME]: { type: "stdio", command: "c", args: [] },
			other: { type: "stdio", command: "o", args: [] },
		})
		expect(r.next.other).to.exist
		expect(r.next[WEB_SEARCH_SERVER_NAME]).to.equal(undefined)
	})

	it("★ 不修改入参（纯函数）", () => {
		const input: McpServersMap = { [WEB_SEARCH_SERVER_NAME]: { type: "stdio", command: "c", args: [] } }
		removeWebSearchServerEntry(input)
		expect(input).to.have.property(WEB_SEARCH_SERVER_NAME)
	})
})
