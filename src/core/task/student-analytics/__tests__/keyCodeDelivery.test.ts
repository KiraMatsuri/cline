import { expect } from "chai"
import { FILE_WRITING_TOOLS, nextHasDeliveredKeyCode } from "../keyCodeDelivery"

describe("F10 · hasDeliveredKeyCode 兼容工具落盘", () => {
	it("① 只落盘、正文无代码块 → 置位", () => {
		expect(nextHasDeliveredKeyCode(false, false, ["write_to_file"])).to.equal(true)
	})

	it("② 只读文件（read_file）→ 不得置位（原值 false 保持 false）", () => {
		expect(nextHasDeliveredKeyCode(false, false, ["read_file"])).to.equal(false)
		expect(nextHasDeliveredKeyCode(false, false, ["read_file", "list_files", "search_files"])).to.equal(false)
	})

	it("③ 单调：已为 true 后（无块、无写文件工具）不回落", () => {
		expect(nextHasDeliveredKeyCode(true, false, [])).to.equal(true)
		expect(nextHasDeliveredKeyCode(true, false, ["read_file"])).to.equal(true)
	})

	it("④ 回归：正文含 fenced 代码块（旧路径）→ 仍置位", () => {
		// 改造不得削弱旧行为：正文含代码块原本就会武装方案 C-3。
		expect(nextHasDeliveredKeyCode(false, true, [])).to.equal(true)
	})

	it("⑤ 三个写文件工具（write_to_file / replace_in_file / apply_patch）各自单独出现即置位", () => {
		expect(nextHasDeliveredKeyCode(false, false, ["write_to_file"])).to.equal(true)
		expect(nextHasDeliveredKeyCode(false, false, ["replace_in_file"])).to.equal(true)
		expect(nextHasDeliveredKeyCode(false, false, ["apply_patch"])).to.equal(true)
	})

	it("⑥ 反例：显式核对集合内容 —— 不得包含 apply_diff / insert_content", () => {
		// 这两个名字只存在于文档里（本仓库 0 命中）。显式断言集合内容，防止日后有人
		// "按文档补齐"而引入永不匹配的死成员。
		expect(FILE_WRITING_TOOLS.size).to.equal(3)
		expect([...FILE_WRITING_TOOLS].sort()).to.deep.equal(["apply_patch", "replace_in_file", "write_to_file"])
		expect(FILE_WRITING_TOOLS.has("apply_diff")).to.equal(false)
		expect(FILE_WRITING_TOOLS.has("insert_content")).to.equal(false)
	})
})
