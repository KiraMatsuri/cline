/**
 * 【P6/T1】记账去重键（纯函数）。
 *
 * 键 = `taskId : 学生请求数 : 种类`。
 * ⚠️ **不得**含 `apiRequestCount`：阻断回合会被 Cline 记 mistake 并重试（实测 3 次/条消息），
 * 每次重试都让该值 +1 ⇒ 键每次都不同 ⇒ 同一条学生消息落 3 对 D/T（M9' ① 因此失真）。
 * “学生请求数”在重试期间不变 ⇒ 天然幂等；学生又发消息时它才变 ⇒ 仍会正常记一条。
 *
 * 【P6/T9 fix】`kind = "compliance"`（b+c 服从流程）额外带上 `decision`（由调用方拼接，见
 * `index.ts` 的 `persistDemandComplianceEvent`）：`asked` 与其后的 `granted`/`denied` 同属一个学生请求，
 * 共用一把键会把后者的记录一并吞掉。
 */
export function buildInterventionAccountKey(
	taskId: string,
	studentRequests: number,
	kind: "decision" | "copy" | "compliance",
): string {
	return `${taskId}:${studentRequests}:${kind}`
}
