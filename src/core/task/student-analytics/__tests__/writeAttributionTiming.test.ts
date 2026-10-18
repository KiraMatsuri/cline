/**
 * 【P8/T2】写盘归属的时序守卫（变更探测器）。
 *
 * 为什么需要它：`diffViewProvider` 可能在 `saveChanges()` **之前**就把内容落到真实文件，
 * 而 `markFileAsEditedByCline()` 原先只有 `saveChanges()` 前那一次 ⇒ 变更事件的 2s 防抖 flush
 * 落在 mark 之前，整次 AI 写盘被判成「学生动手」，`ai_coding_rounds` 随清零
 * （2026-10-18 实测：4 次写盘只沉淀出 2 次计数，阻断永不触发）。
 *
 * ⚠️ 诚实声明：这是**源码结构守卫**，不是端到端验证 —— `diffViewProvider` 依赖 vscode 实例，
 * 无法在单测里驱动。实机行为以 M20' 人工核对日志为准。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"

// 用 cwd（npm script 的根）解析：本文件在某些 loader 形态下以 ESM 加载，`__dirname` 不可用。
const writeSrc = fs.readFileSync(path.resolve(process.cwd(), "src/core/task/tools/handlers/WriteToFileToolHandler.ts"), "utf-8")

describe("【P8/T2】write_to_file 的归属标记时机", () => {
	it("★ mark 出现在每一个真实写盘分支的 `diffViewProvider.open(` 之后", () => {
		// open() 共 3 处：handlePartialBlock、execute、以及 validateAndPrepareFileOperation 的 diff 错误兜底
		//（最后一处不写盘，不要求 mark）
		let index = writeSrc.indexOf("diffViewProvider.open(")
		let opens = 0
		let withMark = 0
		while (index >= 0) {
			opens++
			if (writeSrc.slice(index, index + 800).includes("markFileAsEditedByCline(")) {
				withMark++
			}
			index = writeSrc.indexOf("diffViewProvider.open(", index + 1)
		}
		expect(opens, "open() 的调用点数量变了？同步更新本断言").to.be.greaterThan(1)
		expect(withMark, "两个真实写盘分支（handlePartialBlock / execute）都必须在 open() 后立即 mark").to.be.greaterThan(1)
	})

	it("★ mark 传的是绝对路径（不得回退到模型给的原始路径）", () => {
		expect(writeSrc).to.not.include("markFileAsEditedByCline(relPath)")
		expect(writeSrc.match(/markFileAsEditedByCline\(absolutePath\)/g)?.length ?? 0).to.be.greaterThan(1)
	})

	it("★ `saveChanges()` 前的那次 mark 仍在（幂等，覆盖用户长时间犹豫）", () => {
		const markIdx = writeSrc.lastIndexOf("markFileAsEditedByCline(absolutePath)")
		const saveIdx = writeSrc.indexOf("diffViewProvider.saveChanges()")
		expect(saveIdx).to.be.greaterThan(0)
		expect(markIdx).to.be.greaterThan(0)
		expect(markIdx).to.be.lessThan(saveIdx)
	})
})
