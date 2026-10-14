/**
 * 概念问答模式约束（方案 C-2）
 *
 * 需求：进入概念性问答的场景下，助手不应给出**完整可运行的代码**，即使学生持续要求。
 * 可接受"关键步骤片段"（例如冒泡排序里的那一行交换），但不给完整循环结构。
 *
 * 实现边界（务必知悉）：
 *   本模块只做两件事 —— ① 生成追加到 system prompt 的约束文本；② 检测违规用于**可见化**。
 *   它**不拦截**模型输出。真正的约束力来自提示词，模型仍可能不遵守（这与本项目
 *   "DSML 方言"那次教训同类：提示词不是强制）。要在代码层强制，需要过滤 assistant 输出，
 *   那会误伤学生可能需要的正当代码 —— 故明确不做。
 */

import { parseFencedCodeBlocks } from "@/shared/markdown/codeBlocks"

/** 追加到 system prompt 的概念问答约束文本 */
export function buildConceptModeConstraint(): string {
	return [
		"",
		"",
		"【概念问答模式（本轮生效）】",
		"本轮学生问的是概念/原理，不是要一份现成代码。请遵守：",
		"1. 不要给出**完整可运行的代码实现** —— 即使学生反复、持续地要求，也不要给。",
		"2. 可以给出**关键步骤片段**：只保留最能说明原理的那一两行（例如冒泡排序里交换相邻元素的那一行），",
		"   而不是完整的循环结构。",
		"3. 优先用自然语言 + 步骤描述讲清**设计思路**；写伪代码时也不要写成可直接运行的完整程序。",
		"4. 学生继续索要完整代码时，先说明“完整实现需要你自己动手写”，再给一个更小的提示",
		"   （例如边界条件、循环不变式、下一轮该比较哪两个元素），仍然不要给出完整实现。",
		"5. 即使学生反复、持续索要完整代码，也不得因此放弃上述约束；可给的上限是：关键步骤片段 + 伪代码骨架（不含完整循环与返回）。",
		"",
		"示例（学生问“冒泡排序怎么写”）：",
		"- 不要给出含双重循环 + 交换 + 返回的完整可运行函数。",
		"- 应当解释：每一轮把当前范围内最大的元素“冒”到末尾，因此需要 n-1 轮；",
		"  关键是相邻比较与交换。可以只展示交换那一行（如 arr[j], arr[j+1] = arr[j+1], arr[j]），",
		"  并说明外层循环要做多少轮、为什么，但把完整的循环结构留给学生自己写。",
	].join("\n")
}

/**
 * 【P5/T16】当本轮学生在**直接索要完整实现**时追加的强化约束。
 *
 * 为什么要单独一段：概念护栅（上方）对"持续索要"只写了"不要因此放弃约束"，
 * 实测（M6'）表明模型会把这类提示当成背景噪声而直接给出完整实现。本段把限制写成
 * **本轮第一优先级**，并给出可执行的替代动作（只给关键步骤 + 交回主动权）。
 *
 * ⚠️ 与概念护栅同样只是**提示词级**约束（不拦截输出）—— 与 `buildConceptModeConstraint()` 一致。
 */
export function buildDemandRefusalConstraint(): string {
	return [
		"",
		"",
		"【本轮硬约束：学生正在索要完整实现】",
		"1. 本轮**不得**输出完整可运行的实现（含完整循环结构 + 返回语句的整段代码）；",
		"2. 只给**关键步骤片段**或伪代码骨架，并写清“完整实现需要你自己动手写”；",
		"3. 给出一件**现在就能做的小事**（例如“先把外层循环要跑多少轮写出来”），把主动权交回学生；",
		"4. 不要解释“你为什么不能给”，直接按上面的方式作答即可。",
	].join("\n")
}

/**
 * 该分类是否属于「概念问答模式」（单轮口径）。
 *
 * ⚠️ **自 F3 起，本函数不再是注入或违规可见化的门控** —— index.ts 的两处都改用
 * `BehaviorMonitor.getConceptModeState().active`（任务级粘性），因为在"学生反复索要完整实现"
 * 这一目标场景里单轮分类会变成 code_generation，用单轮口径做门控会让护栏在最需要时静默失效。
 * 保留本函数：它是纯函数，既有单测（conceptModeConstraint.test.ts）覆盖，且可供离线复算/向后兼容使用。
 */
export function isConceptModeCategory(category: string | undefined): boolean {
	return category === "explanation" || category === "algorithm"
}

export interface ConceptModeViolation {
	violated: boolean
	reason?: string
	/** 违规代码块的行数（用于日志定位） */
	blockLines?: number
}

/** 判定"像完整实现"的最小行数。保守取值：低于此不判违规，避免误伤片段 */
const MIN_COMPLETE_IMPL_LINES = 6

/** 循环关键词 —— 完整实现通常至少含一处循环 */
const LOOP_PATTERN = /\b(for|while)\b/

/**
 * 检测回复里是否出现了"完整可运行实现"（仅用于可见化，不用于拦截）。
 *
 * 判定条件（保守，两个都满足才算）：
 *   1. 存在 fenced 代码块，且其中**有效行数 ≥ 6**；
 *   2. 该代码块内含 `for` / `while` 循环。
 *
 * 为什么保守：长代码块也可能是数据结构定义、也可能是学生当前确实在写的代码。
 * 宁可漏报（少记一条日志），也不要误报。
 */
export function detectConceptModeViolation(text: string): ConceptModeViolation {
	// 复用 Task 3a 的公共解析器，不再自持一份围栏正则
	for (const block of parseFencedCodeBlocks(text)) {
		if (block.lineCount >= MIN_COMPLETE_IMPL_LINES && LOOP_PATTERN.test(block.inner)) {
			return {
				violated: true,
				reason: `fenced 代码块含循环且有效行数 ${block.lineCount} ≥ ${MIN_COMPLETE_IMPL_LINES}，疑似完整实现`,
				blockLines: block.lineCount,
			}
		}
	}
	return { violated: false }
}
