import * as fs from "fs"
import { after, before, describe, it } from "mocha"
import * as path from "path"
import "should"

import {
	defaultStudentLogPath,
	describeLogSource,
	expandLogTarget,
	findStudentLogByWalkingUp,
	resolveLogPath,
	STUDENT_LOG_ENV,
	STUDENT_LOG_RELATIVE,
} from "../logPathResolver"

const ROOT = path.join(process.cwd(), ".tmp-test", "logPathResolver")

function mkLog(dir: string, content = '{"ts":"2026-01-01T00:00:00.000Z","taskId":"t1"}\n'): string {
	const file = defaultStudentLogPath(dir)
	fs.mkdirSync(path.dirname(file), { recursive: true })
	fs.writeFileSync(file, content, "utf8")
	return file
}

describe("logPathResolver（需求 1：日志路径不再写死）", () => {
	before(() => {
		fs.rmSync(ROOT, { recursive: true, force: true })
		fs.mkdirSync(ROOT, { recursive: true })
	})

	after(() => {
		fs.rmSync(ROOT, { recursive: true, force: true })
	})

	describe("常量与路径拼接", () => {
		it("默认路径应为 <dir>/.cline-logs/student_interactions.log", () => {
			const p = defaultStudentLogPath(path.join(ROOT, "any"))
			path.basename(p).should.equal("student_interactions.log")
			path.basename(path.dirname(p)).should.equal(".cline-logs")
			STUDENT_LOG_RELATIVE.should.equal(".cline-logs/student_interactions.log")
			STUDENT_LOG_ENV.should.equal("CLINE_STUDENT_LOG")
		})

		it("把目录作为日志目标时应自动补默认文件名", () => {
			const dir = path.join(ROOT, "dir-target")
			fs.mkdirSync(dir, { recursive: true })
			const expanded = expandLogTarget(dir, ROOT)
			expanded.should.equal(defaultStudentLogPath(dir))
		})

		it("把文件作为日志目标时应原样返回绝对路径", () => {
			const dir = path.join(ROOT, "file-target")
			const file = mkLog(dir)
			expandLogTarget(file, ROOT).should.equal(file)
		})

		it("相对路径应按 cwd 展开", () => {
			const dir = path.join(ROOT, "relative")
			const file = mkLog(dir)
			expandLogTarget(STUDENT_LOG_RELATIVE, dir).should.equal(file)
		})
	})

	describe("解析链优先级", () => {
		it("1) 显式参数优先级最高，且不与 workspaceArg/env 冲突", () => {
			const explicit = mkLog(path.join(ROOT, "p1-explicit"))
			mkLog(path.join(ROOT, "p1-ws"))
			const r = resolveLogPath({
				logPathArg: explicit,
				workspaceArg: path.join(ROOT, "p1-ws"),
				envPath: mkLog(path.join(ROOT, "p1-env")),
				workspaceRoot: path.join(ROOT, "p1-root"),
				cwd: ROOT,
			})
			r.path.should.equal(explicit)
			r.source.should.equal("arg")
			r.isDefault.should.be.false()
			r.exists.should.be.true()
		})

		it("2) 无参数时命中 CLINE_STUDENT_LOG 环境变量", () => {
			const envLog = mkLog(path.join(ROOT, "p2-env"))
			const r = resolveLogPath({ envPath: envLog, cwd: path.join(ROOT, "p2-other") })
			r.path.should.equal(envLog)
			r.source.should.equal("env")
		})

		it("3) --workspace 目录命中该目录下的默认日志", () => {
			const ws = path.join(ROOT, "p3-ws")
			const file = mkLog(ws)
			const r = resolveLogPath({ workspaceArg: ws, cwd: ROOT })
			r.path.should.equal(file)
			r.source.should.equal("workspace-arg")
			r.exists.should.be.true()
		})

		it("4) 工作区根是权威信号：该工作区没有日志时不回退到父目录", () => {
			const parent = path.join(ROOT, "p4-parent")
			mkLog(parent) // 父目录有日志
			const child = path.join(parent, "child-ws")
			fs.mkdirSync(child, { recursive: true })

			const r = resolveLogPath({ workspaceRoot: child, cwd: child })
			r.source.should.equal("workspace-root")
			r.path.should.equal(defaultStudentLogPath(child))
			r.exists.should.be.false()
		})

		it("5) 当前目录命中默认日志", () => {
			const ws = path.join(ROOT, "p5-cwd")
			const file = mkLog(ws)
			const r = resolveLogPath({ cwd: ws })
			r.path.should.equal(file)
			r.source.should.equal("cwd")
		})

		it("6) 子目录中运行时应向上回溯到工作区根", () => {
			const ws = path.join(ROOT, "p6-ws")
			const file = mkLog(ws)
			const deep = path.join(ws, "src", "pkg", "mod")
			fs.mkdirSync(deep, { recursive: true })

			const r = resolveLogPath({ cwd: deep })
			r.path.should.equal(file)
			r.source.should.equal("cwd-ancestor")
		})

		it("6b) walkUpDepth=0 时禁止回溯", () => {
			const ws = path.join(ROOT, "p6b-ws")
			mkLog(ws)
			const deep = path.join(ws, "src")
			fs.mkdirSync(deep, { recursive: true })

			const r = resolveLogPath({ cwd: deep, walkUpDepth: 0 })
			r.exists.should.be.false()
			r.source.should.equal("cwd")
			r.candidates.length.should.equal(1)
		})

		it("任何一级都找不到时 exists=false 并给出候选清单", () => {
			const empty = path.join(ROOT, "p7-empty")
			fs.mkdirSync(empty, { recursive: true })
			const r = resolveLogPath({ cwd: empty, walkUpDepth: 0 })
			r.exists.should.be.false()
			r.isDefault.should.be.true()
			r.candidates.length.should.be.above(0)
			r.candidates[0].should.equal(defaultStudentLogPath(empty))
		})

		it("显式指定的文件不存在时不偷偷回退（避免分析错对象）", () => {
			const missing = path.join(ROOT, "p8-missing", "student_interactions.log")
			const r = resolveLogPath({ logPathArg: missing, cwd: ROOT })
			r.exists.should.be.false()
			r.source.should.equal("arg")
			r.path.should.equal(missing)
		})
	})

	describe("向上回溯工具函数", () => {
		it("最多只向上找 maxDepth 层", () => {
			const ws = path.join(ROOT, "p9-ws")
			mkLog(ws)
			const deep = path.join(ws, "a", "b", "c", "d", "e")
			fs.mkdirSync(deep, { recursive: true })

			;(findStudentLogByWalkingUp(deep, 2) === null).should.be.true()
			;(findStudentLogByWalkingUp(deep, 8) as string).should.equal(defaultStudentLogPath(ws))
		})

		it("describeLogSource 对每一级都有中文说明", () => {
			for (const s of ["arg", "env", "workspace-arg", "workspace-root", "cwd", "cwd-ancestor"] as const) {
				describeLogSource(s).length.should.be.above(1)
			}
		})
	})
})
