import type { BundleQuestion, BundleRunTrace, QuestionDifficulty } from "./bundleTypes"
import { decideQuestionCount, type QuestionCountDecision, type QuestionCountPolicy } from "./QuestionCountPolicy"
import { buildQuestionUserPrompt, QUESTION_SYSTEM_PROMPT } from "./QuestionPrompt"
import { buildTemplateQuestions, type QuestionSignals, type TemplateQuestionContext } from "./thinkingQuestions"

/**
 * 思考题生成（P1-1）
 *
 * 分层：
 *   decideQuestionCount  → 纯规则（QuestionCountPolicy）
 *   parseQuestionsJson   → 纯解析（容错：围栏/前后缀/对象包数组）
 *   fillWithTemplates    → 纯补齐（LLM 给少了就用模板补，并标 source）
 *   generateThinkingQuestions → 唯一碰 IO 的入口，callLLM 可注入（单测不联网）
 *
 * 「LLM 不可用不能让提交失败」是硬要求：任何异常都退化成模板题 + warning。
 */

export interface QuestionGeneratorInput {
	signals: QuestionSignals
	assignment: { id: string; title: string; description?: string }
	codeFiles: Array<{ relPath: string; content: string }>
	runTraces?: BundleRunTrace[]
	logLineCount?: number
	policy?: QuestionCountPolicy
}

export interface QuestionGeneratorDeps {
	/** 注入点：返回模型原始文本。缺省表示「没有可用模型」，直接走模板题 */
	callLLM?: (systemPrompt: string, userPrompt: string) => Promise<string>
}

export interface QuestionGeneratorOutcome {
	questions: BundleQuestion[]
	count: number
	generatedBy: "llm" | "template" | "mixed"
	score: number
	decision: QuestionCountDecision
	/** 给面板顶部显示的一句话（降级、补齐等） */
	warning?: string
}

const DIFFICULTIES: QuestionDifficulty[] = ["easy", "medium", "hard"]

function normalizeDifficulty(raw: unknown): QuestionDifficulty {
	const value = String(raw ?? "").toLowerCase()
	if (value === "easy" || value === "简单" || value === "基础") return "easy"
	if (value === "hard" || value === "困难" || value === "拓展") return "hard"
	return "medium"
}

/** 把模型返回的文本剥成 JSON 里那个数组（容忍围栏与前后解释文字） */
function extractJsonPayload(text: string): unknown {
	const trimmed = text.trim()
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
	const body = fence ? fence[1].trim() : trimmed

	const candidates = [body]
	const firstBracket = body.indexOf("[")
	const lastBracket = body.lastIndexOf("]")
	if (firstBracket >= 0 && lastBracket > firstBracket) candidates.push(body.slice(firstBracket, lastBracket + 1))
	const firstBrace = body.indexOf("{")
	const lastBrace = body.lastIndexOf("}")
	if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(body.slice(firstBrace, lastBrace + 1))

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate)
		} catch {
			// 试下一个候选
		}
	}
	return null
}

function toQuestion(raw: unknown): BundleQuestion | null {
	if (typeof raw === "string") {
		const text = raw.trim()
		return text.length >= 4 ? { seq: 0, question: text, source: "llm" } : null
	}
	if (!raw || typeof raw !== "object") return null
	const record = raw as Record<string, unknown>
	const text = [record.question, record.content, record.text, record["题目"], record["问题"]].find(
		(v) => typeof v === "string" && v.trim().length >= 4,
	) as string | undefined
	if (!text) return null
	const hint = [record.hint, record["提示"]].find((v) => typeof v === "string" && v.trim()) as string | undefined
	const intent = [record.intent, record["考察点"]].find((v) => typeof v === "string" && v.trim()) as string | undefined
	return {
		seq: 0,
		question: text.trim().slice(0, 400),
		intent: intent?.trim().slice(0, 200),
		difficulty: normalizeDifficulty(record.difficulty ?? record["难度"]),
		hint: hint?.trim().slice(0, 200),
		source: "llm",
	}
}

/** 容错解析：任何失败都返回空数组，由调用方决定补模板 */
export function parseQuestionsJson(text: string, limit: number): BundleQuestion[] {
	if (!text || !text.trim()) return []
	const payload = extractJsonPayload(text)
	if (!payload) return []

	const list = Array.isArray(payload)
		? payload
		: Array.isArray((payload as Record<string, unknown>)?.questions)
			? ((payload as Record<string, unknown>).questions as unknown[])
			: []

	const parsed: BundleQuestion[] = []
	for (const item of list) {
		const q = toQuestion(item)
		if (!q) continue
		parsed.push(q)
		if (parsed.length >= limit) break // Q-6：模型给多了直接截断
	}
	return parsed.map((q, i) => ({ ...q, seq: i + 1 }))
}

/** 用模板题把缺口补齐；返回最终题目与「是否混用了模板」 */
export function fillWithTemplates(
	llmQuestions: BundleQuestion[],
	ctx: TemplateQuestionContext,
	count: number,
): { questions: BundleQuestion[]; mixed: boolean } {
	const questions = llmQuestions.slice(0, count).map((q, i) => ({ ...q, seq: i + 1 }))
	if (questions.length >= count) return { questions, mixed: false }

	const seen = new Set(questions.map((q) => q.question.replace(/\s+/g, "")))
	const templates = buildTemplateQuestions(ctx)
	for (const t of templates) {
		if (questions.length >= count) break
		const key = t.question.replace(/\s+/g, "")
		if (seen.has(key)) continue
		seen.add(key)
		questions.push({ ...t, seq: questions.length + 1, source: "template" })
	}
	return { questions: questions.slice(0, count), mixed: true }
}

export async function generateThinkingQuestions(
	input: QuestionGeneratorInput,
	deps: QuestionGeneratorDeps = {},
): Promise<QuestionGeneratorOutcome> {
	const decision = decideQuestionCount(input.signals, input.policy)
	const count = decision.count
	const ctx: TemplateQuestionContext = {
		assignmentTitle: input.assignment.title,
		assignmentId: input.assignment.id,
		description: input.assignment.description,
		signals: input.signals,
	}
	const templateOutcome = (warning: string): QuestionGeneratorOutcome => ({
		questions: buildTemplateQuestions(ctx)
			.slice(0, count)
			.map((q, i) => ({ ...q, seq: i + 1, source: "template" })),
		count,
		generatedBy: "template",
		score: decision.score,
		decision,
		warning,
	})

	if (!deps.callLLM) {
		return templateOutcome("当前没有可用的模型配置，已使用通用思考题")
	}

	const userPrompt = buildQuestionUserPrompt({
		assignment: input.assignment,
		ctx,
		count,
		codeFiles: input.codeFiles,
		runTraces: input.runTraces,
		logLineCount: input.logLineCount,
	})

	let raw = ""
	try {
		raw = await deps.callLLM(QUESTION_SYSTEM_PROMPT, userPrompt)
	} catch (e) {
		return templateOutcome(`模型调用失败（${(e as Error).message || "未知错误"}），已使用通用思考题`)
	}

	const llmQuestions = parseQuestionsJson(raw, count)
	if (llmQuestions.length === 0) {
		return templateOutcome("模型没有返回可用的思考题，已使用通用思考题")
	}

	const filled = fillWithTemplates(llmQuestions, ctx, count)
	return {
		questions: filled.questions,
		count: filled.questions.length,
		generatedBy: filled.mixed ? "mixed" : "llm",
		score: decision.score,
		decision,
		warning: filled.mixed ? `模型只出了 ${llmQuestions.length} 题，已用通用题补齐到 ${count} 题` : undefined,
	}
}
