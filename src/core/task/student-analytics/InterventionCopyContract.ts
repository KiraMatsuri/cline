/**
 * 【F13】干预文案契约：模型写文案，**是否采用由代码判定**。
 *
 * 四条**确定性**校验 —— 任一不过 ⇒ `downgrade = true`，展示层改用 `TEMPLATE_REGISTRY`
 * 的模板文案兜底，并落一条 `copy_rejected`（M9' 的 `T`）。干预**一次都不会丢**。
 *
 * 一条**启发性**校验（主题锚定）—— 只进 `advisories`，`ok` 仍为 `true`、`downgrade` 仍为
 * `false`（用户裁定 2026-10-11：轻量启发式不得影响"干预一定发生"这一确定性）。
 *
 * 纯函数、无副作用、不依赖 vscode。
 */

import { parseFencedCodeBlocks } from "@/shared/markdown/codeBlocks"
import type { BehaviorRuleId, InterventionSeverity, InterventionStyle } from "./types"

/** 「留白」的字数上限（emoji 不计）。 */
export const MAX_COPY_CHARS = 120

/**
 * 【F13】力度档的语气要求 —— 由代码规定、模型**不得更改**（决策层归代码，叙述层归模型）。
 * 原样随任务书下发给模型，展示层不再做任何二次加工。
 */
export const SEVERITY_VOICE: Record<InterventionSeverity, string> = {
	gentle: "建议语气：把建议作为一个可选的下一步抛给学生，不要命令",
	moderate: "反问语气：用一个问题要求学生对当前思路作出说明",
	strong: "要求学生先动手：明确请学生自己先写出一版，再回来对照",
}

/** 文案里**不得**出现的内部机制词（出现即等于告诉学生"系统在检测你"） */
const FORBIDDEN = /系统|检测|自动/

/** 「留白」信号：问句，或一个明确的行动邀请 */
const BLANK_SIGNAL = /[?？]|试|想|请|先|动手|写|改|画|回顾|解释/u

/**
 * 去 emoji 用的字符类：常见 emoji 区段。
 * ⚠️ 变体选择符（FE0F）与零宽连接符（200D）是**组合符**，不能与字符区段同处一个字符类
 * （biome `noMisleadingCharacterClass`），故用「区段 | 组合符」的析取形式。
 */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}]|\uFE0F|\u200D/gu

/** 确定性校验的失败原因（任一出现即降级模板） */
export type CopyValidationReason = "too_long" | "has_fenced_code" | "no_blank" | "forbidden_phrase"

/** 启发性建议 —— **只记账，不影响是否展示** */
export type CopyValidationAdvisory = "topic_unanchored"

export interface CopyValidationContext {
	/** 最近 2 轮学生输入（用于主题锚定的启发式；为空表示本任务还没有学生输入） */
	recentTexts: string
}

export interface CopyValidation {
	/** 确定性校验是否全部通过（启发式不影响本字段） */
	ok: boolean
	/** 是否需要降级为模板文案（等价于 `reasons.length > 0`） */
	downgrade: boolean
	reasons: CopyValidationReason[]
	advisories: CopyValidationAdvisory[]
}

/** 去 emoji 后按**码点**计数（`💡` 计 0 字，与任务书里的"emoji 不计"一致） */
function countChars(copy: string): number {
	return [...copy.replace(EMOJI_RE, "")].length
}

/**
 * 粗粒度提词：中文取 2–4 字连续片段，英文取 ≥3 字母的词。
 * 只服务于"主题是否锚定"这一**启发性**判定，因此刻意保持简单（宁可少报，不可误降级）。
 */
function extractTopicTokens(text: string): Set<string> {
	const tokens = new Set<string>()
	for (const run of text.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
		for (let n = 2; n <= Math.min(4, run.length); n++) {
			for (let i = 0; i + n <= run.length; i++) {
				tokens.add(run.slice(i, i + n))
			}
		}
	}
	for (const word of text.toLowerCase().match(/[a-z][a-z0-9_+#]{2,}/g) ?? []) {
		tokens.add(word)
	}
	return tokens
}

/**
 * 主题锚定启发式：文案与最近 2 轮学生输入是否有实义词交集。
 * 无从判定时（无学生输入 / 提不出词）一律视为**已锚定**，避免误报。
 */
function isTopicAnchored(copy: string, recentTexts: string): boolean {
	const recent = (recentTexts ?? "").trim()
	if (!recent) {
		return true
	}
	const topicTokens = extractTopicTokens(recent)
	if (topicTokens.size === 0) {
		return true
	}
	for (const token of extractTopicTokens(copy)) {
		if (topicTokens.has(token)) {
			return true
		}
	}
	return false
}

/**
 * 校验模型写出的干预文案。
 *
 * @param copy 模型在回执块里给出的文案（已由 `extractInterventionCopy()` trim）
 * @param ctx  上下文（最近 2 轮学生输入）
 */
export function validateCopy(copy: string, ctx: CopyValidationContext): CopyValidation {
	const reasons: CopyValidationReason[] = []
	const advisories: CopyValidationAdvisory[] = []
	const text = typeof copy === "string" ? copy : ""

	if (countChars(text) > MAX_COPY_CHARS) {
		reasons.push("too_long")
	}
	// `parseFencedCodeBlocks` 只认成对闭合的围栏；这里额外用反引号判定，把未闭合的也算违规
	if (text.includes("```") || parseFencedCodeBlocks(text).length > 0) {
		reasons.push("has_fenced_code")
	}
	if (!BLANK_SIGNAL.test(text)) {
		reasons.push("no_blank")
	}
	if (FORBIDDEN.test(text)) {
		reasons.push("forbidden_phrase")
	}

	if (!isTopicAnchored(text, ctx?.recentTexts ?? "")) {
		advisories.push("topic_unanchored")
	}

	return { ok: reasons.length === 0, downgrade: reasons.length > 0, reasons, advisories }
}

export interface CopyTaskSheetInput {
	ruleId: BehaviorRuleId
	severity: InterventionSeverity
	style: InterventionStyle
	/** 模板文案本体：既是**降级兜底**，也是任务书里的「语义基准与力度锚点」 */
	templateText: string
	/** 最近已展示过的文案（要求模型「换一种说法」，M13' 的机械化支撑；缺省为空） */
	recentCopies?: readonly string[]
}

/**
 * 生成注入给模型的「文案写作任务书」（替代 T6 之前那段"请呈现上述提示"的自由改写软指引）。
 *
 * 结构不变量（有单测守护）：外层标签是 `<teaching_intervention …>`（**不带** `_copy`
 * 后缀），回执块示例只以**内层**形式出现且必须位于其后 —— 这样 `apiConversationHistory`
 * 里永远只出现内层回执块，不会出现外层标签（F6 契约断言）。
 */
export function buildCopyTaskSheet(input: CopyTaskSheetInput): string {
	const { ruleId, severity, style, templateText } = input
	const recent = (input.recentCopies ?? []).map((c) => (c ?? "").trim()).filter((c) => c.length > 0)

	const lines: string[] = [
		`<teaching_intervention rule="${ruleId}" severity="${severity}">`,
		"【本轮教学提示写作任务书】规则 / 力度 / 风格已由系统决定，你只负责「怎么说得贴合学生当下」。",
		"",
		`- 规则（rule）：${ruleId}`,
		`- 力度档（severity）：${severity} —— 语气要求（原文照办，不得更改）：${SEVERITY_VOICE[severity]}`,
		`- 风格（style）：${style}`,
		"",
		"请按下面三要素写一段**给学生看的中文提示**（不要复述本任务书的字段名或标题）：",
		"1. 观察：中性描述「我（AI）刚刚做了什么」，不得指控或评价学生；",
		"2. 锚定当前主题：必须点名**此刻**正在讨论的具体主题 / 函数 / 报错信息，不要写空泛的鼓励；",
		"3. 留白：用一句问句或一个明确的行动邀请，把主动权交回学生。",
		"",
		"硬约束（违反会被系统丢弃，并换成预置文案）：",
		`- 长度 ≤ ${MAX_COPY_CHARS} 字（emoji 不计）；`,
		"- 不得含代码块（不要出现三反引号围栏）；",
		"- 不得承诺「接下来我会…」，不得提及**系统/检测/自动**等内部机制；",
		"- 不要自我重复（见下方已用文案）。",
		"",
		"【力度锚点】下面是系统预置文案，只作为语义基准与力度基准，**不要照抄**：",
		templateText,
	]

	if (recent.length > 0) {
		lines.push("", "【已用文案】最近已经对学生说过下面这些，必须**换一种说法**：")
		recent.forEach((c, i) => {
			lines.push(`${i + 1}. ${c}`)
		})
	}

	lines.push(
		"",
		"【回执格式】把你**写给学生的提示原文**再回执一次，且必须写在回复**正文**里 —— 不要放进 attempt_completion 的 result 参数（工具参数不会被计入教学对账）：",
		`<teaching_intervention_copy rule="${ruleId}" severity="${severity}">`,
		"（这里贴你写给学生的提示原文）",
		"</teaching_intervention_copy>",
		"回执块不会被学生看到（系统在显示前剥离），它只用于教学研究对账，因此必须与正文里那段提示**逐字一致**。",
		"</teaching_intervention>",
	)

	return lines.join("\n")
}
