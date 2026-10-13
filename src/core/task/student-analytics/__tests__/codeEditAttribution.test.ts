/**
 * F2 · code_edit 编辑者归属：AI 落盘（write_to_file / apply_patch）不得被判成「学生动手」。
 *
 * 背景见 docs/design/teaching-intervention-acceptance-and-revisions.md §7.4：
 * 旧实现遇 code_edit 即清零 assistantCodeStreak，而 AI 每次落盘都会产生 code_edit，
 * 于是 streak 在 0/1 之间震荡，consecutive_code_generation（阈值 3）永远达不到。
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { FileContextTracker } from "@core/context/context-tracking/FileContextTracker"
import * as diskModule from "@core/storage/disk"
import { expect } from "chai"
import chokidar from "chokidar"
import { afterEach, beforeEach } from "mocha"
import * as sinon from "sinon"
import * as vscode from "vscode"
import type { Controller } from "@/core/controller"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { resolveEditEditor, resolveEditRole } from "../CodeEditTracker"
import { editEv as ev } from "./__fixtures__/events"

const asstCode = () => ev({ eventType: "turn_message", role: "assistant", hasCodeBlock: true })

const ruleIds = (m: BehaviorMonitor) => m.getPendingAlerts().map((a) => a.ruleId)

describe("F2 · code_edit 编辑者归属", () => {
	it("tracker 缺失 → 人工（向后兼容）", () => {
		expect(resolveEditEditor("a.py", undefined)).to.equal("user")
	})

	it("tracker 判定为 AI 写盘 → 'ai'", () => {
		expect(resolveEditEditor("a.py", { wasRecentlyWrittenByCline: () => true })).to.equal("ai")
	})

	it("tracker 抛错 → 回退人工，不向上抛", () => {
		expect(
			resolveEditEditor("a.py", {
				wasRecentlyWrittenByCline: () => {
					throw new Error("x")
				},
			}),
		).to.equal("user")
	})

	it("★ AI 落盘不再清零 streak（旧行为会清零）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(asstCode())
		m.ingest(asstCode())
		m.ingest(ev({ editor: "ai" })) // ← AI 写盘
		m.ingest(asstCode()) // 第 3 个含代码块回合
		expect(ruleIds(m)).to.include("consecutive_code_generation")
	})

	it("人工编辑仍然清零", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(asstCode())
		m.ingest(asstCode())
		m.ingest(ev({ editor: "user" }))
		m.ingest(asstCode())
		expect(ruleIds(m)).to.not.include("consecutive_code_generation")
	})

	it("缺省 editor（旧日志/旧事件）按人工处理", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(asstCode())
		m.ingest(asstCode())
		m.ingest(ev({})) // 无 editor
		m.ingest(asstCode())
		expect(ruleIds(m)).to.not.include("consecutive_code_generation")
	})
})

describe("F11-③ · 编辑日志的 role 归属", () => {
	it("① resolveEditRole('ai') → 'assistant'", () => {
		expect(resolveEditRole("ai")).to.equal("assistant")
	})

	it("② resolveEditRole('user') → 'user'", () => {
		expect(resolveEditRole("user")).to.equal("user")
	})

	it("③ 结构守卫：两个日志构造点不再硬编码 role，且均改用 resolveEditRole(editor)", () => {
		// ⚠️ 这是对**源码结构**的探测（变更探测器），不是端到端验证 ——
		// 真正的归属验证靠 M8' 人工核对日志（两处日志字面量无法在单测里直接跑，CodeEditTracker 依赖 vscode）。
		const src = fs.readFileSync(path.join(__dirname, "..", "CodeEditTracker.ts"), "utf-8")
		expect(src).to.not.include('role: "user"')
		expect(src.match(/resolveEditRole\(editor\)/g)?.length ?? 0).to.equal(2)
	})
})

describe("F2 · wasRecentlyWrittenByCline 只读语义（不得破坏既有 watcher）", () => {
	it("连续两次查询都为 true —— 证明它不消费状态", () => {
		const tracker = new FileContextTracker({} as Controller, "t1")
		tracker.markFileAsEditedByCline("a.py")
		expect(tracker.wasRecentlyWrittenByCline("a.py")).to.equal(true)
		expect(tracker.wasRecentlyWrittenByCline("a.py")).to.equal(true)
	})

	it("★ Windows 反斜杠 vs 正斜杠必须命中（真实链路的失效点）", () => {
		const t = new FileContextTracker({} as Controller, "t1")
		t.markFileAsEditedByCline("src\\foo.ts") // 工具侧：反斜杠
		expect(t.wasRecentlyWrittenByCline("src/foo.ts")).to.equal(true) // 查询侧：正斜杠
		t.markFileAsEditedByCline("./src/bar.ts")
		expect(t.wasRecentlyWrittenByCline("src/bar.ts")).to.equal(true) // 前导 ./
	})

	it("★【F2 残留】win32 下大小写不敏感：与 arePathsEqual 口径一致", () => {
		// POSIX 上 Src/ 与 src/ 是不同目录，大小写折叠是错的 ⇒ 仅 win32 断言
		if (process.platform !== "win32") return
		const t = new FileContextTracker({} as Controller, "t1")
		t.markFileAsEditedByCline("SRC/Foo.ts") // 工具侧：大写
		expect(t.wasRecentlyWrittenByCline("src/foo.ts")).to.equal(true) // 查询侧：小写
	})
})

// Task 2 Step 5 的护栏原本只写在 src/core/context/context-tracking/FileContextTracker.test.ts，
// 而 .mocharc.json 的 spec 只覆盖 __tests__ 目录 —— 那个文件不在 glob 内，护栏在
// `npm run test:unit` 里从不执行。这里用**行为断言**（走真实 watcher 的 change 分支，不窥探私有字段）
// 把同一语义纳入 glob：markFileAsEditedByCline 写入的一次性标志被消费一次后即失效。
describe("Task2 Step5 护栏 · 一次性标志仍被 watcher 消费（纳入 unit glob）", () => {
	const filePath = "src/one-shot.ts"
	let sandbox: sinon.SinonSandbox
	let watcher: any

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		// vscode-mock 未定义 workspaceFolders，无法 stub，只能 define（getCwd 依赖它）
		Object.defineProperty(vscode.workspace, "workspaceFolders", {
			value: [{ uri: { fsPath: "/mock/workspace" } }],
			configurable: true,
			writable: true,
		})
		watcher = { close: sandbox.stub().resolves(), on: sandbox.stub() }
		watcher.on.returns(watcher)
		sandbox.stub(chokidar, "watch").returns(watcher)
		sandbox.stub(diskModule, "getTaskMetadata").resolves({ files_in_context: [], model_usage: [], environment_history: [] })
		sandbox.stub(diskModule, "saveTaskMetadata").resolves()
		setVscodeHostProviderMock()
	})

	afterEach(() => {
		sandbox.restore()
		delete (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders
	})

	it("标志被消费一次后失效：Cline 写盘不计用户编辑，随后真正的用户编辑仍被记录", async () => {
		const tracker = new FileContextTracker({} as Controller, "t1")
		await tracker.setupFileWatcher(filePath)
		const onChange = watcher.on.firstCall.args[1] as () => void

		tracker.markFileAsEditedByCline(filePath)

		// 第 1 次 change：一次性标志存在 → 被消费，不算用户编辑
		onChange()
		expect(tracker.getAndClearRecentlyModifiedFiles()).to.not.include(filePath)

		// 第 2 次 change：标志已被消费 → 视为用户编辑（证明它确实是一次性的，且未被本 Task 破坏）
		onChange()
		expect(tracker.getAndClearRecentlyModifiedFiles()).to.include(filePath)
	})
})
