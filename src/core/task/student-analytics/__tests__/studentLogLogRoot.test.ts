import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect } from "chai"
import { StudentLogPersister } from "../StudentLogPersister"
import type { StudentInteractionLog } from "../types"

/**
 * Task3 · 日志落盘根（logRoot）
 *
 * 实验模式下行为日志必须写进 `experiments/<id>/.cline-logs/`，而不是任务 cwd（工作区根）。
 * 这里锁死三件事：注入 logRoot 生效、未注入回退 cwd、会话中途 setLogRoot 立刻切换目标。
 */
describe("studentLogPersister — logRoot 注入", () => {
	let root = ""

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "persister-logroot-"))
	})

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	const event = (over: Partial<StudentInteractionLog> = {}): StudentInteractionLog => ({
		ts: new Date().toISOString(),
		taskId: "task-1",
		eventType: "turn_message",
		role: "user",
		category: "code_generation",
		contentLength: 12,
		hasCode: false,
		languageHint: "python",
		imageCount: 0,
		fileCount: 0,
		turnIndex: 0,
		...over,
	})

	it("★ 未注入 logRoot → 回退 cwd", () => {
		const persister = new StudentLogPersister(root)
		expect(persister.getLogRoot()).to.equal(root)
		expect(persister.getLogDir()).to.equal(path.join(root, ".cline-logs"))
		expect(persister.getLogPath()).to.equal(path.join(root, ".cline-logs", "student_interactions.log"))
	})

	it("★ 构造时注入 logRoot → getLogDir/getLogPath 指向它", () => {
		const logRoot = path.join(root, "experiments", "task_week2_loop")
		const persister = new StudentLogPersister(root, logRoot)
		expect(persister.getLogRoot()).to.equal(logRoot)
		expect(persister.getLogDir()).to.equal(path.join(logRoot, ".cline-logs"))
		expect(persister.getLogPath()).to.equal(path.join(logRoot, ".cline-logs", "student_interactions.log"))
	})

	it("★ persist 写到注入的 logRoot，cwd 下不产生日志", async () => {
		const logRoot = path.join(root, "experiments", "exp1")
		const persister = new StudentLogPersister(root, logRoot)
		persister.setContext({ mode: "experiment", experimentId: "exp1" })
		await persister.persist(event())

		const expected = path.join(logRoot, ".cline-logs", "student_interactions.log")
		expect(fs.existsSync(expected)).to.equal(true)
		expect(fs.existsSync(path.join(root, ".cline-logs", "student_interactions.log"))).to.equal(false)
		const parsed = JSON.parse(fs.readFileSync(expected, "utf8").trim()) as StudentInteractionLog
		expect(parsed.experimentId).to.equal("exp1")
	})

	it("★ setLogRoot 中途切换：后续写入立刻改目录，旧文件不追加", async () => {
		const persister = new StudentLogPersister(root)
		persister.setContext({ mode: "experiment", experimentId: "a" })
		await persister.persist(event())

		const second = path.join(root, "experiments", "b")
		persister.setLogRoot(second)
		persister.setContext({ mode: "experiment", experimentId: "b" })
		await persister.persist(event({ contentLength: 99 }))

		expect(persister.getLogRoot()).to.equal(second)
		expect(fs.readFileSync(persister.getLogPath(), "utf8").trim().split("\n").length).to.equal(1)
		const firstPath = path.join(root, ".cline-logs", "student_interactions.log")
		expect(fs.readFileSync(firstPath, "utf8").trim().split("\n").length).to.equal(1)
	})

	it("★ logRoot 切换不影响 enabled 门控（free 仍不写）", async () => {
		const persister = new StudentLogPersister(root, path.join(root, "experiments", "x"))
		persister.setEnabled(false)
		persister.setContext({ mode: "free" })
		await persister.persist(event())
		expect(fs.existsSync(persister.getLogPath())).to.equal(false)
	})
})
