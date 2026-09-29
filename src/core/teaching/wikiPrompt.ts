/**
 * 生成注入到 system prompt 的 wiki 相关文本（v2.13）
 *
 * 与旧的 `LLMWikiService.buildSystemPrompt()` 的区别：**不再注入全文**，只注入
 *   ① 认知边界约束（必须保留，见 spec §D6 的必需项）
 *   ② 资料索引（有哪些资料可查 → 提高检索命中率）
 *   ③ 检索状态（MCP 不可用时明确告知，而不是退回全文注入）
 *
 * 为什么认知边界约束必须保留：检索边界只能拦住"资料没发布就查不到"，
 * 拦不住模型"凭通用知识超纲作答"。这条约束是 L2 防线。
 */
import { clampWeek } from "./mcp/args"

export interface WikiIndexGroup {
	week: number
	titles: string[]
}

export interface WikiPromptOptions {
	week: number
	index: WikiIndexGroup[]
	mcpAvailable: boolean
}

/** 索引段的字符上限：防止索引退化成"另一种全文注入" */
const MAX_INDEX_CHARS = 2400

/** 每组最多列出的标题数 */
const MAX_TITLES_PER_GROUP = 8

export function buildWikiSystemPrompt(opts: WikiPromptOptions): string {
	const week = clampWeek(opts.week)
	const parts: string[] = []

	// ① 认知边界约束（永远保留，包括 MCP 不可用时）
	parts.push(
		[
			`# 认知边界约束（不可违反）`,
			`1. 你只能引用通过 search_wiki / read_wiki_chunk 检索到的资料作为答疑依据。`,
			`2. 检索结果为空，说明该知识点尚未在当前教学进度内发布：`,
			`   - 不要展开讲解其具体用法`,
			`   - 应明确告知「该知识点将在后续周次讲解」，并给出当前进度内的相关基础`,
			`3. 严禁使用超出第 ${week} 周的高级语法、设计模式或库函数。`,
		].join("\n"),
	)

	// ③ MCP 不可用：明确声明状态，并**在此收束**（不退回全文注入）
	if (!opts.mcpAvailable) {
		parts.push(
			[
				`# 资料检索状态`,
				`⚠️ 课程资料检索服务当前不可用，你无法查询教师发布的资料。`,
				`请基于通用知识作答，并明确告知学生「当前无法引用课程资料」。`,
			].join("\n"),
		)
		return parts.join("\n\n")
	}

	// ② 资料索引（只含元数据；控制长度，避免退化成"全文注入"）
	const lines: string[] = []
	let used = 0
	for (const g of opts.index.slice().sort((a, b) => a.week - b.week)) {
		const line = `- 第 ${g.week} 周：${g.titles.slice(0, MAX_TITLES_PER_GROUP).join(" / ")}`
		if (used + line.length > MAX_INDEX_CHARS) {
			lines.push(`- …（后续索引已省略）`)
			break
		}
		lines.push(line)
		used += line.length
	}

	parts.push(`# 资料索引（可用资料一览）\n${lines.length > 0 ? lines.join("\n") : "（当前进度暂无资料）"}`)

	return parts.join("\n\n")
}
