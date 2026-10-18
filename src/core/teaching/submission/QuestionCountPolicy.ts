import { countForQuestions, type QuestionSignals, scoreForQuestions } from "./thinkingQuestions"

/**
 * 思考题数量决策（设计 §7.3.1，裁定 R1：按学生情况自动 3/4/5，默认 3）
 *
 * 拆成独立文件的原因：它是**唯一需要被单测反复打磨的规则**，
 * 与「怎么问 LLM」「怎么调面板」无关；AssignmentManager 只消费结果。
 */

export const MIN_QUESTIONS = 3
export const MAX_QUESTIONS = 5
export const DEFAULT_QUESTIONS = 3

export interface QuestionCountPolicy {
	/** 自适应开关，来自 teaching.thinkingQuestionAuto，默认 true */
	auto?: boolean
	/** 关闭自适应时的固定题数，来自 teaching.thinkingQuestionCount，默认 3 */
	configuredCount?: number
	min?: number
	max?: number
}

export interface QuestionCountDecision {
	count: number
	score: number
	mode: "auto" | "fixed"
	/** 决策依据（写进面板顶部提示，方便答疑/排错） */
	reason: string
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

export function decideQuestionCount(signals: QuestionSignals, policy: QuestionCountPolicy = {}): QuestionCountDecision {
	const min = policy.min ?? MIN_QUESTIONS
	const max = policy.max ?? MAX_QUESTIONS
	const auto = policy.auto !== false
	const score = scoreForQuestions(signals)

	if (!auto) {
		const configured = policy.configuredCount ?? DEFAULT_QUESTIONS
		return {
			count: clamp(configured, min, max),
			score,
			mode: "fixed",
			reason: `已关闭自适应出题，固定 ${clamp(configured, min, max)} 题`,
		}
	}

	const raw = countForQuestions(signals)
	const count = clamp(raw, min, max)
	const reason =
		raw !== count ? `按材料计分 ${score} 分算出 ${raw} 题，已夹到 [${min},${max}]` : `按材料计分 ${score} 分算出 ${count} 题`
	return { count, score, mode: "auto", reason }
}
