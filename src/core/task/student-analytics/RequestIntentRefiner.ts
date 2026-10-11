/**
 * 学生意图细化器（方案 C-3）
 *
 * 需求：若学生在**已经拿到关键实现部分之后**仍然索要完整代码，则该提问不再算"概念问答"，
 * 而是货真价实的 `code_generation` —— 于是规则分流（方案 C-1）会让代码类干预重新生效。
 *
 * 这是"概念模式不给完整代码"（方案 C-2）的**配套反馈回路**：
 * 只靠提示词约束模型是不够的（提示词不是强制），但如果学生持续索取，
 * 我们至少要承认"这已经是一次代码生成请求"，不能再用 explanation 的宽松策略对待。
 */

import type { TaskCategory } from "./types"

/** 会被翻转的"概念类"起点 */
const CONCEPTUAL_BASES: ReadonlySet<TaskCategory> = new Set<TaskCategory>(["explanation", "algorithm"])

/**
 * "索要完整实现"的显式标记。
 * 刻意只收"完整性要求"，不收普通的"怎么写" —— 后者是正常的概念提问。
 */
const COMPLETENESS_MARKERS: readonly RegExp[] = [
	/完整(的)?[^，。！？\s]{0,8}(代码|实现|程序|版本|算法|函数)/,
	/(全部|整套|整个)(的)?(代码|实现|程序|逻辑)/,
	/(可运行|能跑|能运行|可以直接跑|跑得起来)(的)?/,
	/(直接|干脆)(给我|发我|贴)(一份|个|代码|实现)/,
	/(把|将)(代码|实现)(都|全)?(给|发|贴)(我|过来)/,
	/不要(解释|废话|讲原理)/,
]

/**
 * 细化学生的提问分类。
 *
 * @param text 学生原始提问
 * @param base `TaskClassifier.classify()` 的原始结果
 * @param hasDeliveredKeyCode 本轮之前，助手是否已经给过关键实现（fenced 代码块）
 *
 * 翻转条件（三者同时满足）：
 *   1. 原始分类属于概念类（explanation / algorithm）；
 *   2. 已经给过关键实现 —— 否则学生会"还没看到东西就被当成要代码"；
 *   3. 提问里出现显式的"完整性要求"标记。
 */
export function refineStudentCategory(text: string, base: TaskCategory, hasDeliveredKeyCode: boolean): TaskCategory {
	if (!CONCEPTUAL_BASES.has(base) || !hasDeliveredKeyCode) {
		return base
	}
	const normalized = (text ?? "").trim()
	if (!normalized) {
		return base
	}
	const wantsComplete = COMPLETENESS_MARKERS.some((re) => re.test(normalized))
	return wantsComplete ? "code_generation" : base
}
