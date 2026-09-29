import { expect } from "chai"
import {
    buildWikiServerEntry,
    decideWriteAction,
    detectDisabledTransition,
    isWikiServerConnected,
    mergeWikiServerEntry,
    removeWikiServerEntry,
} from "../WikiMcpRegistrar"

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

describe("detectDisabledTransition", () => {
	it("false → true 视为禁用事件", () => {
		expect(
			detectDisabledTransition({} as never, { wiki: { type: "stdio", command: "c", disabled: true } } as never),
		).to.equal(true)
	})

	it("本就是 true → 不重复提示", () => {
		const prev = { wiki: { type: "stdio", command: "c", disabled: true } } as never
		expect(detectDisabledTransition(prev, prev)).to.equal(false)
	})

	it("条目不存在 → 不提示", () => {
		expect(detectDisabledTransition({} as never, {} as never)).to.equal(false)
	})

	it("★ 真实跃迁：启用（无 disabled 字段）→ 禁用 → 提示", () => {
		const prev = { wiki: { type: "stdio", command: "c" } } as never
		const next = { wiki: { type: "stdio", command: "c", disabled: true } } as never
		expect(detectDisabledTransition(prev, next)).to.equal(true)
	})

	it("★ 反方向：禁用 → 启用 → 不提示", () => {
		const prev = { wiki: { type: "stdio", command: "c", disabled: true } } as never
		const next = { wiki: { type: "stdio", command: "c" } } as never
		expect(detectDisabledTransition(prev, next)).to.equal(false)
	})
})

describe("removeWikiServerEntry（检索开关关闭时用删除而非 disabled）", () => {
	it("条目存在 → 删除并标记 changed", () => {
		const r = removeWikiServerEntry({ wiki: { type: "stdio", command: "c", args: [] } })
		expect(r.changed).to.equal(true)
		expect(r.next.wiki).to.equal(undefined)
	})

	it("条目不存在 → 不写入（幂等）", () => {
		const r = removeWikiServerEntry({ other: { type: "stdio", command: "o", args: [] } })
		expect(r.changed).to.equal(false)
	})

	it("★ 不破坏其它 server 条目", () => {
		const r = removeWikiServerEntry({
			wiki: { type: "stdio", command: "c", args: [] },
			other: { type: "stdio", command: "o", args: [] },
		})
		expect(r.next.other).to.exist
		expect(r.next.wiki).to.equal(undefined)
	})

	it("★ 不修改入参（纯函数）", () => {
		const input = { wiki: { type: "stdio", command: "c", args: [] } } as never
		removeWikiServerEntry(input)
		expect(input).to.have.property("wiki")
	})
})

describe("isWikiServerConnected", () => {
	const hub = (servers: unknown[]): never => ({ getServers: () => servers }) as never

	it("connected 且未禁用 → true", () => {
		expect(isWikiServerConnected(hub([{ name: "wiki", status: "connected" }]))).to.equal(true)
	})

	it("★ 仍是 connecting → false（不得把“尚未连上”当成可用）", () => {
		expect(isWikiServerConnected(hub([{ name: "wiki", status: "connecting" }]))).to.equal(false)
	})

	it("★ 存在但 disabled → false", () => {
		expect(isWikiServerConnected(hub([{ name: "wiki", status: "connected", disabled: true }]))).to.equal(false)
	})

	it("条目不存在 → false（停掉检索后不得声称可用）", () => {
		expect(isWikiServerConnected(hub([{ name: "other", status: "connected" }]))).to.equal(false)
	})

	it("★ hub 为 undefined / 无 getServers → false（设计稿的 McpHub.getInstance?.() 陷阱）", () => {
		expect(isWikiServerConnected(undefined)).to.equal(false)
		expect(isWikiServerConnected(null)).to.equal(false)
		expect(isWikiServerConnected({} as never)).to.equal(false)
	})

	it("getServers 抛异常 → false（不得向上冒泡）", () => {
		const bad = {
			getServers: () => {
				throw new Error("boom")
			},
		} as never
		expect(isWikiServerConnected(bad)).to.equal(false)
	})
})
