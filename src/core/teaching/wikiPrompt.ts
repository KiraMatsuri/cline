/**
 * 生成注入到 system prompt 的 wiki 相关文本（v3：去周数）
 *
 * 与 v2.13 的区别：教学周概念移除后，注入内容只剩三段职责
 *   ① 认知边界约束（必须保留：检索边界只能拦住"资料没发布就查不到"，
 *      拦不住模型"凭通用知识超纲作答"）
 *   ② 资料索引（有哪些资料可查 → 提高检索命中率；只含标题元数据）
 *   ③ 检索状态（MCP 不可用时明确告知，而不是退回全文注入）
 *
 * 【v3 决策】不再按「第 N 周 / 进度内 / 超纲」分档：
 *   学生看不到周次，模型也没必要知道"教学进度"；改用**资料有无**作为唯一事实来源。
 *   自相矛盾的是：索引里本来就列着全部资料标题，再说"第 N 周之后不可讲"只会让模型
 *   一边看得见标题一边假装不知道。
 */

export interface WikiPromptOptions {
	/** 资料标题（已去重、按周升序；见 LLMWikiService.buildIndexTitles） */
	index: string[]
	mcpAvailable: boolean
}

/** 索引段的字符上限：防止索引退化成"另一种全文注入" */
const MAX_INDEX_CHARS = 2400

export function buildWikiSystemPrompt(opts: WikiPromptOptions): string {
	const parts: string[] = []

	// ① 认知边界约束（永远保留，包括 MCP 不可用时）
	parts.push(
		[
			`# 认知边界约束（不可违反）`,
			`1. 你只能引用通过 search_wiki / read_wiki_chunk 检索到的资料作为**教材依据**；引用时标明资料标题。`,
			`2. 先检索、再回答：学生提问涉及具体知识点时，优先调用 search_wiki；检索为空或资料不足时，`,
			`   可以基于通用知识讲解，但必须明确说明「课程资料中没有对应内容」，`,
			`   并且**不给完整可运行实现**（关键步骤 + 伪代码骨架为上限）。`,
			`3. 讲解以课程资料口径为准；通用知识与资料冲突时，以资料为准并指出差异。`,
			`4. 不要猜测学生的学习阶段：你不知道、也不需要知道他现在学到哪里。`,
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

	// ② 资料索引（只含标题；控制长度）
	// 预算不够时**截断标题列表并显式标注省略**，而不是静默丢弃后半段 ——
	// 让学生看到「还有更多主题」比看到一份"看起来完整其实缺了一半"的索引更安全。
	const lines: string[] = []
	let used = 0
	let omitted = 0
	for (const raw of opts.index) {
		const title = raw.trim()
		if (!title) continue
		const line = `- ${title}`
		if (used + line.length + 1 > MAX_INDEX_CHARS) {
			omitted++
			continue
		}
		lines.push(line)
		used += line.length + 1
	}
	if (omitted > 0) {
		lines.push(`- …（另有 ${omitted} 个主题未列出，可用 search_wiki 检索）`)
	}

	parts.push(
		`# 资料索引（可用资料一览）\n${lines.length > 0 ? lines.join("\n") : "（资料库暂无资料，请基于通用知识作答并说明）"}`,
	)

	return parts.join("\n\n")
}

// ---------------------------------------------------------------------------
// 【v3 · P0-3】预召回片段段
// ---------------------------------------------------------------------------

/** 预召回注入的字符预算（索引 2400 + 预召回 1600 ≈ 4k，见设计文档 §3.3） */
export const MAX_RECALL_CHARS = 1600

/** 单条片段正文的截断长度：给模型"够判断相关性"的量，又不至于吞掉上下文 */
const MAX_RECALL_CHUNK_CHARS = 500

/** 最多注入几条 */
const MAX_RECALL_ITEMS = 3

export interface RecallItem {
	chunkId: string | number
	title: string
	content: string
}

/**
 * 把后端检索到的片段拼成可直接注入的文本块；无有效条目返回 null（调用方保持原样）。
 *
 * 为什么规则段要写「若片段与问题无关，不要强行引用」：预召回是**机械**的相似度匹配，
 * 一定会有误召回；不写这句，模型会拿一段无关资料硬凑答案，比不召回更糟。
 */
export function buildRecallContext(items: RecallItem[], opts: { budget?: number; limit?: number } = {}): string | null {
	const budget = Math.max(200, opts.budget ?? MAX_RECALL_CHARS)
	const limit = Math.max(1, Math.min(opts.limit ?? MAX_RECALL_ITEMS, 10))

	const picked: string[] = []
	const seen = new Set<string>()
	let used = 0
	for (const item of items) {
		if (picked.length >= limit) break
		const content = (item.content ?? "").trim()
		const title = (item.title ?? "").trim()
		const key = `${item.chunkId}|${title}`
		if (!content || seen.has(key)) continue
		seen.add(key)
		const snippet = content.length > MAX_RECALL_CHUNK_CHARS ? `${content.slice(0, MAX_RECALL_CHUNK_CHARS)}…` : content
		const line = `[教材#${item.chunkId}｜${title}] ${snippet}`
		if (used + line.length + 1 > budget) break
		picked.push(line)
		used += line.length + 1
	}
	if (picked.length === 0) return null

	return [
		`## 参考教材片段（自动检索，可能不完整）`,
		...picked,
		`规则：上述片段若与问题相关，必须以此为准并在回答末尾标注来源 (教材: <chunk_id>)；`,
		`若片段与问题无关，不要强行引用，直接说明「教材中暂未找到直接相关内容」。`,
	].join("\n")
}
