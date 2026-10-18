import type { BundleRunTrace } from "./bundleTypes"
import type { TemplateQuestionContext } from "./thinkingQuestions"

/**
 * 出题 prompt（纯字符串拼接，方便单测与后续调参）
 *
 * 三条硬约束写进 system prompt，而不是靠代码兜底：
 *   ① 只问**这次提交里能看到的东西**，不许编造学生没写过的实现
 *   ② 不许问「你学到了什么」这类空话，必须是可核对的复述/取舍/调试细节
 *   ③ 只能输出 JSON 数组，不要 markdown 围栏——解析器虽然容错，但少一次容错就少一次失败
 */

export const QUESTION_SYSTEM_PROMPT = `你是一位计算机实验课助教，负责根据学生本次提交的材料出「思考题」，检验学生是否真的理解自己交上来的代码。

硬性要求：
1. 只依据提供的材料提问，不得虚构学生没写过的函数、没跑过的命令、没遇到的报错。
2. 每题聚焦一个具体点：核心思路、关键取舍、调试过程、边界条件、AI 使用边界。禁止「你有什么收获」这类无法核对的空泛问题。
3. 题干用中文、第二人称、1~2 句话；不要出现「根据以上材料」这类元话术。
4. 难度分布：至少 1 题 easy（复述、定位）、至少 1 题 medium（解释原因），其余可 hard（改需求/权衡）。
5. 严格输出 JSON 数组，不要任何解释文字、不要 markdown 代码围栏。每个元素形如：
   {"question": "题干", "intent": "这道题想考察什么", "difficulty": "easy|medium|hard", "hint": "可选提示，不给答案"}
6. 数组长度必须正好等于要求的题数。`

const MAX_CODE_FILES_IN_PROMPT = 6
const MAX_CHARS_PER_FILE = 2200
const MAX_TOTAL_CODE_CHARS = 12000
const MAX_TRACES_IN_PROMPT = 8

export interface QuestionPromptInput {
	assignment: { id: string; title: string; description?: string }
	ctx: TemplateQuestionContext
	count: number
	codeFiles: Array<{ relPath: string; content: string }>
	runTraces?: BundleRunTrace[]
	logLineCount?: number
}

function clip(text: string, max: number): string {
	if (text.length <= max) return text
	return `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字）`
}

function formatTraces(traces: BundleRunTrace[] | undefined): string {
	if (!traces || traces.length === 0) return "（未采集到运行痕迹）"
	return traces
		.slice(-MAX_TRACES_IN_PROMPT)
		.map((t, i) => {
			const code = typeof t.exit_code === "number" ? t.exit_code : "unknown"
			const tail = (t.stdout_tail ?? "").trim().slice(0, 600)
			return `${i + 1}. 命令 \`${t.command ?? "(unknown)"}\` → 退出码 ${code}\n   输出尾部：${tail || "(空)"}`
		})
		.join("\n")
}

export function buildQuestionUserPrompt(input: QuestionPromptInput): string {
	const { assignment, ctx, count } = input
	const signals = ctx.signals

	const files: string[] = []
	let used = 0
	for (const f of input.codeFiles.slice(0, MAX_CODE_FILES_IN_PROMPT)) {
		if (used >= MAX_TOTAL_CODE_CHARS) {
			files.push(`（其余 ${Math.max(0, input.codeFiles.length - files.length)} 个文件因为长度限制未提供）`)
			break
		}
		const body = clip(f.content, MAX_CHARS_PER_FILE)
		used += body.length
		files.push(`### ${f.relPath}\n\`\`\`\n${body}\n\`\`\``)
	}

	return `## 实验任务
- 任务 ID：${assignment.id}
- 任务标题：${assignment.title}
- 任务说明：${assignment.description?.trim() || "（任务没有单独说明，按标题与代码推断）"}

## 学生本次提交的量化情况
- 代码：${signals.fileCount} 个文件、约 ${signals.codeLineCount} 行有效代码
- 运行/调试：${signals.runCount} 次，其中失败 ${signals.failureCount} 次
- 编码过程中手动修改代码：${signals.codeEditCount} 次
- 行为日志：${input.logLineCount ?? 0} 行

## 代码文件
${files.join("\n\n") || "（本次没有代码文件）"}

## 运行痕迹（如果学生调试运行过）
${formatTraces(input.runTraces)}

## 输出
请出 **${count}** 道思考题，严格输出 JSON 数组。`
}
