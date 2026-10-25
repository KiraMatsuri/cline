import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect } from "chai"
import { StudentLogPersister } from "../../task/student-analytics/StudentLogPersister"
import type { StudentInteractionLog } from "../../task/student-analytics/types"
import {
	DEMAND_LADDER,
	describeSessionMode,
	detectExperimentId,
	EXPERIMENT_ROOT,
	interventionEnabled,
	ladderLimit,
	logPersistEnabled,
	readExperimentTask,
	resolveSessionContext,
	type SessionContext,
	wikiEnabled,
} from "../TeachingSessionMode"

/**
 * P1-1 · 会话模式与门控
 *
 * 这一层是「日志记不记、干预停不停」的唯一判定点，所以它必须能回答三个问题：
 *   ① 当前是哪种模式（路径 / 元数据 / 显式传参三条来源，优先级固定）；
 *   ② 该模式下日志、干预、教材检索各自是否启用；
 *   ③ 元数据坏了（BN-14）、id 含中文（BN-15）、消息频率极高（BN-16）时行为仍然确定。
 */
describe("sessionMode — 会话模式判定", () => {
	let root = ""

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "session-mode-"))
	})

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	function makeExperimentDir(id: string, task?: Record<string, unknown> | string): string {
		const dir = path.join(root, EXPERIMENT_ROOT, id)
		fs.mkdirSync(path.join(dir, ".teaching"), { recursive: true })
		if (task !== undefined) {
			const body = typeof task === "string" ? task : JSON.stringify(task)
			fs.writeFileSync(path.join(dir, ".teaching", "task.json"), body, "utf8")
		}
		return dir
	}

	it("★ 无 task.json 的普通目录 → free", () => {
		const ctx = resolveSessionContext({ cwd: root })
		expect(ctx.mode).to.equal("free")
		expect(ctx.experimentId).to.equal(undefined)
	})

	it("★ 实验目录 → experiment，experimentId 取自目录名", () => {
		const dir = makeExperimentDir("task_week2_loop", { assignmentId: "task_week2_loop", mode: "experiment" })
		const ctx = resolveSessionContext({ cwd: dir })
		expect(ctx.mode).to.equal("experiment")
		expect(ctx.experimentId).to.equal("task_week2_loop")
	})

	it("★ free 四件套：不记日志、不干预、可用 wiki、阶梯 3", () => {
		const ctx = resolveSessionContext({ cwd: root })
		expect(logPersistEnabled(ctx)).to.equal(false)
		expect(interventionEnabled(ctx)).to.equal(false)
		expect(wikiEnabled(ctx)).to.equal(true)
		expect(ladderLimit(ctx)).to.equal(3)
	})

	it("★ experiment 四件套：记日志、干预、可用 wiki、阶梯 4", () => {
		const dir = makeExperimentDir("t1", { assignmentId: "t1" })
		const ctx = resolveSessionContext({ cwd: dir })
		expect(logPersistEnabled(ctx)).to.equal(true)
		expect(interventionEnabled(ctx)).to.equal(true)
		expect(wikiEnabled(ctx)).to.equal(true)
		expect(ladderLimit(ctx)).to.equal(4)
		expect(DEMAND_LADDER).to.deep.equal({ free: 3, experiment: 4 })
	})

	it("★ BN-14：task.json 是坏 JSON → 仍按路径判定为 experiment", () => {
		const dir = makeExperimentDir("broken", "{ not json")
		const ctx = resolveSessionContext({ cwd: dir })
		expect(ctx.mode).to.equal("experiment")
		expect(ctx.experimentId).to.equal("broken")
	})

	it("★ BN-14 补：坏 JSON 且不在 experiments 目录下 → free（不猜）", () => {
		fs.writeFileSync(path.join(root, ".teaching"), "", "utf8") // 让 task.json 读不到
		const ctx = resolveSessionContext({ cwd: root, taskReader: () => null })
		expect(ctx.mode).to.equal("free")
	})

	it("★ BN-15：experimentId 含中文与空格也能识别", () => {
		const dir = makeExperimentDir("实验 一", { assignmentId: "实验 一" })
		const ctx = resolveSessionContext({ cwd: dir })
		expect(ctx.mode).to.equal("experiment")
		expect(ctx.experimentId).to.equal("实验 一")
	})

	it("★ 路径里没有 experiments 时，task.json 的 assignmentId 也能判定", () => {
		const dir = path.join(root, "custom-dir")
		fs.mkdirSync(path.join(dir, ".teaching"), { recursive: true })
		fs.writeFileSync(path.join(dir, ".teaching", "task.json"), JSON.stringify({ assignmentId: "task_x" }), "utf8")
		const ctx = resolveSessionContext({ cwd: dir })
		expect(ctx.mode).to.equal("experiment")
		expect(ctx.experimentId).to.equal("task_x")
	})

	it("★ 显式 experimentId（会话恢复）优先于路径判定", () => {
		const ctx = resolveSessionContext({ cwd: root, experimentId: "restored_id" })
		expect(ctx.mode).to.equal("experiment")
		expect(ctx.experimentId).to.equal("restored_id")
	})

	it("★ 显式 mode=free 覆盖实验路径（教师手工放行）", () => {
		const dir = makeExperimentDir("forced", { assignmentId: "forced" })
		const ctx = resolveSessionContext({ cwd: dir, mode: "free" })
		expect(ctx.mode).to.equal("free")
		expect(logPersistEnabled(ctx)).to.equal(false)
	})

	it("★ 模式判定只看 cwd，不受「打开的文件」影响（两个并存上下文互不干扰）", () => {
		const dirFree = path.join(root, "plain")
		const dirExp = makeExperimentDir("exp", { assignmentId: "exp" })
		fs.mkdirSync(dirFree, { recursive: true })
		const a: SessionContext = resolveSessionContext({ cwd: dirFree })
		const b: SessionContext = resolveSessionContext({ cwd: dirExp })
		expect([a.mode, b.mode]).to.deep.equal(["free", "experiment"])
		expect([logPersistEnabled(a), logPersistEnabled(b)]).to.deep.equal([false, true])
	})

	it("★ detectExperimentId：取最后一个 experiments 段之后的目录名", () => {
		expect(detectExperimentId(path.join("D:", "ws", "experiments", "t9", "src"))).to.equal("t9")
		expect(detectExperimentId(path.join("D:", "ws", "experiments"))).to.equal(null)
		expect(detectExperimentId(path.join("D:", "ws"))).to.equal(null)
		expect(detectExperimentId("")).to.equal(null)
	})

	it("★ readExperimentTask：缺失返回 null，损坏返回 null，正常返回对象", () => {
		expect(readExperimentTask(path.join(root, "nope"))).to.equal(null)
		const bad = makeExperimentDir("bad2", "{oops")
		expect(readExperimentTask(bad)).to.equal(null)
		const good = makeExperimentDir("good", { assignmentId: "good", mode: "experiment" })
		expect(readExperimentTask(good)?.assignmentId).to.equal("good")
	})

	it("★ describeSessionMode 文案区分两种模式", () => {
		const free = resolveSessionContext({ cwd: root })
		expect(describeSessionMode(free)).to.include("自由问答模式")
		const dir = makeExperimentDir("d1", { assignmentId: "d1" })
		expect(describeSessionMode(resolveSessionContext({ cwd: dir }))).to.include("实验任务模式")
	})
})

/**
 * P1-1 · 日志门控（StudentLogPersister）
 *
 * 门控做在持久化器里，所以这里直接驱动它：自由模式写 3 条 → 文件都不该出现；
 * 实验模式写 1 条 → 行里必须带 mode/experimentId。
 */
describe("modeLogging — 日志按模式门控", () => {
	let dir = ""

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-log-"))
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
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

	it("★ 自由模式：3 条事件后日志文件不存在（BN-16 高频也不增长）", async () => {
		const persister = new StudentLogPersister(dir)
		persister.setEnabled(false)
		persister.setContext({ mode: "free" })
		for (let i = 0; i < 30; i++) {
			await persister.persist(event({ contentLength: i }))
		}
		await persister.persistBatch([event(), event()])
		expect(fs.existsSync(persister.getLogPath())).to.equal(false)
	})

	it("★ 实验模式：落盘且带 mode=experiment 与 experimentId", async () => {
		const persister = new StudentLogPersister(dir)
		persister.setEnabled(true)
		persister.setContext({ mode: "experiment", experimentId: "task_week2_loop" })
		await persister.persist(event())
		const lines = fs.readFileSync(persister.getLogPath(), "utf8").trim().split("\n")
		expect(lines.length).to.equal(1)
		const parsed = JSON.parse(lines[0]) as StudentInteractionLog
		expect(parsed.mode).to.equal("experiment")
		expect(parsed.experimentId).to.equal("task_week2_loop")
		expect(parsed.taskId).to.equal("task-1")
	})

	it("★ 批量落盘同样盖章（persistBatch）", async () => {
		const persister = new StudentLogPersister(dir)
		persister.setEnabled(true)
		persister.setContext({ mode: "experiment", experimentId: "t7" })
		await persister.persistBatch([event(), event({ eventType: "code_edit" })])
		const lines = fs.readFileSync(persister.getLogPath(), "utf8").trim().split("\n")
		expect(lines.length).to.equal(2)
		expect(lines.every((l) => (JSON.parse(l) as StudentInteractionLog).experimentId === "t7")).to.equal(true)
	})

	it("★ 未设置 context 时保持旧行为（不盖章），向后兼容", async () => {
		const persister = new StudentLogPersister(dir)
		expect(persister.isEnabled()).to.equal(true)
		await persister.persist(event())
		const parsed = JSON.parse(fs.readFileSync(persister.getLogPath(), "utf8").trim()) as StudentInteractionLog
		expect(parsed.mode).to.equal(undefined)
		expect(parsed.experimentId).to.equal(undefined)
	})
})

/**
 * Task2 · 工作区级会话文件进入模式判定链
 *
 * 聊天任务 cwd 永远是工作区根，所以「开始实验」后唯一的全局线索就是
 * `<root>/.cline-logs/active-experiment.json`；这里锁定它的优先级、logRoot 计算与降级。
 */
describe("sessionFileMode — 根会话文件判定", () => {
	let root = ""

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "session-file-mode-"))
	})

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	function writeSession(body: unknown): void {
		fs.mkdirSync(path.join(root, ".cline-logs"), { recursive: true })
		fs.writeFileSync(
			path.join(root, ".cline-logs", "active-experiment.json"),
			typeof body === "string" ? body : JSON.stringify(body),
			"utf8",
		)
	}

	function writeTaskFile(dir: string, assignmentId: string): void {
		fs.mkdirSync(path.join(dir, ".teaching"), { recursive: true })
		fs.writeFileSync(path.join(dir, ".teaching", "task.json"), JSON.stringify({ assignmentId }), "utf8")
	}

	it("★ 根目录有活动会话 → experiment，id 与 logRoot 都指向实验目录", () => {
		writeSession({
			assignmentId: "task_week2_yufayu",
			startedAt: "2026-10-25T04:23:04.924Z",
			status: "active",
		})
		const ctx = resolveSessionContext({ cwd: root })
		expect(ctx.mode).to.equal("experiment")
		expect(ctx.experimentId).to.equal("task_week2_yufayu")
		expect(ctx.logRoot).to.equal(path.join(root, EXPERIMENT_ROOT, "task_week2_yufayu"))
		expect(logPersistEnabled(ctx)).to.equal(true)
	})

	it("★ 显式 mode=free 压过活动会话", () => {
		writeSession({ assignmentId: "a", startedAt: "2026-10-25T00:00:00.000Z", status: "active" })
		const ctx = resolveSessionContext({ cwd: root, mode: "free" })
		expect(ctx.mode).to.equal("free")
		expect(ctx.experimentId).to.equal(undefined)
		expect(logPersistEnabled(ctx)).to.equal(false)
	})

	it("★ 路径 experiments/other 优先于根会话的另一个任务", () => {
		writeSession({ assignmentId: "from_session", startedAt: "2026-10-25T00:00:00.000Z", status: "active" })
		const dir = path.join(root, EXPERIMENT_ROOT, "from_path")
		fs.mkdirSync(path.join(dir, ".teaching"), { recursive: true })
		const ctx = resolveSessionContext({ cwd: dir })
		expect(ctx.experimentId).to.equal("from_path")
		expect(ctx.logRoot).to.equal(path.join(root, EXPERIMENT_ROOT, "from_path"))
	})

	it("★ 会话文件损坏 / 缺失 → free", () => {
		writeSession("{broken")
		expect(resolveSessionContext({ cwd: root }).mode).to.equal("free")
		fs.rmSync(path.join(root, ".cline-logs", "active-experiment.json"))
		expect(resolveSessionContext({ cwd: root }).mode).to.equal("free")
	})

	it("★ task.json 与根会话同时存在且 id 不同 → task.json 优先（cwd 语义）", () => {
		writeSession({ assignmentId: "from_session", startedAt: "2026-10-25T00:00:00.000Z", status: "active" })
		writeTaskFile(root, "from_taskfile")
		const ctx = resolveSessionContext({ cwd: root })
		expect(ctx.experimentId).to.equal("from_taskfile")
		expect(ctx.logRoot).to.equal(path.join(root, EXPERIMENT_ROOT, "from_taskfile"))
	})

	it("★ 注入 sessionReader 时以注入值为准（可模拟无会话）", () => {
		writeSession({ assignmentId: "real_file", startedAt: "2026-10-25T00:00:00.000Z", status: "active" })
		const ctx = resolveSessionContext({ cwd: root, sessionReader: () => null })
		expect(ctx.mode).to.equal("free")

		const mocked = resolveSessionContext({
			cwd: root,
			sessionReader: () => ({ assignmentId: "mock_id", startedAt: "x", status: "active" }),
		})
		expect(mocked.experimentId).to.equal("mock_id")
		expect(mocked.logRoot).to.equal(path.join(root, EXPERIMENT_ROOT, "mock_id"))
	})

	it("★ sessionReader 抛错 → 降级 free（不阻断聊天）", () => {
		const ctx = resolveSessionContext({
			cwd: root,
			sessionReader: () => {
				throw new Error("disk on fire")
			},
		})
		expect(ctx.mode).to.equal("free")
	})

	it("★ 显式 experimentId 优先于路径", () => {
		const dir = path.join(root, EXPERIMENT_ROOT, "by_path")
		fs.mkdirSync(dir, { recursive: true })
		const ctx = resolveSessionContext({ cwd: dir, workspaceRoot: root, experimentId: "explicit" })
		expect(ctx.experimentId).to.equal("explicit")
		expect(ctx.logRoot).to.equal(path.join(root, EXPERIMENT_ROOT, "explicit"))
	})

	it("★ 显式 mode=experiment 且无 id 时，用会话文件的 id 并计算实验 logRoot", () => {
		writeSession({ assignmentId: "from_session", startedAt: "2026-10-25T00:00:00.000Z", status: "active" })
		const ctx = resolveSessionContext({ cwd: root, mode: "experiment" })
		expect(ctx.mode).to.equal("experiment")
		expect(ctx.experimentId).to.equal("from_session")
		expect(ctx.logRoot).to.equal(path.join(root, EXPERIMENT_ROOT, "from_session"))
	})

	it("★ 自由模式 logRoot 仍是 cwd（用于定位，不写入）", () => {
		const dir = path.join(root, "plain")
		fs.mkdirSync(dir, { recursive: true })
		const ctx = resolveSessionContext({ cwd: dir })
		expect(ctx.mode).to.equal("free")
		expect(ctx.logRoot).to.equal(dir)
	})
})
