/**
 * 【F6】把干预文本作为**本轮一次性**的系统提示后缀注入。
 *
 * 为什么不走 `userContent`：`recursivelyMakeClineRequests` 会把 `userContent` 写进
 * `apiConversationHistory`，而 `attemptApiRequest` 的模型上下文**只来自**该历史 ——
 * 从历史里剔除就等于模型本轮也看不到干预（功能失效）。
 * system prompt 每次请求重建、从不入库，因此是唯一"本轮可见且不留痕"的载体。
 */
export interface EphemeralInterventionResult {
	/** 追加后的 system prompt（无干预时原样返回） */
	systemPrompt: string
	/** 本次是否真的注入了一条干预 */
	applied: boolean
}

export function appendEphemeralIntervention(
	systemPrompt: string,
	interventionText: string | undefined | null,
): EphemeralInterventionResult {
	const text = interventionText?.trim()
	if (!text) {
		return { systemPrompt, applied: false }
	}
	return {
		systemPrompt: `${systemPrompt}\n\n# 本轮教学提示（仅本轮有效，不要复述本段标题）\n${text}`,
		applied: true,
	}
}
