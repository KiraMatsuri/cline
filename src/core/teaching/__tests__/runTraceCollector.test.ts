import "should"
import * as fs from "fs"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"

import { resolveRunTraceRoot, pickWorkspaceRoot, type RunTraceRecord, stripAnsi, tailOf } from "../submission/RunTraceCollector"
import { readRunTraces } from "../submission/SubmissionPackager"

function folder(fsPath: string): { uri: { fsPath: string } } {
	return { uri: { fsPath } } as unknown as { uri: { fsPath: string } }
}

describe("运行痕迹采集（P1-2 / RT-1、RT-2）", () => {
	it("剥掉 ANSI 颜色与 \\r，行数不变", () => {
		const raw = "\u001b[31mKeyError: 'a'\u001b[0m\r\nTraceback…\r\n"
		stripAnsi(raw).should.equal("KeyError: 'a'\nTraceback…\n")
	})

	it("tailOf 只留尾部，且不截断成半个字符", () => {
		const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")
		const tail = tailOf(text, 60)
		tail.length.should.be.belowOrEqual(60)
		tail.should.startWith("line ")
		tail.split("\n").length.should.be.above(1)
		text.should.endWith(tail)
	})

	it("短输出原样返回（仅 trim）", () => {
		tailOf("  ok  ").should.equal("ok")
	})

	it("pickWorkspaceRoot：cwd 落在子目录时归到对应工作区", () => {
		const result = pickWorkspaceRoot("D:\\repo\\src\\pkg", [folder("D:\\repo"), folder("D:\\other")] as never)
		result!.should.equal("D:\\repo")
	})

	it("pickWorkspaceRoot：大小写与斜杠不敏感", () => {
		pickWorkspaceRoot("d:/REPO/sub", [folder("D:\\repo")] as never)!.should.equal("D:\\repo")
	})

	it("pickWorkspaceRoot：cwd 不在任何工作区时，仅单工作区兜底", () => {
		;(pickWorkspaceRoot("C:\\temp", [folder("D:\\repo")] as never) === "D:\\repo").should.be.true()
		;(pickWorkspaceRoot("C:\\temp", [folder("D:\\repo"), folder("D:\\other")] as never) === null).should.be.true()
	})

	it("pickWorkspaceRoot：没有工作区 → null（RT-2：不写文件也不报错）", () => {
		;(pickWorkspaceRoot("C:\\temp", [] as never) === null).should.be.true()
	})

	it("写出来的 jsonl 能被 readRunTraces 原样读回（RT-1）", () => {
		const root = path.join(".tmp-test", "runTraceCollector")
		const dir = path.join(root, ".cline-logs")
		fs.mkdirSync(dir, { recursive: true })
		const record: RunTraceRecord = {
			ts: new Date().toISOString(),
			command: "python lru.py",
			exit_code: 1,
			stdout_tail: "Traceback (most recent call last):\nKeyError: 'a'",
			cwd: root,
		}
		fs.writeFileSync(path.join(dir, "run_traces.jsonl"), `${JSON.stringify(record)}\n`, "utf8")

		const traces = readRunTraces(root)
		traces.length.should.equal(1)
		traces[0].command!.should.equal("python lru.py")
		traces[0].exit_code!.should.equal(1)
		traces[0].stdout_tail!.should.containEql("KeyError")

		// 坏行不能影响其它行
		fs.appendFileSync(path.join(dir, "run_traces.jsonl"), "not json\n", "utf8")
		readRunTraces(root).length.should.equal(1)

		fs.rmSync(path.join(".tmp-test"), { recursive: true, force: true })
	})

	it("readRunTraces 对不存在的文件返回空数组（RT-2）", () => {
		readRunTraces(path.join(".tmp-test", "no-such-workspace")).should.eql([])
	})
})

/**
 * Task3 · 运行痕迹目录路由
 *
 * 实验模式下运行痕迹要写进 `experiments/<id>/.cline-logs/`，否则同一个工作区的
 * 多个任务会混在根 `run_traces.jsonl` 里；没有活动会话时保持写根（自由模式不改）。
 */
describe("运行痕迹目录路由（resolveRunTraceRoot）", () => {
	let root = ""

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "run-trace-root-"))
	})

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	it("★ 没有活动会话 → 工作区根", () => {
		resolveRunTraceRoot(root).should.equal(root)
	})

	it("★ 有活动会话 → experiments/<id>", () => {
		const target = resolveRunTraceRoot(root, () => ({
			assignmentId: "task_week2_yufayu",
			startedAt: "2026-10-25T04:23:04.924Z",
			status: "active",
		}))
		target.should.equal(path.join(root, "experiments", "task_week2_yufayu"))
	})

	it("★ 缺省 reader 读真实会话文件", () => {
		fs.mkdirSync(path.join(root, ".cline-logs"), { recursive: true })
		fs.writeFileSync(
			path.join(root, ".cline-logs", "active-experiment.json"),
			JSON.stringify({
				assignmentId: "from_file",
				startedAt: "2026-10-25T04:23:04.924Z",
				status: "active",
			}),
			"utf8",
		)
		resolveRunTraceRoot(root).should.equal(path.join(root, "experiments", "from_file"))
	})

	it("★ 会话文件损坏 → 根（降级，不抛）", () => {
		fs.mkdirSync(path.join(root, ".cline-logs"), { recursive: true })
		fs.writeFileSync(path.join(root, ".cline-logs", "active-experiment.json"), "{broken", "utf8")
		resolveRunTraceRoot(root).should.equal(root)
	})

	it("★ reader 抛错 → 根（降级，不阻断终端使用）", () => {
		const target = resolveRunTraceRoot(root, () => {
			throw new Error("disk on fire")
		})
		target.should.equal(root)
	})

	it("★ id 含分隔符时路径仍 sanitize", () => {
		const target = resolveRunTraceRoot(root, () => ({
			assignmentId: "a/b",
			startedAt: "2026-10-25T04:23:04.924Z",
			status: "active",
		}))
		target.should.equal(path.join(root, "experiments", "a_b"))
	})
})
