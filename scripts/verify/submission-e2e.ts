/**
 * =============================================================================
 *  submission-e2e.ts —— 扩展侧 → 教学端 全链路端到端冒烟（P0-9）
 * =============================================================================
 *
 * 【为什么需要这个脚本】
 *   `teaching-server/scripts/smoke-bundle.mjs` 验证的是"服务端收包正确"，
 *   它自己拼了 FormData。但真正会出问题的地方是**扩展侧的打包器**：
 *   分区名写错、code_path_i 与 code 顺序错位、日志没读到、思考题答案没带上……
 *   这些都不会被任何一端的 tsc / 单测发现，只有把扩展侧的真实实现
 *   （SubmissionPackager + thinkingQuestions）打出来的包灌进真实服务端才知道。
 *
 * 【覆盖】
 *   1) 工作区扫描：node_modules/.venv 被跳过、非文本文件被 omitted、md/py 都被收
 *   2) 日志读取：行数 / sha256 / 原始路径
 *   3) 运行痕迹：.cline-logs/run_traces.jsonl
 *   4) 出题：题数 ∈ [3,5]、seq 连续、答案随 meta 上行
 *   5) 入库：201 / revision=1 / metrics 与事件一致 / 坏行计入 parse_errors
 *   6) 报告：revision / 题目与答案回读 / 文件名去掉 NN__ 前缀 / 下载 sha256 一致
 *   7) 幂等：同一 idempotency_key 重放 → deduplicated、submission_id 不变
 *   8) 二次提交：revision=2，报告只回最新一版，filters 只计 current
 *   9) 边界：无日志目录（BN-01）、无代码文件（BN-09）仍能入库
 *  10) 参数校验：缺学生/缺任务 → 400/404
 *
 * 【运行】（需先起教学服务，端口默认 4013）
 *   $env:DATA_DIR='D:\web-dashboard\teaching-server\.tmp-e2e-data'
 *   $env:PORT='4013'
 *   cd D:\web-dashboard\teaching-server; npx tsx src/server.ts
 *   # 另一个终端：
 *   cd D:\web-dashboard\teaching-server; npx tsx D:\cline\scripts\verify\submission-e2e.ts
 *
 * 【环境变量】E2E_BASE_URL（默认 http://127.0.0.1:4013）
 *   注：本脚本按绝对路径 import D:\cline 下的扩展侧实现（它是本地联调闸门，不进 CI），
 *       因此仓库根目录固定为 D:\cline。
 * 【退出码】0 全部通过；1 有断言失败
 * =============================================================================
 */

import {
	buildBundleMeta,
	collectCodeFiles,
	collectLog,
	countLines,
	postBundle,
	readRunTraces,
	sha256Of,
	summarizeLogEvents,
} from "D:/cline/src/core/teaching/submission/SubmissionPackager.ts"
import { buildTemplateQuestions, countForQuestions } from "D:/cline/src/core/teaching/submission/thinkingQuestions.ts"
import * as assert from "node:assert/strict"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

const BASE_URL = (process.env.E2E_BASE_URL || "http://127.0.0.1:4013").replace(/\/+$/, "")
const WORK_ROOT = "D:\\cline\\.tmp-e2e"
const WORKSPACE = path.join(WORK_ROOT, "workspace")

// ---------------------------------------------------------------------------
//  断言收集
// ---------------------------------------------------------------------------

let passed = 0
const failures: string[] = []

function check(title: string, fn: () => void | Promise<void>): Promise<void> | void {
	const run = async () => {
		try {
			await fn()
			passed++
			console.log(`[OK  ] ${title}`)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			failures.push(`${title} :: ${message}`)
			console.log(`[FAIL] ${title} :: ${message}`)
		}
	}
	return run()
}

function rmtree(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true })
	} catch {
		// 忽略
	}
}

function writeFile(absPath: string, content: string | Buffer): void {
	fs.mkdirSync(path.dirname(absPath), { recursive: true })
	fs.writeFileSync(absPath, content)
}

function hashOfFile(absPath: string): string {
	return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex")
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
	const response = await fetch(url)
	let body: any = null
	try {
		body = await response.json()
	} catch {
		body = null
	}
	return { status: response.status, body }
}

async function waitForServer(): Promise<void> {
	for (let i = 0; i < 60; i++) {
		try {
			const response = await fetch(`${BASE_URL}/api/health`)
			if (response.ok) return
		} catch {
			// 服务还没起来
		}
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	throw new Error(`教学服务未在 ${BASE_URL} 启动（请先 npx tsx src/server.ts）`)
}

// ---------------------------------------------------------------------------
//  样例数据
// ---------------------------------------------------------------------------

const ASSIGNMENT_ID = `e2e_task_${Date.now().toString(36)}`
const STUDENT = { id: "20231011", name: "端到端测试生", classId: "人工智能2023" }

const LOG_EVENTS = [
	{ ts: "2026-10-18T10:00:00.000Z", taskId: "t-1", role: "user", eventType: "prompt", content: "帮我写一个排序" },
	{ ts: "2026-10-18T10:00:05.000Z", taskId: "t-1", role: "assistant", category: "code_generation", content: "好的" },
	{ ts: "2026-10-18T10:00:09.000Z", taskId: "t-1", eventType: "code_edit", category: "refactoring", content: "改了两行" },
	{ ts: "2026-10-18T10:00:12.000Z", taskId: "t-1", eventType: "adoption", content: "采纳" },
	{ ts: "2026-10-18T10:00:20.000Z", taskId: "t-1", role: "assistant", category: "code_generation", content: "再给一版" },
]

const RUN_TRACES = [
	{
		ts: "2026-10-18T10:01:00.000Z",
		command: "python main.py",
		exit_code: 1,
		stdout_tail: "IndexError: list index out of range",
		task_id: "t-1",
	},
	{
		ts: "2026-10-18T10:02:00.000Z",
		command: "python main.py",
		exit_code: 0,
		stdout_tail: "[3, 1, 2] -> [1, 2, 3]",
		task_id: "t-1",
	},
]

function buildWorkspace(): void {
	rmtree(WORK_ROOT)
	fs.mkdirSync(WORKSPACE, { recursive: true })

	writeFile(
		path.join(WORKSPACE, "main.py"),
		[
			"def bubble_sort(items):",
			"    n = len(items)",
			"    for i in range(n):",
			"        for j in range(n - i - 1):",
			"            if items[j] > items[j + 1]:",
			"                items[j], items[j + 1] = items[j + 1], items[j]",
			"    return items",
			"",
			"print(bubble_sort([3, 1, 2]))",
			"",
		].join("\n"),
	)
	writeFile(
		path.join(WORKSPACE, "utils", "helper.py"),
		["def swap(seq, i, j):", "    seq[i], seq[j] = seq[j], seq[i]", ""].join("\n"),
	)
	writeFile(path.join(WORKSPACE, "README.md"), "# 冒泡排序实验\n\n本实验比较相邻元素并交换。\n")
	// 必须被跳过：依赖目录 / 虚拟环境 / 二进制资源
	writeFile(path.join(WORKSPACE, "node_modules", "lib", "index.js"), "module.exports = 1;\n")
	writeFile(path.join(WORKSPACE, ".venv", "lib.py"), "x = 1\n")
	writeFile(path.join(WORKSPACE, "assets", "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))

	const logPath = path.join(WORKSPACE, ".cline-logs", "student_interactions.log")
	const logText = `${LOG_EVENTS.map((event) => JSON.stringify(event)).join("\n")}\n{ this is a broken line\n`
	writeFile(logPath, logText)
	writeFile(
		path.join(WORKSPACE, ".cline-logs", "run_traces.jsonl"),
		`${RUN_TRACES.map((trace) => JSON.stringify(trace)).join("\n")}\n`,
	)
}

// ---------------------------------------------------------------------------
//  主流程
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	console.log(`base url : ${BASE_URL}`)
	console.log(`workspace: ${WORKSPACE}`)
	await waitForServer()
	console.log("[OK  ] 教学服务在线\n")

	buildWorkspace()

	// -------- 0. 建任务 --------
	const assignmentForm = new FormData()
	assignmentForm.append("id", ASSIGNMENT_ID)
	assignmentForm.append("title", "冒泡排序（E2E）")
	assignmentForm.append("week", "6")
	assignmentForm.append("description", "实现冒泡排序并处理空列表边界；要求自己写测试用例验证。")
	assignmentForm.append("template_code", "def bubble_sort(items):\n    pass\n")
	const createResponse = await fetch(`${BASE_URL}/api/v1/teacher/assignments`, {
		method: "POST",
		body: assignmentForm,
	})
	const created = await createResponse.json().catch(() => null)
	console.log(`[OK  ] 建任务 HTTP ${createResponse.status} id=${ASSIGNMENT_ID}`)
	assert.equal(createResponse.status, 201, `建任务应返回 201，实际 ${createResponse.status} ${JSON.stringify(created)}`)

	// -------- 1. 工作区扫描 --------
	const collected = collectCodeFiles({ workspaceRoot: WORKSPACE, activeFilePath: path.join(WORKSPACE, "main.py") })
	const relPaths = collected.files.map((file) => file.relPath)

	console.log("")
	await check("扫描到 3 个代码文件（main.py/helper.py/README.md）", () => {
		assert.equal(collected.files.length, 3, `实际 ${collected.files.length}: ${relPaths.join(",")}`)
	})
	await check("活动编辑器文件排在第一", () => {
		assert.equal(relPaths[0], "main.py", `实际第一个是 ${relPaths[0]}`)
	})
	await check("node_modules / .venv 被跳过", () => {
		assert.ok(!relPaths.some((p) => p.startsWith("node_modules") || p.startsWith(".venv")), `误收 ${relPaths.join(",")}`)
	})
	await check("非文本资源（png）不进包", () => {
		// 扩展侧在「扩展名白名单」这一步就把 png 挡掉了，所以它不会出现在
		// files 里，也不会出现在 omitted 里（omitted 只记「白名单内但读不了」的文件）。
		assert.ok(!relPaths.some((relPath) => relPath.endsWith(".png")), `误收 ${relPaths.join(",")}`)
		assert.ok(!collected.omitted.some((item) => item.relPath.endsWith(".png")), "png 不应进入 omitted")
	})
	await check("每个文件都有行数与 sha256 可用于校验", () => {
		for (const file of collected.files) {
			assert.ok(file.lineCount > 0, `${file.relPath} 行数为 0`)
			assert.equal(sha256Of(file.buffer), hashOfFile(file.absPath), `${file.relPath} sha256 不一致`)
		}
	})

	// -------- 2. 日志 --------
	const logPath = path.join(WORKSPACE, ".cline-logs", "student_interactions.log")
	const log = collectLog(logPath)
	console.log("")
	await check("日志被读到且行数正确（5 有效 + 1 坏行 = 6 行）", () => {
		assert.ok(log.buffer, "日志 buffer 为空")
		assert.equal(countLines(log.buffer as Buffer), 6, `实际 ${log.buffer ? countLines(log.buffer) : -1}`)
	})
	await check("日志 info 带原始路径与 sha256", () => {
		assert.ok(log.info, "log.info 为空")
		assert.equal(log.info?.original_path, logPath, `original_path=${log.info?.original_path}`)
		assert.equal(log.info?.sha256, hashOfFile(logPath), "sha256 与服务端将计算的原文不一致")
	})
	await check("事件统计：total=5 assistant=2 codeEdit=1", () => {
		const stats = summarizeLogEvents(log.buffer)
		assert.deepEqual(stats, { total: 5, assistant: 2, codeEdit: 1 }, JSON.stringify(stats))
	})

	// -------- 3. 运行痕迹 --------
	const traces = readRunTraces(WORKSPACE)
	console.log("")
	await check("读到 2 条运行痕迹（1 次失败 1 次成功）", () => {
		assert.equal(traces.length, 2, `实际 ${traces.length}`)
		assert.equal(traces[0].exit_code, 1, `第一条 exit_code=${traces[0].exit_code}`)
		assert.equal(traces[1].exit_code, 0, `第二条 exit_code=${traces[1].exit_code}`)
	})

	// -------- 4. 出题（模板题，P0 用） --------
	const stats = summarizeLogEvents(log.buffer)
	const signals = {
		codeLineCount: collected.files.reduce((sum, file) => sum + file.lineCount, 0),
		fileCount: collected.files.length,
		runCount: traces.length,
		failureCount: traces.filter((trace) => Number(trace.exit_code) !== 0).length,
		descriptionChars: 34,
		codeEditCount: stats.codeEdit,
	}
	const questionCount = countForQuestions(signals)
	const questions = buildTemplateQuestions({
		assignmentTitle: "冒泡排序（E2E）",
		assignmentId: ASSIGNMENT_ID,
		description: "实现冒泡排序并处理空列表边界；要求自己写测试用例验证。",
		signals,
	})
	console.log("")
	await check("题数在 3~5 且等于 countForQuestions 结果", () => {
		assert.ok(questionCount >= 3 && questionCount <= 5, `题数 ${questionCount} 越界`)
		assert.equal(questions.length, questionCount, `实际出题 ${questions.length}，期望 ${questionCount}`)
	})
	await check("题目 seq 连续 1..N 且都有题面", () => {
		questions.forEach((question, index) => {
			assert.equal(question.seq, index + 1, `第 ${index} 题 seq=${question.seq}`)
			assert.ok(question.question.trim().length > 5, `第 ${question.seq} 题题面过短`)
		})
	})

	const answers = questions.map((question) => ({
		seq: question.seq,
		answer: `第 ${question.seq} 题的回答：我用相邻比较把大元素逐步推到末尾，并补了空列表测试。`,
	}))

	// -------- 5. 组装 meta 并上传 --------
	const idempotencyKey = crypto.randomUUID()
	const meta = buildBundleMeta({
		assignmentId: ASSIGNMENT_ID,
		studentId: STUDENT.id,
		studentName: STUDENT.name,
		classId: STUDENT.classId,
		submittedAt: new Date().toISOString(),
		taskId: "t-1",
		questions,
		answers,
		logInfo: log.info,
		runTraces: traces,
		clientVersion: "e2e/1.0.0",
		idempotencyKey,
	})

	const upload = await postBundle({
		apiBase: BASE_URL,
		meta,
		logBuffer: log.buffer,
		logFileName: "student_interactions.log",
		codeFiles: collected.files,
	})
	const body = upload.body as any
	console.log("")
	console.log(
		`[OK  ] 首次上传 HTTP ${upload.status} -> ${JSON.stringify({ revision: body.revision, code: body.stored?.code_count })}`,
	)
	await check("首次上传返回 201 且 ok=true", () => {
		assert.equal(upload.status, 201, `HTTP ${upload.status} ${JSON.stringify(body)}`)
		assert.equal(body.ok, true, JSON.stringify(body))
	})
	await check("入库 revision=1（该学生该任务首版）", () => {
		assert.equal(body.revision, 1, `实际 ${body.revision}`)
	})
	await check("代码文件 3 个入库", () => {
		assert.equal(body.stored?.code_count, 3, `实际 ${body.stored?.code_count}`)
	})
	await check("指标与日志事件一致：ai_dependency=0.4 / user_edit_count=1 / indexed=5", () => {
		assert.equal(body.metrics?.ai_dependency, 0.4, `ai_dependency=${body.metrics?.ai_dependency}`)
		assert.equal(body.metrics?.user_edit_count, 1, `user_edit_count=${body.metrics?.user_edit_count}`)
		assert.equal(body.indexed_events, 5, `indexed_events=${body.indexed_events}`)
	})
	await check("坏行计入 parse_errors=1，且给出 warnings", () => {
		assert.equal(body.parse_errors, 1, `parse_errors=${body.parse_errors}`)
		assert.ok(Array.isArray(body.warnings) && body.warnings.length > 0, `warnings=${JSON.stringify(body.warnings)}`)
	})

	// -------- 6. 报告回读 --------
	const reportUrl = `${BASE_URL}/api/v1/reports/current?assignment_id=${encodeURIComponent(ASSIGNMENT_ID)}&student_id=${encodeURIComponent(STUDENT.id)}`
	const report = await getJson(reportUrl)
	const reportData = report.body?.report ?? report.body?.data ?? report.body
	console.log("")
	await check("报告可查（200）且只回最新一版 revision=1", () => {
		assert.equal(report.status, 200, `HTTP ${report.status} ${JSON.stringify(report.body)}`)
		assert.equal(reportData.revision, 1, `revision=${reportData.revision}`)
	})
	await check("题目与答案原样回读（含第 3 题未答留空场景不存在）", () => {
		assert.equal(reportData.questions.length, questions.length, `题目数 ${reportData.questions.length} ≠ ${questions.length}`)
		reportData.questions.forEach((question: any, index: number) => {
			assert.equal(question.question, questions[index].question, `第 ${index + 1} 题题面不一致`)
			assert.equal(question.answer, answers[index].answer, `第 ${index + 1} 题答案不一致`)
		})
	})
	await check("代码文件清单 3 个且文件名无 NN__ 前缀", () => {
		assert.equal(reportData.files.length, 3, `文件数 ${reportData.files.length}`)
		for (const file of reportData.files) {
			assert.ok(!/^\d+__/.test(file.name), `文件名仍带序号前缀: ${file.name}`)
		}
	})
	await check("下载文件内容与本地 sha256 一致", async () => {
		const target = collected.files.find((file) => file.relPath === "main.py")
		assert.ok(target, "本地未收集到 main.py")
		const fileEntry = reportData.files.find((file: any) => file.rel_path === "main.py")
		assert.ok(fileEntry, `报告中缺少 main.py，实际 ${JSON.stringify(reportData.files.map((f: any) => f.rel_path))}`)
		const download = await fetch(`${BASE_URL}${fileEntry.download_url}`)
		assert.equal(download.status, 200, `下载 HTTP ${download.status}`)
		const buffer = Buffer.from(await download.arrayBuffer())
		assert.equal(sha256Of(buffer), sha256Of((target as any).buffer), "下载内容与原文件不一致")
	})

	// -------- 7. 幂等重放 --------
	const replay = await postBundle({
		apiBase: BASE_URL,
		meta,
		logBuffer: log.buffer,
		codeFiles: collected.files,
	})
	const replayBody = replay.body as any
	console.log("")
	await check("同一 idempotency_key 重放 → deduplicated 且 submission_id 不变", () => {
		assert.equal(replay.ok, true, `HTTP ${replay.status}`)
		assert.equal(replayBody.deduplicated, true, JSON.stringify(replayBody))
		assert.equal(
			replayBody.submission_id,
			body.submission_id,
			`submission_id 变了：${replayBody.submission_id} ≠ ${body.submission_id}`,
		)
	})

	// -------- 8. 二次提交（新 id） --------
	const metaV2 = buildBundleMeta({
		assignmentId: ASSIGNMENT_ID,
		studentId: STUDENT.id,
		studentName: STUDENT.name,
		classId: STUDENT.classId,
		questions,
		answers: answers.map((answer) => ({ seq: answer.seq, answer: `${answer.answer}（第二版补充）` })),
		logInfo: log.info,
		runTraces: traces,
		idempotencyKey: crypto.randomUUID(),
	})
	const uploadV2 = await postBundle({ apiBase: BASE_URL, meta: metaV2, logBuffer: log.buffer, codeFiles: collected.files })
	const bodyV2 = uploadV2.body as any
	console.log("")
	await check("二次提交 revision=2", () => {
		assert.equal(uploadV2.status, 201, `HTTP ${uploadV2.status} ${JSON.stringify(bodyV2)}`)
		assert.equal(bodyV2.revision, 2, `revision=${bodyV2.revision}`)
	})
	const reportV2 = await getJson(reportUrl)
	const reportDataV2 = reportV2.body?.report ?? reportV2.body?.data ?? reportV2.body
	await check("报告只回最新一版（答案已变成第二版）", () => {
		assert.equal(reportDataV2.revision, 2, `revision=${reportDataV2.revision}`)
		assert.ok(String(reportDataV2.questions[0].answer).includes("第二版补充"), `答案=${reportDataV2.questions[0].answer}`)
	})
	await check("filters 对该任务只计 1 份（只算 current）", async () => {
		const filters = await getJson(`${BASE_URL}/api/v1/reports/filters`)
		assert.equal(filters.status, 200, `HTTP ${filters.status}`)
		const filterPayload = filters.body?.data ?? filters.body
		const assignment = (filterPayload?.assignments ?? []).find((item: any) => item.id === ASSIGNMENT_ID)
		assert.ok(assignment, "filters 中找不到刚建的任务")
		assert.equal(assignment.submission_count, 1, `submission_count=${assignment.submission_count}`)
	})

	// -------- 9. 边界：无日志目录 / 无代码文件 --------
	const bareWorkspace = path.join(WORK_ROOT, "bare")
	fs.mkdirSync(bareWorkspace, { recursive: true })
	writeFile(path.join(bareWorkspace, "solo.py"), "print('hello')\n")
	const bareCollected = collectCodeFiles({ workspaceRoot: bareWorkspace })
	const bareLog = collectLog(null)
	const bareUpload = await postBundle({
		apiBase: BASE_URL,
		meta: buildBundleMeta({
			assignmentId: ASSIGNMENT_ID,
			studentId: "20231012",
			studentName: "无日志学生",
			classId: STUDENT.classId,
			questions,
			answers,
			idempotencyKey: crypto.randomUUID(),
		}),
		logBuffer: bareLog.buffer,
		codeFiles: bareCollected.files,
	})
	const bareBody = bareUpload.body as any
	console.log("")
	await check("BN-01/BN-02：工作区无日志仍能提交（201 + warning）", () => {
		assert.equal(bareLog.path, null, `path=${bareLog.path}`)
		assert.equal(bareUpload.status, 201, `HTTP ${bareUpload.status} ${JSON.stringify(bareBody)}`)
		assert.equal(bareBody.stored?.code_count, 1, `code_count=${bareBody.stored?.code_count}`)
		assert.ok(
			(Array.isArray(bareBody.warnings) ? bareBody.warnings : []).some((warning: string) =>
				warning.includes("未包含行为日志"),
			),
			`warnings=${JSON.stringify(bareBody.warnings)}`,
		)
	})

	const emptyWorkspace = path.join(WORK_ROOT, "empty")
	fs.mkdirSync(path.join(emptyWorkspace, ".cline-logs"), { recursive: true })
	writeFile(path.join(emptyWorkspace, ".cline-logs", "student_interactions.log"), "")
	// 只有非文本资源：扩展名白名单全部挡掉 → 0 个代码文件（BN-09 的真实场景）
	writeFile(path.join(emptyWorkspace, "figure.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
	writeFile(path.join(emptyWorkspace, "dataset.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]))
	const emptyCollected = collectCodeFiles({ workspaceRoot: emptyWorkspace })
	const emptyUpload = await postBundle({
		apiBase: BASE_URL,
		meta: buildBundleMeta({
			assignmentId: ASSIGNMENT_ID,
			studentId: "20231013",
			studentName: "无代码学生",
			classId: STUDENT.classId,
			questions,
			answers,
			idempotencyKey: crypto.randomUUID(),
		}),
		logBuffer: null,
		codeFiles: emptyCollected.files,
	})
	const emptyBody = emptyUpload.body as any
	await check("BN-09：工作区无代码文件仍能提交（201 + code_count=0）", () => {
		assert.equal(emptyCollected.files.length, 0, `误收 ${emptyCollected.files.map((f) => f.relPath).join(",")}`)
		assert.equal(emptyUpload.status, 201, `HTTP ${emptyUpload.status} ${JSON.stringify(emptyBody)}`)
		assert.equal(emptyBody.stored?.code_count, 0, `code_count=${emptyBody.stored?.code_count}`)
	})

	// -------- 10. 参数校验 --------
	const missingStudent = await getJson(`${BASE_URL}/api/v1/reports/current?assignment_id=${encodeURIComponent(ASSIGNMENT_ID)}`)
	const unknownStudent = await getJson(
		`${BASE_URL}/api/v1/reports/current?assignment_id=${encodeURIComponent(ASSIGNMENT_ID)}&student_id=20999999`,
	)
	console.log("")
	await check("BN-13：缺学生参数 → 400", () => {
		assert.equal(missingStudent.status, 400, `HTTP ${missingStudent.status} ${JSON.stringify(missingStudent.body)}`)
	})
	await check("查无此人 → 404", () => {
		assert.equal(unknownStudent.status, 404, `HTTP ${unknownStudent.status} ${JSON.stringify(unknownStudent.body)}`)
	})

	// -------- 汇总 --------
	console.log("")
	console.log(`TOTAL=${passed + failures.length} PASS=${passed} FAIL=${failures.length}`)
	if (failures.length > 0) {
		console.log("")
		console.log("失败项：")
		for (const failure of failures) console.log(`  - ${failure}`)
		return 1
	}
	console.log("扩展侧 → 教学端 全链路通过。")
	return 0
}

main()
	.then((code) => {
		try {
			rmtree(WORK_ROOT)
		} catch {
			// 忽略清理失败
		}
		process.exitCode = code
	})
	.catch((error) => {
		console.error("[FATAL]", error)
		process.exitCode = 1
	})
