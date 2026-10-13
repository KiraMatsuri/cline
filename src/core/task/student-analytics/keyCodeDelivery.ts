import { ClineDefaultTool } from "@/shared/tools"

/**
 * 【F10】会被判为"AI 已交付关键实现"的**写文件**工具。
 *
 * 为什么需要它：方案 C-3 的意图翻转（`refineStudentCategory`）原先只在**正文含 fenced 代码块**时武装，
 * 但真实工作流里 AI 是**用工具落盘**的（代码在工具参数里，不在正文）⇒ `hasCodeBlock` 为 false，
 * 方案 C-3 在真实场景下**从未被武装**。
 *
 * ⚠️ 成员取自 `ClineDefaultTool`（`src/shared/tools.ts`）的**真实枚举值**：
 * `apply_diff` / `insert_content` 在本仓库**不存在**，不得加入（会引入永不匹配的死成员）。
 * `new_rule` 不加入：它写的是规则文件，不是学生的代码。
 */
export const FILE_WRITING_TOOLS: ReadonlySet<string> = new Set<string>([
	ClineDefaultTool.FILE_NEW, // write_to_file
	ClineDefaultTool.FILE_EDIT, // replace_in_file
	ClineDefaultTool.APPLY_PATCH, // apply_patch
])

/**
 * 【F10】本轮结束后 `hasDeliveredKeyCode` 的取值。
 *
 * 边界（G3 断言 ⑤ 逐条覆盖）：
 * ① 只落盘、正文无代码块 → `true`
 * ② 只读文件（`read_file`）→ 保持原值（**不得**置位）
 * ③ 单任务内**单调**：一旦 `true` 不回落（与改造前一致）
 */
export function nextHasDeliveredKeyCode(previous: boolean, hasCodeBlock: boolean, toolsUsed: readonly string[]): boolean {
	if (previous) {
		return true
	}
	if (hasCodeBlock) {
		return true
	}
	return toolsUsed.some((t) => FILE_WRITING_TOOLS.has(t))
}
