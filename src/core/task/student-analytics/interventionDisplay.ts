/**
 * 【F13】文案展示决策 —— M9' 的**可数性**在这里落地。
 *
 * 做成**模块级纯函数**（而不是 `Task` 的私有方法）的理由与 T10 一致：可测性。
 * M9' 的三条守恒式全部建立在这张分支表的记账正确性上：
 *   ① `V = C + T`     —— 每条学生可见文案都能被「回执块」或「模板降级」解释
 *   ② `D ≥ C + T`     —— 决策数不少于送达数
 *   ③ `C + T + N ≥ D` —— 每条决策都能被「有块 / 降级 / 无块但有提示」三者之一解释
 *
 * 分支表（每一项都有单测）：
 *   ① `found` + 校验通过     → 展示模型文案，记 `copy_accepted`（计入 `C`）
 *   ② `found` + 校验不过     → 降级模板兜底，记 `copy_rejected` + reasons（计入 `T`）
 *   ③ `!found` + 本轮有注入  → 模板兜底照常展示，记 `copy_rejected` + `block_missing`（计入 `T`）
 *   ④ `!found` + 无注入但"像提示语" → 不附加任何文案，只记 `hint_without_injection`（计入 `N`）
 *   ⑤ `!found` + 无注入且不像提示语 → 不落事件
 *
 * ⚠️ **残留说明**（写进报告与账本）：`copy_rejected` 同时覆盖"校验不过"与"缺块"，与 spec 的
 * `T` 定义一致（`T` = 校验不过/**缺块** → 模板兜底的次数）；`N` 由 `hint_without_injection` 计数。
 */

import type { ExtractedCopy } from "@/shared/markdown/interventionCopy"
import { type CopyValidationAdvisory, type CopyValidationReason, validateCopy } from "./InterventionCopyContract"
import type { BehaviorRuleId, InterventionSeverity, InterventionStyle } from "./types"

/** 文案判定结果（M9'：`accepted`→C，`rejected`→T，`hint_without_injection`→N） */
export type InterventionCopyDecision = "copy_accepted" | "copy_rejected" | "hint_without_injection"

/** 学生实际看到的文案来源 */
export type InterventionCopyVoice = "model" | "template"

/** 记账原因：确定性校验原因 + 展示层专有的三种 */
export type InterventionCopyReason = CopyValidationReason | "block_missing" | "no_injection_active" | "blocking_template"

/** 落进 `StudentInteractionLog` 的结构化事件（字段与 `types.ts` 的可选字段一一对应） */
export interface InterventionCopyEvent {
	eventType: "intervention_copy"
	copyDecision: InterventionCopyDecision
	copyReasons: InterventionCopyReason[]
	copyVoice?: InterventionCopyVoice
	copyAdvisories?: CopyValidationAdvisory[]
	interventionRuleId?: BehaviorRuleId
	interventionSeverity?: InterventionSeverity
	interventionStyle?: InterventionStyle
}

export interface ResolveCopyInput {
	/** `extractInterventionCopy()` 的 `found` */
	found: ExtractedCopy | null
	/** 剥离回执块后的助手正文（只用于「像不像提示语」的启发式） */
	body: string
	/** 本轮注入的模板文案（`undefined` ⇒ 本轮没有注入。展示层**不得**提前清空它） */
	lastInjectionTemplate?: string
	/** 最近 2 轮学生输入（喂给主题锚定启发式） */
	recentTexts: string
	/** 本轮决策的规则 / 力度 / 风格（随事件落库，供教师端对账） */
	interventionRuleId?: BehaviorRuleId
	interventionSeverity?: InterventionSeverity
	interventionStyle?: InterventionStyle
}

export interface ResolveCopyResult {
	/** 需要**附加**到学生可见正文前的文案；`undefined` = 不附加 */
	text: string | undefined
	/** 需要落库的记账事件；`undefined` = 不落事件 */
	event: InterventionCopyEvent | undefined
}

/** 「像提示语」的关键词（与系统提示里的防仿写约束配套，只记账不拦截） */
const HINT_MARKERS = /学习提示|独立编码提示|实践建议|反思/

/**
 * 「像不像一段学习提示语」——**启发式**，只用于记账（`N`）。
 * 覆盖两种可见形态：自带 💡 前缀的模板式提示，或命中提示语关键词的仿写。
 */
export function looksLikeInterventionHint(body: string): boolean {
	const text = (body ?? "").trim()
	if (!text) {
		return false
	}
	return text.startsWith("💡") || HINT_MARKERS.test(text)
}

/**
 * 判定本轮"学生实际看到什么文案"以及"该怎么记账"。
 * 纯函数：同样的输入必然得到同样的输出，因此可以脱离 `Task`/vscode 直接断言。
 */
export function resolveInterventionCopyForDisplay(input: ResolveCopyInput): ResolveCopyResult {
	const meta = {
		interventionRuleId: input.interventionRuleId,
		interventionSeverity: input.interventionSeverity,
		interventionStyle: input.interventionStyle,
	}

	if (input.found) {
		const validation = validateCopy(input.found.copy, { recentTexts: input.recentTexts })

		if (validation.ok) {
			// ① 模型文案可用
			return {
				text: input.found.copy,
				event: {
					eventType: "intervention_copy",
					copyDecision: "copy_accepted",
					copyReasons: [],
					copyVoice: "model",
					copyAdvisories: validation.advisories,
					...meta,
				},
			}
		}

		// ② 校验不过 ⇒ 降级模板兜底（没有模板就不附加但**照样记账**，否则 T 会漏数）
		return {
			text: input.lastInjectionTemplate,
			event: {
				eventType: "intervention_copy",
				copyDecision: "copy_rejected",
				copyReasons: validation.reasons,
				copyVoice: input.lastInjectionTemplate ? "template" : undefined,
				copyAdvisories: validation.advisories,
				...meta,
			},
		}
	}

	// ③ 模型根本没用回执块，但本轮确实注入过 ⇒ 干预一次都不丢
	if (input.lastInjectionTemplate) {
		return {
			text: input.lastInjectionTemplate,
			event: {
				eventType: "intervention_copy",
				copyDecision: "copy_rejected",
				copyReasons: ["block_missing"],
				copyVoice: "template",
				...meta,
			},
		}
	}

	// ④ 无注入却写了像提示语的正文 ⇒ 只记账（模型仿写/不遵从的度量），不附加、不拦截
	if (looksLikeInterventionHint(input.body)) {
		return {
			text: undefined,
			event: {
				eventType: "intervention_copy",
				copyDecision: "hint_without_injection",
				copyReasons: ["no_injection_active"],
				...meta,
			},
		}
	}

	// ⑤ 普通正文：不附加、不落事件
	return { text: undefined, event: undefined }
}
