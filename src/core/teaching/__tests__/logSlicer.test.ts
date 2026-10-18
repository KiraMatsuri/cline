/**
 * logSlicer 单测（P2-1 / BN-04、BN-05、BN-06）
 *
 * 覆盖：
 *  - BN-04 全坏行：原样上传，bad_lines 精确计数（教学端要据此提示"日志解析失败"）
 *  - BN-05 超大日志：裁剪到 ≤ 2 MB 且保留尾部（最近行为最有用）
 *  - BN-06 找不到 task_id：保留 run_result + 最近 200 行，并置 slice_missing
 *  - 正常小日志：不裁剪、不降级
 *  - CRLF 归一 与 countLogLines 计数
 */

import "should"
import {
	countLogLines,
	LOG_HEAD_LINES,
	LOG_TAIL_LINES,
	MAX_LOG_UPLOAD_BYTES,
	SLICE_MISSING_TAIL_LINES,
	sliceLogForUpload,
} from "../submission/logSlicer"

function event(taskId: string, index: number, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ ts: `2026-10-01T00:00:${String(index % 60).padStart(2, "0")}Z`, taskId, index, ...extra })
}

describe("logSlicer（需求 2：上传前的日志裁剪与降级）", () => {
	it("正常小日志：原样返回，不做任何降级", () => {
		const text = [event("task-a", 1), event("task-a", 2)].join("\n") + "\n"
		const sliced = sliceLogForUpload(text, { taskId: "task-a" })
		sliced.text.should.equal(text)
		sliced.lineCount.should.equal(2)
		sliced.truncated.should.be.false()
		sliced.sliceMissing.should.be.false()
		sliced.validLines.should.equal(2)
		sliced.badLines.should.equal(0)
	})

	it("BN-04 全是坏行：原样上传并统计坏行数（不能因为解析不了就丢内容）", () => {
		const text = "not json\n{broken\n\nstill broken\n"
		const sliced = sliceLogForUpload(text, { taskId: "task-a" })
		sliced.text.should.equal(text)
		sliced.badLines.should.equal(3) // 空行不算坏行
		sliced.validLines.should.equal(0)
		sliced.lineCount.should.equal(3)
	})

	it("BN-05 超大日志：裁剪到上限内，且保留最后一行（最近行为优先）", () => {
		const lines: string[] = []
		const payload = "x".repeat(500)
		for (let i = 0; i < 6000; i++) lines.push(event("task-big", i, { note: payload }))
		const text = lines.join("\n") + "\n"
		;(Buffer.byteLength(text, "utf8") > MAX_LOG_UPLOAD_BYTES).should.be.true()

		const sliced = sliceLogForUpload(text, { taskId: "task-big" })
		;(Buffer.byteLength(sliced.text, "utf8") <= MAX_LOG_UPLOAD_BYTES).should.be.true()
		sliced.truncated.should.be.true()
		sliced.text.should.containEql(event("task-big", 5999, { note: payload }))
		sliced.originalLineCount.should.equal(6000)
		;(sliced.lineCount <= LOG_HEAD_LINES + LOG_TAIL_LINES).should.be.true()
	})

	it("BN-06 日志里没有本次 task_id：保留 run_result + 最近 200 行并标记 slice_missing", () => {
		const lines: string[] = []
		for (let i = 0; i < 500; i++) lines.push(event("task-old", i))
		lines.splice(10, 0, JSON.stringify({ eventType: "run_result", taskId: "task-old", stderr: "KeyError: x" }))
		const text = lines.join("\n") + "\n"

		const sliced = sliceLogForUpload(text, { taskId: "task-new" })
		sliced.sliceMissing.should.be.true()
		sliced.truncated.should.be.true()
		sliced.text.should.containEql("KeyError")
		;(sliced.lineCount <= SLICE_MISSING_TAIL_LINES + 1).should.be.true()
	})

	it("没给 taskId 时不判定 slice_missing（只做体积裁剪）", () => {
		const text = [event("any", 1), event("any", 2)].join("\n") + "\n"
		const sliced = sliceLogForUpload(text, {})
		sliced.sliceMissing.should.be.false()
		sliced.truncated.should.be.false()
	})

	it("CRLF 归一为 LF，不影响行数统计", () => {
		const text = `${event("t", 1)}\r\n${event("t", 2)}\r\n`
		const sliced = sliceLogForUpload(text, { taskId: "t" })
		sliced.text.should.not.containEql("\r")
		sliced.lineCount.should.equal(2)
	})

	it("maxBytes 很小时也不产生半行 JSON", () => {
		const lines = Array.from({ length: 50 }, (_, i) => event("t", i, { note: "y".repeat(200) }))
		const sliced = sliceLogForUpload(lines.join("\n"), { taskId: "t", maxBytes: 4096 })
		;(Buffer.byteLength(sliced.text, "utf8") <= 4096).should.be.true()
		for (const line of sliced.text.split("\n")) {
			if (!line) continue
			should.doesNotThrow(() => JSON.parse(line))
		}
	})

	it("countLogLines 统计总数/有效/坏行", () => {
		const text = `${event("t", 1)}\nbroken\n\n${event("t", 2)}`
		const counts = countLogLines(text)
		counts.total.should.equal(3)
		counts.valid.should.equal(2)
		counts.bad.should.equal(1)
	})
})
