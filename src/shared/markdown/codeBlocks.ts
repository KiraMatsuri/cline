export interface CodeBlock {
	/** 原始片段，含首尾围栏与语言标签 */
	raw: string
	/** 语言标签（无标签时为空串） */
	lang: string
	/** 去掉首尾围栏与语言标签后的内容 */
	inner: string
	/** 内容中“非空行”的条数 */
	lineCount: number
}

/** 匹配成对闭合的 fenced 代码块。刻意不匹配未闭合的围栏（流式中间态不应当作完整代码块处理） */
const FENCED = /```[^\n]*\n?[\s\S]*?```/g

export function parseFencedCodeBlocks(text: string): CodeBlock[] {
	if (!text) {
		return []
	}
	const out: CodeBlock[] = []
	for (const raw of text.match(FENCED) ?? []) {
		// 去掉首尾围栏行：前缀（围栏+语言标签）与后缀（围栏行本身，含其行首换行）。
		// 后缀的 \n? 保证 inner 不以换行结尾（接口约定见测试「解析语言标签与内容行数」）。
		const inner = raw.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "")
		const header = raw.match(/^```([^\n]*)/)
		out.push({
			raw,
			lang: (header?.[1] ?? "").trim(),
			inner,
			lineCount: inner.split("\n").filter((l) => l.trim().length > 0).length,
		})
	}
	return out
}
