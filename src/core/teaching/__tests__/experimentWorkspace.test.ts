import { expect } from "chai"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
	buildTemplateContent,
	ensureExperimentWorkspace,
	experimentDirFor,
	EXPERIMENT_ATTACHMENT_DIR,
	EXPERIMENT_GUIDE_FILE,
	EXPERIMENT_LOG_DIR,
	EXPERIMENT_LOG_FILE,
	EXPERIMENT_TASK_FILE,
	isInside,
	readExperimentTaskFile,
	sanitizeSegment,
	templateFileNameFor,
} from "../ExperimentWorkspace"

/**
 * P1-3 · 实验子工作区
 *
 * 核心不变量：**幂等且不覆盖学生的东西**。学生点两次「开始实验」、
 * 或者改完模板再点一次，目录结构都必须补齐而不是重置。
 */
describe("experimentWorkspace — 实验子工作区", () => {
	let ws = ""

	beforeEach(() => {
		ws = fs.mkdtempSync(path.join(os.tmpdir(), "exp-ws-"))
	})

	afterEach(() => {
		fs.rmSync(ws, { recursive: true, force: true })
	})

	it("★ 首次创建：模板 / GUIDE.md / attachments / .cline-logs / .teaching/task.json", () => {
		const res = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "task_week2_loop", assignmentTitle: "循环" })
		expect(res.ok).to.equal(true)
		expect(res.created).to.equal(true)
		const dir = res.dir
		expect(fs.existsSync(path.join(dir, "main.py"))).to.equal(true)
		expect(fs.existsSync(path.join(dir, EXPERIMENT_GUIDE_FILE))).to.equal(true)
		expect(fs.statSync(path.join(dir, EXPERIMENT_ATTACHMENT_DIR)).isDirectory()).to.equal(true)
		expect(fs.existsSync(path.join(dir, EXPERIMENT_LOG_DIR, EXPERIMENT_LOG_FILE))).to.equal(true)
		expect(fs.existsSync(path.join(dir, EXPERIMENT_TASK_FILE))).to.equal(true)
		expect(res.files.length).to.be.greaterThan(2)
	})

	it("★ task.json 写入了 assignmentId / mode / startedAt", () => {
		const res = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "t1" })
		const meta = readExperimentTaskFile(res.dir)
		expect(meta?.assignmentId).to.equal("t1")
		const raw = JSON.parse(fs.readFileSync(path.join(res.dir, EXPERIMENT_TASK_FILE), "utf8")) as { mode?: string }
		expect(raw.mode).to.equal("experiment")
	})

	it("★ 二次调用 created=false 且**不覆盖**学生改过的模板（核心不变量）", () => {
		const first = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "t2" })
		const template = path.join(first.dir, "main.py")
		fs.writeFileSync(template, "# 学生自己写的内容\nprint(1)\n", "utf8")
		const second = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "t2" })
		expect(second.created).to.equal(false)
		expect(fs.readFileSync(template, "utf8")).to.include("学生自己写的内容")
	})

	it("★ 只缺 GUIDE.md → 只补它（模板保持学生版本）", () => {
		const first = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "t3" })
		fs.writeFileSync(path.join(first.dir, "main.py"), "# keep me\n", "utf8")
		fs.rmSync(path.join(first.dir, EXPERIMENT_GUIDE_FILE))
		const second = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "t3", guideText: "# 新指导\n步骤一\n" })
		expect(fs.readFileSync(path.join(second.dir, EXPERIMENT_GUIDE_FILE), "utf8")).to.include("步骤一")
		expect(fs.readFileSync(path.join(second.dir, "main.py"), "utf8")).to.equal("# keep me\n")
	})

	it("★ 任务 id 含 / 与 .. → 目录名被清洗且不越界", () => {
		const res = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "../../evil/task" })
		expect(res.ok).to.equal(true)
		const root = path.join(ws, "experiments")
		expect(isInside(root, res.dir)).to.equal(true)
		expect(res.dir.includes("..")).to.equal(false)
	})

	it("★ language=java → Main.java；未知语言 → main.py", () => {
		expect(templateFileNameFor("java")).to.equal("Main.java")
		expect(templateFileNameFor("JAVA")).to.equal("Main.java")
		expect(templateFileNameFor("cobol")).to.equal("main.py")
		expect(templateFileNameFor(undefined)).to.equal("main.py")
		const res = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "t4", language: "java" })
		expect(fs.existsSync(path.join(res.dir, "Main.java"))).to.equal(true)
	})

	it("★ 有模板代码时原样写入（不覆盖教师模板）", () => {
		const res = ensureExperimentWorkspace({
			workspaceRoot: ws,
			assignmentId: "t5",
			templateCode: "def main():\n    print('hi')\n",
		})
		expect(fs.readFileSync(path.join(res.dir, "main.py"), "utf8")).to.include("print('hi')")
	})

	it("★ 无模板时代码里有 TODO 骨架（可运行但不实现题目）", () => {
		const py = buildTemplateContent({ assignmentTitle: "统计列表" })
		expect(py).to.include("TODO")
		expect(py).to.include("统计列表")
		expect(py).to.include("def main")
		expect(buildTemplateContent({ language: "java" })).to.include("public class Main")
		expect(buildTemplateContent({ language: "c" })).to.include("int main")
	})

	it("★ BN-22：experiments 同名路径是文件 → 返回 error 不抛", () => {
		fs.writeFileSync(path.join(ws, "experiments"), "not a dir", "utf8")
		const res = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "t6" })
		expect(res.ok).to.equal(false)
		expect(res.error).to.be.a("string")
	})

	it("★ BN-21：目录存在但模板为空文件 → 视为已存在，不覆盖", () => {
		const dir = experimentDirFor(ws, "t7")
		fs.mkdirSync(dir, { recursive: true })
		fs.writeFileSync(path.join(dir, "main.py"), "", "utf8")
		const res = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "t7" })
		expect(res.ok).to.equal(true)
		expect(fs.readFileSync(path.join(dir, "main.py"), "utf8")).to.equal("")
	})

	it("★ BN-23：超长任务 id 仍可用（只受文件系统长度限制，不报错）", () => {
		const longId = `t_${"x".repeat(80)}`
		const res = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: longId })
		expect(res.ok).to.equal(true)
		expect(fs.existsSync(res.dir)).to.equal(true)
	})

	it("★ sanitizeSegment 清理分隔符与首尾点号", () => {
		expect(sanitizeSegment("a/b\\c:d*e?f\"g<h>i|j")).to.equal("a_b_c_d_e_f_g_h_i_j")
		expect(sanitizeSegment("..")).to.equal("assignment")
		expect(sanitizeSegment("   ")).to.equal("assignment")
		expect(sanitizeSegment("任务 一")).to.equal("任务_一")
	})

	it("★ isInside 拦住越界路径", () => {
		expect(isInside("D:\\ws\\experiments", "D:\\ws\\experiments\\a")).to.equal(true)
		expect(isInside("D:\\ws\\experiments", "D:\\ws\\other")).to.equal(false)
	})

	it("★ GUIDE 占位说明不会冒充真实指导书", () => {
		const res = ensureExperimentWorkspace({ workspaceRoot: ws, assignmentId: "t8" })
		const guide = fs.readFileSync(path.join(res.dir, EXPERIMENT_GUIDE_FILE), "utf8")
		expect(guide).to.include("占位")
	})
})
