import { expect } from "chai"
import { afterEach, beforeEach } from "mocha"
import * as sinon from "sinon"
import * as vscode from "vscode"
import { LLMWikiService } from "../LLMWikiService"

describe("LLMWikiService.fetchWikiForWeek — 拉取上界（F4）", () => {
	let sandbox: sinon.SinonSandbox
	let fetchStub: sinon.SinonStub

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		// vscode-mock 未导出 ConfigurationTarget，而 fetchWikiForWeek 会读 vscode.ConfigurationTarget.Global。
		// mock 带 __esModule，故 import * as vscode 拿到的是同一个模块对象，赋值即可被被测代码看到。
		;(vscode as unknown as Record<string, unknown>).ConfigurationTarget = {
			Global: 1,
			Workspace: 2,
			WorkspaceFolder: 3,
		}
		// vscode-mock 的 getConfiguration 只实现了 get()，fetchWikiForWeek 还要调 update()
		sandbox.stub(vscode.workspace, "getConfiguration").returns({
			get: () => undefined,
			update: async () => {},
		} as never)
		fetchStub = sandbox.stub(globalThis, "fetch").resolves({
			ok: true,
			json: async () => ({
				data: [
					{ id: "a", title: "第3周标题", applicable_week: 3, content: "x" },
					{ id: "b", title: "第9周标题", applicable_week: 9, content: "y" },
				],
				textbook_chapters: [],
			}),
		} as never)

		// LLMWikiService 是单例，内部状态会跨用例残留 → 每个用例开始前复位
		const svc = LLMWikiService.getInstance()
		;(svc as unknown as { _wikiCache: Map<string, unknown[]> })._wikiCache = new Map()
		;(svc as unknown as { _textbookChapters: unknown[] })._textbookChapters = []
		;(svc as unknown as { _serverUrl: string })._serverUrl = "http://localhost:4001"
	})

	afterEach(() => {
		sandbox.restore()
		delete (vscode as unknown as Record<string, unknown>).ConfigurationTarget
	})

	it("★ 按后端允许的最大周拉取（否则索引永远看不到后续周，F4 是空操作）", async () => {
		const svc = LLMWikiService.getInstance()
		await svc.fetchWikiForWeek(5)
		const url = String(fetchStub.firstCall.args[0])
		expect(url).to.include("max_week=18")
	})

	it('★ 返回值仍只含本周可见的资料（"能取用"边界不得放宽）', async () => {
		const svc = LLMWikiService.getInstance()
		const visible = await svc.fetchWikiForWeek(5)
		expect(visible.map((c) => c.title)).to.deep.equal(["第3周标题"])
	})

	it("★ 拉取后索引可见后续周的标题（F4 的目标行为）", async () => {
		const svc = LLMWikiService.getInstance()
		await svc.fetchWikiForWeek(5)
		const groups = svc.buildIndexGroups()
		expect(groups.map((g) => g.week)).to.deep.equal([3, 9])
		expect(groups[1].titles).to.deep.equal(["第9周标题"])
	})
})
