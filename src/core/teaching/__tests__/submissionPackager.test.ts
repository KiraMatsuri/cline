/**
 * SubmissionPackager 单测：纯函数部分（不碰真实工作区）
 *
 * 运行：
 *   $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'
 *   npx mocha --require ts-node/register --require tsconfig-paths/register --grep "提交包"
 */
import "should"
import { BUNDLE_SCHEMA } from "../submission/bundleTypes"
import {
	buildBundleMeta,
	countLines,
	looksBinary,
	postBundle,
	sha256Of,
	summarizeLogEvents,
} from "../submission/SubmissionPackager"

describe("SubmissionPackager（需求 1/2：提交包收集）", () => {
	describe("countLines", () => {
		it("空 buffer 为 0 行", () => {
			countLines(Buffer.from("")).should.equal(0)
		})

		it("无结尾换行时按行数算", () => {
			countLines(Buffer.from("a\nb\nc")).should.equal(3)
		})

		it("有结尾换行时不额外多算一行", () => {
			countLines(Buffer.from("a\nb\nc\n")).should.equal(3)
		})
	})

	describe("looksBinary", () => {
		it("文本判定为非二进制", () => {
			looksBinary(Buffer.from("print('hi')\n")).should.be.false()
		})

		it("含 NUL 字节判定为二进制", () => {
			looksBinary(Buffer.from([0x50, 0x4b, 0x00, 0x01])).should.be.true()
		})
	})

	describe("sha256Of", () => {
		it("空内容哈希稳定", () => {
			sha256Of(Buffer.from("")).should.equal("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
		})
	})

	describe("summarizeLogEvents", () => {
		it("空日志返回全 0", () => {
			const summary = summarizeLogEvents(null)
			summary.total.should.equal(0)
			summary.assistant.should.equal(0)
			summary.codeEdit.should.equal(0)
		})

		it("统计 assistant / code_generation / code_edit，坏行不计入", () => {
			const log = [
				JSON.stringify({ role: "user" }),
				JSON.stringify({ role: "assistant" }),
				JSON.stringify({ category: "code_generation" }),
				JSON.stringify({ eventType: "code_edit" }),
				JSON.stringify({ category: "refactoring" }),
				"not-json-line",
				"",
				JSON.stringify({ role: "user" }),
			].join("\n")
			const summary = summarizeLogEvents(Buffer.from(log))
			summary.total.should.equal(6)
			summary.assistant.should.equal(2)
			summary.codeEdit.should.equal(2)
		})
	})

	describe("buildBundleMeta", () => {
		it("补齐 schema 与时间戳，必填字段原样带入", () => {
			const meta = buildBundleMeta({
				assignmentId: "hw1",
				studentId: "2023001",
				studentName: "张三",
				classId: "1 班",
			})
			meta.schema.should.equal(BUNDLE_SCHEMA)
			meta.assignment_id.should.equal("hw1")
			meta.student_id.should.equal("2023001")
			meta.submitted_at.length.should.be.above(10)
		})

		it("空数组/未提供字段不写入 meta（避免服务端收到空 questions）", () => {
			const meta = buildBundleMeta({
				assignmentId: "hw1",
				studentId: "2023001",
				studentName: "张三",
				classId: "1 班",
				questions: [],
				answers: [],
				runTraces: [],
			})
			;(meta.questions === undefined).should.be.true()
			;(meta.answers === undefined).should.be.true()
			;(meta.run_traces === undefined).should.be.true()
		})
	})

	describe("postBundle", () => {
		it("拼出 multipart 请求：meta 为 JSON 文本，log/code 为文件，路径放在 code_path_i", async () => {
			let capturedUrl = ""
			let capturedInit: RequestInit | undefined
			const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
				capturedUrl = String(url)
				capturedInit = init
				return new Response(JSON.stringify({ ok: true, submission_id: 1, revision: 1 }), {
					status: 201,
					headers: { "Content-Type": "application/json" },
				})
			}) as unknown as typeof fetch

			const result = await postBundle({
				apiBase: "http://localhost:4001/",
				meta: buildBundleMeta({ assignmentId: "hw1", studentId: "s1", studentName: "张三", classId: "1 班" }),
				logBuffer: Buffer.from('{"role":"user"}\n'),
				codeFiles: [{ relPath: "src/main.py", buffer: Buffer.from("print(1)\n") }],
				fetchImpl: fakeFetch,
			})

			capturedUrl.should.equal("http://localhost:4001/api/v1/submissions/bundle")
			result.status.should.equal(201)
			result.ok.should.be.true()

			const form = capturedInit?.body as FormData
			form.should.be.instanceof(FormData)
			;(form.get("meta") as string).should.containEql('"assignment_id":"hw1"')
			;(form.get("code_path_0") as string).should.equal("src/main.py")
			;(form.getAll("code").length as number).should.equal(1)
			// 不能手写 Content-Type：boundary 需要由 fetch/FormData 生成
			;((capturedInit?.headers as Record<string, string> | undefined) ?? {}).should.not.have.property("Content-Type")
		})

		it("服务器返回非 JSON 时给出可读错误而不是抛异常", async () => {
			const fakeFetch = (async () =>
				new Response("<html>502 Bad Gateway</html>", { status: 502 })) as unknown as typeof fetch
			const result = await postBundle({
				apiBase: "http://localhost:4001",
				meta: buildBundleMeta({ assignmentId: "hw1", studentId: "s1", studentName: "张三", classId: "1 班" }),
				codeFiles: [],
				fetchImpl: fakeFetch,
			})
			result.ok.should.be.false()
			result.status.should.equal(502)
			;(result.body as { code?: string }).code!.should.equal("BAD_RESPONSE")
		})
	})
})
