/**
 * 实验指导书生成（P1-4）
 *
 * 输入：任务标题/要求、教师附件（指导书原文）、模板代码、教材检索片段。
 * 输出：一份**只给方向、不给完整实现**的 `GUIDE.md`。
 *
 * 为什么单独成文件：约束校验（不许整段可运行代码）与降级模板是纯逻辑，
 * 面板/管理器都不该承担；而且这两条恰恰是模型最容易越界的地方，必须可单测。
 */

/** 生成请求的最大输入（防止把整本教材塞进 prompt） */
export const MAX_GUIDE_SOURCE_CHARS = 12000
/** 教材检索片段最多带几段 */
export const MAX_GUIDE_SNIPPETS = 3
/** 单段片段截断 */
export const MAX_SNIPPET_CHARS = 600

export interface GuideRequest {
	assignmentTitle: string
	assignmentDescription?: string
	/** 教师提供的实验指导书正文（可能为空） */
	teacherGuide?: string
	/** 任务模板代码（学生拿到的那份，可能为空） */
	templateCode?: string
	/** 教材检索片段（正文） */
	snippets?: string[]
}

/** 违禁词：出现即说明模型在越界（实验模式不允许完整实现） */
const FORBIDDEN_PHRASES = ["完整代码", "完整实现", "直接复制以下", "复制下面的代码"]

export interface GuideViolation {
	kind: "code_block" | "forbidden_phrase" | "empty"
	detail: string
}

export interface GuideValidation {
	ok: boolean
	violations: GuideViolation[]
	/** 去掉越界代码块后的正文（ok 为 false 时也应使用它，别整份丢掉） */
	sanitized: string
}

function clip(text: string, max: number): string {
	const t = (text ?? "").trim()
	return t.length > max ? `${t.slice(0, max)}\n…（已截断）` : t
}

/**
 * 组装 prompt。
 *
 * 与出题 prompt 一样，把「不许给完整实现」写成**硬约束 + 可验证的格式要求**
 * （四段小标题），否则模型很容易写成一整篇带代码的教程。
 */
export function buildGuidePrompt(req: GuideRequest): { system: string; user: string } {
	const system = [
		"你是一位实验课助教，正在为学生撰写实验指导书。",
		"硬约束（违反即作废）：",
		"1. 只给方向、思路与检查点，**不得给出任何可直接运行的完整代码**，也不得贴出整段函数实现。",
		"2. 允许少量 Python 语法示意（不超过 3 行、且不能是题目答案），更推荐用文字描述步骤。",
		"3. 不要复述教师的指导书原文，要把它整理成学生能照着做的步骤。",
		"4. 面向学生使用第二人称，中文，专业术语保留英文原文。",
		"5. 输出 Markdown，必须依次包含四个二级标题：## 实验目标、## 涉及知识点、## 实验步骤、## 自检与提交。",
		"只输出 Markdown 正文本身，不要加任何前后解释、不要用代码围栏包裹整份文档。",
	].join("\n")

	const parts: string[] = [`## 实验任务\n标题：${req.assignmentTitle}`]
	if (req.assignmentDescription?.trim()) {
		parts.push(`任务要求：\n${clip(req.assignmentDescription, 3000)}`)
	}
	if (req.teacherGuide?.trim()) {
		parts.push(`## 教师提供的指导书（需整理，不要照抄）\n${clip(req.teacherGuide, MAX_GUIDE_SOURCE_CHARS)}`)
	}
	if (req.templateCode?.trim()) {
		parts.push(`## 学生已拿到的模板代码（不要在指导书里重写它）\n\`\`\`\n${clip(req.templateCode, 3000)}\n\`\`\``)
	}
	const snippets = (req.snippets ?? [])
		.map((s) => clip(s, MAX_SNIPPET_CHARS))
		.filter(Boolean)
		.slice(0, MAX_GUIDE_SNIPPETS)
	if (snippets.length > 0) {
		parts.push(`## 相关教材片段（可引用其术语与结论）\n${snippets.join("\n\n")}`)
	}
	parts.push("请按硬约束撰写这份实验指导书。")
	return { system, user: parts.join("\n\n") }
}

/**
 * 校验生成的指导书。
 *
 * 判定「整段可运行代码」：markdown 围栏里**非注释、非空行 ≥ 5 行**即视为完整实现片段。
 * 少于 5 行按允许的「语法示意」处理（例如 `for i in range(3):` 一行）。
 */
export function validateGuide(text: string): GuideValidation {
	const violations: GuideViolation[] = []
	const raw = (text ?? "").trim()
	if (!raw) {
		return { ok: false, violations: [{ kind: "empty", detail: "模型返回空内容" }], sanitized: "" }
	}

	const lowered = raw.toLowerCase()
	for (const phrase of FORBIDDEN_PHRASES) {
		if (lowered.includes(phrase.toLowerCase())) {
			violations.push({ kind: "forbidden_phrase", detail: `出现违禁表述「${phrase}」` })
		}
	}

	// 找出所有围栏块，逐个判断「可运行代码行数」
	const fence = /```[^\n]*\n([\s\S]*?)```/g
	let sanitized = raw
	let match: RegExpExecArray | null
	while ((match = fence.exec(raw)) !== null) {
		const body = match[1] ?? ""
		const codeLines = body
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("//"))
		if (codeLines.length >= 5) {
			violations.push({
				kind: "code_block",
				detail: `代码围栏内有 ${codeLines.length} 行可运行代码（实验模式不允许完整实现）`,
			})
			sanitized = sanitized.replace(match[0], "> ⚠️ 原稿此处给出了完整实现，已移除。请按上面的步骤自己写。")
		}
	}

	return { ok: violations.length === 0, violations, sanitized: sanitized.trim() }
}

/**
 * 降级模板：模型不可用/连续越界时使用。
 *
 * 刻意保留「实验步骤」的空位让学生自己填 —— 模板的价值是结构，不是答案。
 */
export function buildFallbackGuide(req: GuideRequest): string {
	const title = req.assignmentTitle || "本次实验"
	const requirement = clip(req.assignmentDescription ?? "", 1200) || "（教师未填写文字要求，请参考附件中的实验指导书）"
	const lines = [
		`# ${title} · 实验指导`,
		"",
		"> 本文件由助手根据任务材料自动起草（模型输出不可用时使用通用结构）。",
		"",
		"## 实验目标",
		"",
		`- 完成「${title}」要求的功能，并能解释你的实现思路。`,
		"- 能定位并说明实验过程中遇到的报错原因。",
		"",
		"## 涉及知识点",
		"",
		req.teacherGuide?.trim()
			? `- 见教师附件《实验指导书》与任务要求（共 ${req.teacherGuide.trim().length} 字）。`
			: "- 见任务要求与相关教材章节。",
		"",
		"## 任务要求",
		"",
		requirement,
		"",
		"## 实验步骤",
		"",
		"1. 读题：用自己的话写下输入、输出与边界情况。",
		"2. 拆解：把任务拆成 2~3 个可单独验证的小步骤。",
		"3. 实现：先写最直接的做法，跑通后再考虑优化。",
		"4. 调试：出错时先读报错类型与行号，再定位变量取值。",
		"5. 复盘：记录你改动的关键点，准备回答提交时的思考题。",
		"",
		"## 自检与提交",
		"",
		"- [ ] 结果符合任务要求，边界输入（空、0、负数、超长）都试过。",
		"- [ ] 代码里的变量名能说明含义。",
		"- [ ] 能说清每段代码为什么这么写。",
		"- [ ] 完成后点击侧栏「提交任务」，回答思考题并确认上传。",
	].join("\n")
	return lines
}

/** 把模型输出规范成 `GUIDE.md` 正文（去整份围栏、补标题、保证以换行结尾） */
export function normalizeGuideMarkdown(text: string, title: string): string {
	const body = (text ?? "").trim().replace(/^```(?:markdown|md)?\n([\s\S]*?)```$/i, "$1").trim()
	if (!body) {
		return ""
	}
	const withTitle = /^#\s+/m.test(body) ? body : `# ${title} · 实验指导\n\n${body}`
	return `${withTitle}\n`
}
