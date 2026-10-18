/**
 * =============================================================================
 *  thinkingQuestions — 提交前思考题生成（P0 模板版 / P1 换 LLM）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【设计依据】设计文档 §7.3.1「题数自适应规则」：
 * 题数由**本次提交材料丰富度**决定，而不是任务难度（assignments 表没有难度列）。
 * 六个特征 → 分数 S → N = 5 if S>=5 else 4 if S>=2 else 3，且极瘦提交强制 3 题。
 *
 *   L = 代码有效行数      F = 代码文件数      R = 运行次数
 *   E = 报错次数          D = 任务描述字数    W = code_edit 事件数
 *
 * 【P0 为何用模板】
 * 出题要走 LLM，联调时一旦模型侧不可用整条链路就卡住；先把「收集 → 出题 → 面板 →
 * 确认 → 上传」四段跑通，P1 再把 buildTemplateQuestions 换成 LLM 出题即可，
 * 面板与上传侧完全不用改（questions 结构不变）。
 * =============================================================================
 */

import type { BundleQuestion, QuestionDifficulty } from "./bundleTypes"
import { BUNDLE_LIMITS } from "./bundleTypes"

/** 出题所依赖的信号（都由 SubmissionPackager 在本地统计，零网络开销） */
export interface QuestionSignals {
	/** 代码有效行数（所有收集到的代码文件之和） */
	codeLineCount: number
	/** 代码文件数 */
	fileCount: number
	/** 运行/调试次数 */
	runCount: number
	/** 其中失败（非 0 退出码）次数 */
	failureCount: number
	/** 任务描述（实验指导书）字符数 */
	descriptionChars: number
	/** 行为日志里 code_edit 事件数 */
	codeEditCount: number
}

export interface TemplateQuestionContext {
	assignmentTitle: string
	assignmentId?: string
	description?: string
	signals: QuestionSignals
}

/**
 * §7.3.1 的打分函数（导出便于单测；改规则先改测试）
 */
export function scoreForQuestions(signals: QuestionSignals): number {
	const { codeLineCount, fileCount, runCount, failureCount, descriptionChars, codeEditCount } = signals
	let score = 0
	if (codeLineCount >= 80) score += 2
	else if (codeLineCount >= 40) score += 1
	if (fileCount >= 3) score += 1
	if (runCount >= 1) score += 1
	if (runCount >= 4) score += 1
	if (failureCount >= 1) score += 1
	if (failureCount >= 3) score += 1
	if (descriptionChars >= 300) score += 1
	if (codeEditCount >= 10) score += 1
	return score
}

/**
 * 本次应该出几道题：3~5 题。
 * 极瘦提交（代码 < 10 行且没运行过）固定 3 题 —— 学生没什么可谈的，
 * 出 5 题只会换来 5 行敷衍。
 */
export function countForQuestions(signals: QuestionSignals): number {
	if (signals.codeLineCount < 10 && signals.runCount === 0) return 3
	const score = scoreForQuestions(signals)
	const n = score >= 5 ? 5 : score >= 2 ? 4 : 3
	return Math.min(BUNDLE_LIMITS.maxQuestions, Math.max(BUNDLE_LIMITS.minQuestions, n))
}

interface Candidate {
	question: string
	intent: string
	difficulty: QuestionDifficulty
	/** 触发条件：false 表示兜底题，永远可选 */
	when: boolean
	/** 优先级，越小越先选 */
	priority: number
}

/**
 * 模板出题：按信号挑题、按优先级排序，取前 N 道。
 * 兜底题保证任何提交都能凑够 3 道（BN-31 窄代码也能出题）。
 */
export function buildTemplateQuestions(ctx: TemplateQuestionContext): BundleQuestion[] {
	const { assignmentTitle, signals } = ctx
	const title = assignmentTitle?.trim() || "本次实验"
	const failText = signals.failureCount > 0 ? `（其中 ${signals.failureCount} 次报错）` : ""

	const candidates: Candidate[] = [
		{
			question: `请用 3~5 句话说明你在「${title}」里实现的核心思路：整体分成几步、每一步负责什么。`,
			intent: "考察能否用自己的话复述实现结构",
			difficulty: "easy",
			when: true,
			priority: 1,
		},
		{
			question:
				signals.runCount > 0
					? `你一共运行/调试了 ${signals.runCount} 次${failText}。请挑一次印象最深的报错：报错信息是什么、你判断根因的过程是怎样的？`
					: "这次你没有运行调试过代码。如果现在要验证它是否正确，你会设计哪些测试用例？为什么先测这几个？",
			intent: "考察调试过程与验证意识",
			difficulty: "medium",
			when: true,
			priority: 3,
		},
		{
			question: `对照任务要求，你的实现做了哪些取舍？如果老师要求换一种做法（例如不用现成的库），你会先改哪里？`,
			intent: "考察需求理解与方案权衡",
			difficulty: "hard",
			when: signals.descriptionChars >= 300,
			// 只有任务描述够长（指导书详细）时才问，且优先级要高于通用的调试/结构题：
			// 否则 3 题模式永远轮不到它，长指导书的信息就白读了
			priority: 2,
		},
		{
			question:
				signals.codeLineCount >= 40 || signals.fileCount >= 3
					? `你的代码约 ${signals.codeLineCount} 行、分布在 ${signals.fileCount} 个文件里。哪一段是最复杂的？为什么把它放在那个位置（而不是别处）？`
					: "你的实现比较短。请说明为什么这样写就够用了，以及如果需求扩大一倍，你会先加哪一部分？",
			intent: "考察结构划分与复杂度判断",
			difficulty: "medium",
			when: true,
			priority: 4,
		},
		{
			question:
				signals.codeEditCount >= 10
					? `你在编码过程中手动修改了 ${signals.codeEditCount} 次代码。请举一处「AI 给了但你自己改掉」的地方，说明为什么改。`
					: "这次任务中，哪些代码是你自己写的、哪些参考了 AI 的建议？你如何判断该不该采纳？",
			intent: "考察 AI 使用边界与自主修改能力",
			difficulty: "hard",
			when: true,
			priority: 5,
		},
		{
			question: "如果要把这段代码交给同学继续维护，你会补充哪些注释或文档？请写出最关键的两条。",
			intent: "考察可维护性与表达能力（兜底题）",
			difficulty: "easy",
			when: true,
			priority: 6,
		},
		{
			question: `这次任务里，哪一部分你最有把握？哪一部分还需要再练？请各举一个具体位置。`,
			intent: "考察自我评估（兜底题）",
			difficulty: "easy",
			when: true,
			priority: 7,
		},
	]

	const count = countForQuestions(signals)
	const picked = candidates
		.filter((c) => c.when)
		.sort((a, b) => a.priority - b.priority)
		.slice(0, count)

	return picked.map((c, i) => ({
		seq: i + 1,
		question: c.question,
		intent: c.intent,
		difficulty: c.difficulty,
		source: "template" as const,
	}))
}
