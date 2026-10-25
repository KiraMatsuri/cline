import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { expect } from "chai"
import { EXPERIMENT_ROOT, sanitizeSegment } from "../ExperimentWorkspace"
import {
	ACTIVE_EXPERIMENT_FILE,
	activeExperimentPath,
	endExperimentSession,
	experimentLogRoot,
	readActiveExperiment,
	startExperimentSession,
	toExperimentSessionView,
} from "../ExperimentSession"

/**
 * Task1 · 活动实验会话文件
 *
 * 「开始实验之后是不是还在实验模式」这件事必须跨任务、跨重启都成立，所以绑定
 * 落在工作区级会话文件上；这里的测试要保证：
 *   ① 正常读写 round-trip；
 *   ② 文件损坏 / 字段类型错 / 空 id 一律降级为「没有活动会话」（不抛）；
 *   ③ id 一律 sanitize，不允许把 `..`、分隔符带进路径；
 *   ④ 结束实验只删会话文件，不碰实验目录。
 */
describe("experimentSession — 活动实验会话文件", () => {
	let root = ""

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "active-experiment-"))
	})

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	it("★ 没有会话文件 → null", () => {
		expect(readActiveExperiment(root)).to.equal(null)
	})

	it("★ 无工作区（null/undefined/空串）→ null 且路径为空", () => {
		expect(readActiveExperiment(null)).to.equal(null)
		expect(readActiveExperiment(undefined)).to.equal(null)
		expect(readActiveExperiment("")).to.equal(null)
		expect(activeExperimentPath("")).to.equal("")
	})

	it("★ 会话路径固定为 <root>/.cline-logs/active-experiment.json", () => {
		expect(activeExperimentPath(root)).to.equal(path.join(root, ACTIVE_EXPERIMENT_FILE))
	})

	it("★ start → read round-trip，字段完整", () => {
		startExperimentSession({
			workspaceRoot: root,
			assignmentId: "task_week2_yufayu",
			assignmentTitle: "变量与类型",
			language: "python",
			template: "main.py",
			now: new Date("2026-10-25T04:23:04.924Z"),
		})
		expect(fs.existsSync(activeExperimentPath(root))).to.equal(true)

		const session = readActiveExperiment(root)
		expect(session).to.not.equal(null)
		expect(session?.assignmentId).to.equal("task_week2_yufayu")
		expect(session?.assignmentTitle).to.equal("变量与类型")
		expect(session?.language).to.equal("python")
		expect(session?.template).to.equal("main.py")
		expect(session?.startedAt).to.equal("2026-10-25T04:23:04.924Z")
		expect(session?.status).to.equal("active")
	})

	it("★ 父目录不存在时自动创建 .cline-logs", () => {
		startExperimentSession({ workspaceRoot: root, assignmentId: "t1" })
		expect(fs.existsSync(path.join(root, ".cline-logs"))).to.equal(true)
	})

	it("★ JSON 损坏 → null（不抛）", () => {
		fs.mkdirSync(path.join(root, ".cline-logs"), { recursive: true })
		fs.writeFileSync(activeExperimentPath(root), "{not-json", "utf8")
		expect(readActiveExperiment(root)).to.equal(null)
	})

	it("★ 字段类型错 / status 不是 active / 缺 startedAt → null", () => {
		const write = (body: Record<string, unknown>) => {
			fs.mkdirSync(path.join(root, ".cline-logs"), { recursive: true })
			fs.writeFileSync(activeExperimentPath(root), JSON.stringify(body), "utf8")
		}

		write({ assignmentId: 123, startedAt: "2026-10-25T00:00:00.000Z", status: "active" })
		expect(readActiveExperiment(root)).to.equal(null)

		write({ assignmentId: "a", startedAt: "2026-10-25T00:00:00.000Z", status: "ended" })
		expect(readActiveExperiment(root)).to.equal(null)

		write({ assignmentId: "a", startedAt: "", status: "active" })
		expect(readActiveExperiment(root)).to.equal(null)

		write({ assignmentId: "a", startedAt: "2026-10-25T00:00:00.000Z", status: "active", language: 42 })
		expect(readActiveExperiment(root)).to.equal(null)

		write({ assignmentId: "", startedAt: "2026-10-25T00:00:00.000Z", status: "active" })
		expect(readActiveExperiment(root)).to.equal(null)
	})

	it("★ id 含分隔符 / 上跳 / 空白 → 写入与回读都 sanitize", () => {
		const session = startExperimentSession({ workspaceRoot: root, assignmentId: "task/../x y" })
		const expected = sanitizeSegment("task/../x y")
		expect(session.assignmentId).to.equal(expected)
		expect(readActiveExperiment(root)?.assignmentId).to.equal(expected)
		expect(experimentLogRoot(root, session.assignmentId)).to.equal(
			path.join(root, EXPERIMENT_ROOT, expected),
		)
		// 路径里不允许出现 .. 或分隔符
		expect(session.assignmentId.includes("/")).to.equal(false)
		expect(session.assignmentId.includes("\\")).to.equal(false)
		expect(session.assignmentId.includes("..")).to.equal(false)
	})

	it("★ 空 id → 兜底为 assignment（不会写出空目录名）", () => {
		const session = startExperimentSession({ workspaceRoot: root, assignmentId: "   " })
		expect(session.assignmentId).to.equal("assignment")
		expect(readActiveExperiment(root)?.assignmentId).to.equal("assignment")
	})

	it("★ 重复 start → 覆盖为最新值，且不残留临时文件", () => {
		startExperimentSession({
			workspaceRoot: root,
			assignmentId: "first",
			now: new Date("2026-10-25T01:00:00.000Z"),
		})
		startExperimentSession({
			workspaceRoot: root,
			assignmentId: "second",
			assignmentTitle: "第二个",
			now: new Date("2026-10-25T02:00:00.000Z"),
		})
		const session = readActiveExperiment(root)
		expect(session?.assignmentId).to.equal("second")
		expect(session?.assignmentTitle).to.equal("第二个")
		expect(session?.startedAt).to.equal("2026-10-25T02:00:00.000Z")
		expect(fs.readdirSync(path.join(root, ".cline-logs")).sort()).to.deep.equal(["active-experiment.json"])
	})

	it("★ end → 删除会话文件返回 true；再 end 返回 false；实验目录保留", () => {
		startExperimentSession({ workspaceRoot: root, assignmentId: "keepme" })
		const experimentDir = path.join(root, EXPERIMENT_ROOT, "keepme")
		fs.mkdirSync(experimentDir, { recursive: true })

		expect(endExperimentSession(root)).to.equal(true)
		expect(readActiveExperiment(root)).to.equal(null)
		expect(fs.existsSync(experimentDir)).to.equal(true)

		expect(endExperimentSession(root)).to.equal(false)
		expect(endExperimentSession("")).to.equal(false)
	})

	it("★ experimentLogRoot 指向 experiments/<sanitized>，与 ExperimentWorkspace 一致", () => {
		expect(experimentLogRoot(root, "task_week2_loop")).to.equal(
			path.join(root, EXPERIMENT_ROOT, "task_week2_loop"),
		)
		expect(experimentLogRoot(root, "a/b")).to.equal(path.join(root, EXPERIMENT_ROOT, "a_b"))
	})

	it("★ toExperimentSessionView：无会话 → active=false；有会话带 logRoot", () => {
		expect(toExperimentSessionView(root, null)).to.deep.equal({ active: false })
		startExperimentSession({
			workspaceRoot: root,
			assignmentId: "viewme",
			assignmentTitle: "视图",
			language: "java",
			template: "Main.java",
		})
		const view = toExperimentSessionView(root, readActiveExperiment(root))
		expect(view.active).to.equal(true)
		expect(view.assignmentId).to.equal("viewme")
		expect(view.assignmentTitle).to.equal("视图")
		expect(view.language).to.equal("java")
		expect(view.template).to.equal("Main.java")
		expect(view.logRoot).to.equal(path.join(root, EXPERIMENT_ROOT, "viewme"))
	})
})
