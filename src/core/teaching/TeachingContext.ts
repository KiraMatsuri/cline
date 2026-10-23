import { detectFullImplementation } from "../task/student-analytics/fullImplementationDetect"
import { isCompleteImplDemand } from "../task/student-analytics/demandDetect"

/**
 * 教学上下文装配（P1-5）。
 *
 * 为什么要有这个纯函数：
 * 1) 自由问答模式与实验任务是两种教学语境，前者只需要「教材索引 + 检索片段」，
 *    后者需要「实验指导 + 附件要点 + 模板代码 + 检索片段」的固定预算上下文。
 *    把它们拆成纯函数后，模式语义不依赖 Task 实例，可被单测直接覆盖（BN-27/BN-28）。
 * 2) 模型窗口有限，实验模式四个内容段各有配额、总预算 6000 字符，
 *    必须按优先级确定性截断，并把「哪些段被丢弃」显式记录，避免静默丢上下文。
 *
 * 约定：
 * - 段顺序固定：自由模式 index → recall；实验模式 guide → attachments → template → recall。
 * - 配额：guide 3000 / attachments 1500 / template 800 / recall 700，总预算默认 6000。
 * - 截断按 Unicode 码点（Array.from），中文按字符计、emoji 不会被切成半个代理对（BN-28）。
 * - 空输入跳过该段且不抛错（BN-27），段名记入 dropped。
 * - 实验模式的硬约束不占预算、不进 sections，由 hardConstraint 单独返回（测试断言「额外产出」）。
 */

export type TeachingContextMode = "free" | "experiment"

/** 各内容段配额（单位：Unicode 码点）。 */
export const TEACHING_CONTEXT_QUOTAS = {
	guide: 3000,
	attachments: 1500,
	template: 800,
	recall: 700,
} as const

/** 默认总预算。 */
export const TEACHING_CONTEXT_BUDGET = 6000

/** 实验模式硬约束：只给方向，第 4 次明确索要才可给伪代码。 */
export const EXPERIMENT_HARD_CONSTRAINT = "本任务处于实验模式：只给方向，不给可运行完整实现；第 4 次索要才可给伪代码。"

export interface TeachingContextSection {
	/** 段名，用于 dropped 记录与测试断言。 */
	name: string
	/** 渲染标题（prompt 中以 `## ` 前缀出现）。 */
	label: string
	/** 段正文（已截断）。 */
	content: string
	/** 正文 Unicode 码点数。 */
	chars: number
	/** 是否被截断（部分丢弃）。 */
	truncated: boolean
	/** 是否有内容被丢弃（当前实现中等价于 truncated，保留字段供契约稳定）。 */
	dropped: boolean
}

export interface TeachingContextInput {
	/** 自由问答模式 / 实验任务模式。 */
	mode: TeachingContextMode
	/** 实验指导（GUIDE.md 正文），仅实验模式使用。 */
	guide?: string | null
	/** 实验附件要点（已提取为文本的数组），仅实验模式使用。 */
	attachments?: readonly string[] | null
	/** 当前模板/起始代码，仅实验模式使用。 */
	template?: string | null
	/** 教材检索片段，两种模式共用。 */
	recall?: string | null
	/** 教材资料索引（自由模式需要，实验模式当前不注入），无配额。 */
	index?: string | null
	/** 总预算（默认 6000），仅实验模式的内容段受它约束。 */
	budget?: number
}

export interface TeachingContextResult {
	/** 内容段（不含硬约束），顺序即注入顺序。 */
	sections: TeachingContextSection[]
	/** 实验模式硬约束段；自由模式为 null。 */
	hardConstraint: TeachingContextSection | null
	/** 所有内容段正文的 Unicode 码点总数（不含硬约束）。 */
	totalChars: number
	/** 未被完整渲染的段名（空输入、截断、预算耗尽），按处理顺序。 */
	dropped: string[]
	/** 实际生效的总预算。 */
	budget: number
	/** 可直接拼进 system prompt 的上下文文本。 */
	prompt: string
}

const SECTION_LABELS: Record<string, string> = {
	index: "教材资料索引",
	guide: "实验指导（GUIDE.md）",
	attachments: "实验附件要点",
	template: "当前模板代码",
	recall: "参考教材片段（自动检索）",
	constraint: "实验模式硬约束",
}

/** Unicode 码点数：中文按字符计，emoji 记 1。 */
export function codePointLength(text: string): number {
	return Array.from(text).length
}

/**
 * 按 Unicode 码点截断。
 * 为什么不用 String#slice：slice 按 UTF-16 code unit 切，会把 emoji 切成孤立代理对（BN-28）。
 */
export function truncateByCodePoints(text: string, maxChars: number): { text: string; truncated: boolean } {
	const codePoints = Array.from(text)
	if (codePoints.length <= maxChars) {
		return { text, truncated: false }
	}
	return { text: codePoints.slice(0, Math.max(0, maxChars)).join(""), truncated: true }
}

function normalizeText(input: string | null | undefined): string {
	return (input ?? "").trim()
}

function normalizeAttachments(input: readonly string[] | null | undefined): string {
	if (!input || input.length === 0) {
		return ""
	}
	return input
		.map((item) => normalizeText(item))
		.filter((item) => item.length > 0)
		.join("\n\n")
}

/**
 * 生成一个内容段；空输入 / 配额为 0 时返回 null 并把段名记入 dropped。
 */
function buildSection(name: string, raw: string, allowance: number, dropped: string[]): TeachingContextSection | null {
	const content = normalizeText(raw)
	if (!content) {
		dropped.push(name)
		return null
	}
	const { text, truncated } = truncateByCodePoints(content, allowance)
	if (truncated) {
		dropped.push(name)
	}
	if (!text) {
		return null
	}
	return {
		name,
		label: SECTION_LABELS[name] ?? name,
		content: text,
		chars: codePointLength(text),
		truncated,
		dropped: truncated,
	}
}

function renderSection(section: TeachingContextSection): string {
	return `## ${section.label}\n${section.content}`
}

/**
 * 装配教学上下文。
 *
 * 返回的 prompt 已按「硬约束 → 内容段」的顺序拼接；调用方直接追加到 system prompt 即可。
 */
export function assembleTeachingContext(input: TeachingContextInput): TeachingContextResult {
	const mode = input.mode
	const budget = Math.max(0, Math.floor(input.budget ?? TEACHING_CONTEXT_BUDGET))
	const dropped: string[] = []
	const sections: TeachingContextSection[] = []

	let hardConstraint: TeachingContextSection | null = null
	if (mode === "experiment") {
		hardConstraint = {
			name: "constraint",
			label: SECTION_LABELS.constraint,
			content: EXPERIMENT_HARD_CONSTRAINT,
			chars: codePointLength(EXPERIMENT_HARD_CONSTRAINT),
			truncated: false,
			dropped: false,
		}
	}

	if (mode === "free") {
		// 自由模块：教材索引无配额（它是固定基础设施，不属于预算内容），检索片段用 recall 配额。
		const indexSection = buildSection("index", normalizeText(input.index), Number.MAX_SAFE_INTEGER, dropped)
		if (indexSection) {
			sections.push(indexSection)
		}
		const recallAllowance = Math.min(TEACHING_CONTEXT_QUOTAS.recall, budget)
		const recallSection = buildSection("recall", normalizeText(input.recall), recallAllowance, dropped)
		if (recallSection) {
			sections.push(recallSection)
		}
	} else {
		// 实验模式：按固定优先级 guide → attachments → template → recall 分配预算。
		let remaining = budget
		const candidates: Array<{ name: keyof typeof TEACHING_CONTEXT_QUOTAS; raw: string }> = [
			{ name: "guide", raw: normalizeText(input.guide) },
			{ name: "attachments", raw: normalizeAttachments(input.attachments) },
			{ name: "template", raw: normalizeText(input.template) },
			{ name: "recall", raw: normalizeText(input.recall) },
		]
		for (const candidate of candidates) {
			const allowance = Math.min(TEACHING_CONTEXT_QUOTAS[candidate.name], remaining)
			const section = buildSection(candidate.name, candidate.raw, allowance, dropped)
			if (section) {
				sections.push(section)
				remaining -= section.chars
			}
		}
	}

	const totalChars = sections.reduce((sum, section) => sum + section.chars, 0)
	const promptParts: string[] = []
	if (hardConstraint) {
		promptParts.push(renderSection(hardConstraint))
	}
	for (const section of sections) {
		promptParts.push(renderSection(section))
	}

	return {
		sections,
		hardConstraint,
		totalChars,
		dropped,
		budget,
		prompt: promptParts.join("\n\n"),
	}
}

/** 按段名取内容段，供集成层按需读取（例如只取模板代码）。 */
export function findTeachingContextSection(result: TeachingContextResult, name: string): TeachingContextSection | undefined {
	if (result.hardConstraint?.name === name) {
		return result.hardConstraint
	}
	return result.sections.find((section) => section.name === name)
}

/**
 * 把「第 N 次索要完整实现」触发后的行为阶梯转成 system prompt 追加段（P1-6 与 P1-5 的衔接）。
 *
 * 说明：demand 阶梯的计数与判定放在 TeachingSessionMode（bumpDemandCounter / shouldReleaseFullCode 等），
 * 这里只负责生成「放行」文本，保证纯函数、可单测。
 */
export function freeModeReleasePromptSection(): string {
	return [
		"## 本次放行：可提供完整实现",
		"学生已连续第 3 次明确索要完整实现，本次可以给出可运行代码，但必须遵守：",
		"1. 代码按逻辑逐段添加中文注释（逐段中文注释，解释每段的作用与关键变量）；",
		"2. 在代码末尾列出「这段代码的关键点」与「你需要自己改的地方」两部分清单，方便学生自己动手修改验证。",
	].join("\n")
}

export function experimentPseudoCodePromptSection(): string {
	return [
		"## 本次放行：可提供伪代码",
		"学生已连续第 4 次明确索要实现，本次可以给伪代码（用中文描述逻辑步骤和变量流转），",
		"但仍不得给出可直接运行的完整实现，也不能把伪代码写成逐行可抄的成品代码。",
	].join("\n")
}

// 供集成层判断「学生消息是否本身就是索要完整实现 / 自己贴出完整实现」。
// 复用 student-analytics 既有判定，避免再维护一份关键词表。
export { isCompleteImplDemand, detectFullImplementation }
