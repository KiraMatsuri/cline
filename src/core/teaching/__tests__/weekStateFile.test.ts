import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { expect } from "chai"
import { readWeekState, WEEK_STATE_FILE_NAME, writeWeekState } from "../weekStateFile"

describe("F7 · 周数状态文件（纯 fs）", () => {
	let dir: string
	let file: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "weekstate-"))
		file = path.join(dir, WEEK_STATE_FILE_NAME)
	})
	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	it("★ 写后读回同一周数", async () => {
		expect(await writeWeekState(file, 18)).to.equal(true)
		expect(await readWeekState(file)).to.equal(18)
	})

	it("★ 文件缺失 → null（调用方回退 --week，不抛错）", async () => {
		expect(await readWeekState(file)).to.equal(null)
	})

	it("★ JSON 损坏 → null", async () => {
		await fs.writeFile(file, "{ not json", "utf-8")
		expect(await readWeekState(file)).to.equal(null)
	})

	it("★ 越界/非法 week → null（1..18 之外一律拒绝）", async () => {
		for (const bad of [0, 19, -1, 2.5, "x"]) {
			await fs.writeFile(file, JSON.stringify({ week: bad, updatedAt: "t" }), "utf-8")
			expect(await readWeekState(file), `week=${String(bad)} 应被拒绝`).to.equal(null)
		}
	})

	it("★ 写入不存在的目录 → 返回 false，不抛错", async () => {
		expect(await writeWeekState(path.join(dir, "no-such-dir", "x.json"), 5)).to.equal(false)
	})
})
