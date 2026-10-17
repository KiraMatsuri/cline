/**
 * 【P6/T8】"记录其询问类型"的落地形式：日志新增两个可选字段。
 * ⚠️ `student_interactions.log` 的字段是**外部契约**（教师端看板消费）⇒ 只新增，不改既有字段语义。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { expect } from "chai"
import { dependencyWeightForQueryType, toQueryType } from "../queryType"

const typesSrc = fs.readFileSync(path.join(__dirname, "..", "types.ts"), "utf-8")
const taskSrc = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf-8")

describe("【P6/T8】询问类型字段", () => {
	it("★ 类型定义存在且为可选（向后兼容旧 JSONL）", () => {
		expect(typesSrc).to.include("queryType?: QueryType")
		expect(typesSrc).to.include("dependencyWeight?: number")
	})

	it("★ 两处日志组装都写入该字段", () => {
		const queryTypeOccurrences = taskSrc.split("queryType: toQueryType(category)").length - 1
		expect(queryTypeOccurrences, "startTask 与 turn-level 两处都要写").to.equal(2)
		// 【交接复查】两处组装点必须**成对**写 `dependencyWeight`，且取值来自纯函数（不得各自硬编码、
		// 不得把询问类型钉成字面量 —— 否则权重与 queryType 会各自飘逸）
		const weightOccurrences =
			taskSrc.split("dependencyWeight: dependencyWeightForQueryType(toQueryType(category))").length - 1
		expect(weightOccurrences, "startTask 与 turn-level 两处都要写派生快照").to.equal(2)
		// 硬编码权重一份也不允许（两种写法都钉）
		expect(taskSrc).to.not.include("dependencyWeight: 0.5")
		expect(taskSrc).to.not.include("dependencyWeight: 1")
		// 也不允许出现第三个装配点（总数 = 2 ⇒ 没有遗漏的日志构造器）
		expect(taskSrc.split("dependencyWeight:").length - 1, "只应有 startTask 与 turn-level 两个装配点").to.equal(2)
	})

	it("★ 权重与类型一致（纯函数回归）", () => {
		expect(dependencyWeightForQueryType(toQueryType("algorithm"))).to.equal(0.5)
	})
})
