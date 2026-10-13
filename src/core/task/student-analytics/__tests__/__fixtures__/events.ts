/**
 * 测试用事件构造器（DRY）
 *
 * 各 spec 文件原先各自复制同一份 `ev()`，一旦默认值分叉，断言就会在没有告警的情况下失真。
 * 这里作为唯一来源；`ev()` 用「助手代码回合」默认值（多数规则的分母/单位都基于它），
 * `editEv()` 用「code_edit」默认值。
 */

import { resolveEditRole } from "../../CodeEditTracker"
import type { StudentInteractionLog } from "../../types"

export const ev = (over: Partial<StudentInteractionLog>): StudentInteractionLog => ({
	ts: new Date().toISOString(),
	taskId: "t1",
	eventType: "turn_message",
	role: "assistant",
	category: "code_generation",
	contentLength: 0,
	hasCode: true,
	hasCodeBlock: true,
	languageHint: "python",
	imageCount: 0,
	fileCount: 0,
	turnIndex: -1,
	...over,
})

/**
 * code_edit 事件：`editor` 缺省即"按人工处理"（与生产侧的向后兼容语义一致）；code_edit 本身不携带代码块。
 * 【F11-③】`role` 由 `editor` 推导（与生产侧 `resolveEditRole` 同口径）：缺省 editor ⇒ `role: "user"`。
 */
export const editEv = (over: Partial<StudentInteractionLog>): StudentInteractionLog =>
	ev({
		eventType: "code_edit",
		category: "other",
		hasCode: false,
		hasCodeBlock: false,
		role: resolveEditRole(over.editor ?? "user"),
		...over,
	})
