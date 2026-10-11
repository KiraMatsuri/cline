/**
 * 内容分析器 - 学生输入特征提取
 * Content Analyzer - Student input feature extraction
 */

import { parseFencedCodeBlocks } from "@/shared/markdown/codeBlocks"
import { stripLeakedToolCallMarkup } from "@/shared/markdown/toolCallMarkup"
import type { ContentAnalysisResult, LanguageHint } from "./types"

/**
 * 语言检测规则
 */
interface LanguagePattern {
	language: LanguageHint
	patterns: RegExp[]
	keywords: string[]
}

/**
 * ContentAnalyzer - 内容分析工具类
 * 用于分析学生输入的特征，包括：
 * - 判断是否包含代码
 * - 统计输入长度
 * - 推断编程语言类型
 */
export class ContentAnalyzer {
	/**
	 * 代码块检测正则表达式
	 * 匹配 Markdown 代码块 (```code```) 和缩进代码块
	 */
	private readonly codeBlockPatterns: RegExp[] = [
		/```[\s\S]*?```/g, // Markdown fenced code blocks
		/`[^`\n]+`/g, // Inline code
		/^[ \t]{4,}\S+/gm, // Indented code blocks (4+ spaces)
	]

	/**
	 * 代码特征正则表达式
	 * 用于检测常见的代码模式
	 */
	private readonly codeIndicators: RegExp[] = [
		/\b(function|def|class|import|from|const|let|var|return|if|else|for|while|try|catch)\b/,
		/[{}[\]();]/g, // 括号和分号
		/\w+\s*\([^)]*\)\s*[{:]/g, // 函数定义模式
		/^\s*(public|private|protected|static)\s+/gm, // 访问修饰符
		/[a-zA-Z_]\w*\s*=\s*.+;?\s*$/gm, // 赋值语句
		/#include\s*<.*>/g, // C/C++ include
		/import\s+[\w.]+/g, // Java/Python import
		/using\s+namespace/g, // C++ namespace
	]

	/**
	 * 语言特征模式
	 */
	private readonly languagePatterns: LanguagePattern[] = [
		{
			language: "python",
			patterns: [
				/\bdef\s+\w+\s*\([^)]*\)\s*:/,
				/\bclass\s+\w+.*:/,
				/\bimport\s+\w+/,
				/\bfrom\s+\w+\s+import/,
				/\bprint\s*\(/,
				/\bself\./,
				/\bif\s+.*:\s*$/m,
				/\bfor\s+\w+\s+in\s+/,
				/\belif\s+/,
				/\b(True|False|None)\b/,
			],
			keywords: ["python", "py", "pip", "django", "flask", "numpy", "pandas", "pytorch", "tensorflow"],
		},
		{
			language: "java",
			patterns: [
				/\bpublic\s+(static\s+)?class\s+\w+/,
				/\bpublic\s+static\s+void\s+main/,
				/\bSystem\.out\.print/,
				/\bimport\s+java\./,
				/\bnew\s+\w+\s*\(/,
				/\b(String|int|boolean|double|float)\s+\w+/,
				/@Override/,
				/\bextends\s+\w+/,
				/\bimplements\s+\w+/,
			],
			keywords: ["java", "jdk", "jvm", "maven", "gradle", "spring", "springboot"],
		},
		{
			language: "cpp",
			patterns: [
				/#include\s*<.*>/,
				/\busing\s+namespace\s+std/,
				/\bstd::/,
				/\bcout\s*<</,
				/\bcin\s*>>/,
				/\bint\s+main\s*\(/,
				/\bvector\s*</,
				/\btemplate\s*</,
				/\bclass\s+\w+\s*{/,
				/::\w+/,
			],
			keywords: ["c++", "cpp", "g++", "gcc", "stl", "iostream"],
		},
		{
			language: "c",
			patterns: [
				/#include\s*<stdio\.h>/,
				/#include\s*<stdlib\.h>/,
				/\bprintf\s*\(/,
				/\bscanf\s*\(/,
				/\bmalloc\s*\(/,
				/\bfree\s*\(/,
				/\bint\s+main\s*\(\s*(void|int)/,
				/\bstruct\s+\w+\s*{/,
			],
			keywords: ["c语言", "clang", "gcc"],
		},
		{
			language: "javascript",
			patterns: [
				/\bfunction\s+\w+\s*\(/,
				/\bconst\s+\w+\s*=/,
				/\blet\s+\w+\s*=/,
				/\bvar\s+\w+\s*=/,
				/=>\s*{/,
				/\bconsole\.log\s*\(/,
				/\bdocument\./,
				/\bwindow\./,
				/\basync\s+function/,
				/\bawait\s+/,
				/\bexport\s+(default\s+)?/,
				/\brequire\s*\(/,
			],
			keywords: ["javascript", "js", "node", "nodejs", "npm", "react", "vue", "angular"],
		},
		{
			language: "typescript",
			patterns: [
				/:\s*(string|number|boolean|any|void)\b/,
				/\binterface\s+\w+\s*{/,
				/\btype\s+\w+\s*=/,
				/<\w+>/,
				/\bas\s+\w+/,
				/\bimport\s+.*\s+from\s+['"][^'"]+['"]/,
				/\bexport\s+interface/,
				/\bexport\s+type/,
			],
			keywords: ["typescript", "ts", "tsx", "tsc"],
		},
	]

	/**
	 * 分析输入内容
	 * @param text 输入文本
	 * @returns 内容分析结果
	 */
	public analyze(text?: string): ContentAnalysisResult {
		if (!text) {
			return {
				contentLength: 0,
				hasCode: false,
				hasCodeBlock: false,
				hasInlineCode: false,
				languageHint: "unknown",
				codeBlockCount: 0,
			}
		}

		// ★ 先剔除模型泄漏的工具调用标记再判定。
		// 实测（taskId=1790691098981 等 4 个任务）：DSML 标记里的 `{}` 与 `name="…"`
		// 恰好凑满 codeIndicators 的 2 条阈值，导致"纯工具调用回合"被判成含代码，
		// 直接把 assistantCodeStreak 推到触发阈值。
		const scrubbed = stripLeakedToolCallMarkup(text)

		const contentLength = this.getContentLength(text)
		const codeBlockCount = this.countCodeBlocks(scrubbed)
		const hasCodeBlock = this.detectCodeBlock(scrubbed)
		const hasInlineCode = this.detectInlineCode(scrubbed)
		// 【② 已决 = B1】所有判定统一基于剔除工具标记后的文本
		const hasCode = this.detectCode(scrubbed)
		const languageHint = this.inferLanguage(scrubbed)

		return {
			contentLength,
			hasCode,
			hasCodeBlock,
			hasInlineCode,
			languageHint,
			codeBlockCount,
		}
	}

	/**
	 * 计算内容长度（字符数）
	 */
	public getContentLength(text: string): number {
		return text.length
	}

	/**
	 * 统计代码块数量
	 */
	public countCodeBlocks(text: string): number {
		return parseFencedCodeBlocks(text).length
	}

	/**
	 * 是否含 fenced 代码块（```…```）
	 */
	public detectCodeBlock(text: string): boolean {
		return this.countCodeBlocks(text) > 0
	}

	/**
	 * 是否含行内代码（单反引号包裹）
	 */
	public detectInlineCode(text: string): boolean {
		return /`[^`\n]+`/.test(text)
	}

	/**
	 * 检测文本中是否包含代码
	 */
	public detectCode(text: string): boolean {
		// 检查是否有 Markdown 代码块
		for (const pattern of this.codeBlockPatterns) {
			if (pattern.test(text)) {
				// 重置正则表达式的 lastIndex
				pattern.lastIndex = 0
				return true
			}
			pattern.lastIndex = 0
		}

		// 检查代码特征指标
		let indicatorCount = 0
		for (const indicator of this.codeIndicators) {
			if (indicator.test(text)) {
				indicatorCount++
				indicator.lastIndex = 0
			}
			indicator.lastIndex = 0
		}

		// 如果有多个代码指标，认为包含代码
		return indicatorCount >= 2
	}

	/**
	 * 推断编程语言类型
	 */
	public inferLanguage(text: string): LanguageHint {
		if (!text) {
			return "unknown"
		}

		const lowerText = text.toLowerCase()
		const scores: Map<LanguageHint, number> = new Map()

		for (const langPattern of this.languagePatterns) {
			let score = 0

			// 检查关键词
			for (const keyword of langPattern.keywords) {
				if (lowerText.includes(keyword)) {
					score += 2
				}
			}

			// 检查代码模式
			for (const pattern of langPattern.patterns) {
				if (pattern.test(text)) {
					score += 3
					pattern.lastIndex = 0
				}
				pattern.lastIndex = 0
			}

			if (score > 0) {
				scores.set(langPattern.language, score)
			}
		}

		if (scores.size === 0) {
			return "unknown"
		}

		// 返回得分最高的语言
		let maxScore = 0
		let bestLanguage: LanguageHint = "unknown"

		for (const [language, score] of scores) {
			if (score > maxScore) {
				maxScore = score
				bestLanguage = language
			}
		}

		return bestLanguage
	}

	/**
	 * 检测是否为纯代码请求（主要是代码，很少描述）
	 */
	public isPureCodeSubmission(text: string): boolean {
		if (!text) {
			return false
		}

		// 移除代码块后检查剩余文本长度
		const withoutCodeBlocks = text
			.replace(/```[\s\S]*?```/g, "")
			.replace(/`[^`]+`/g, "")
			.trim()

		// 如果移除代码块后剩余文本很少，可能是纯代码提交
		const codeRatio = 1 - withoutCodeBlocks.length / text.length

		return codeRatio > 0.7
	}

	/**
	 * 提取代码块内容
	 */
	public extractCodeBlocks(text: string): string[] {
		const blocks: string[] = []
		const matches = text.matchAll(/```(?:\w+)?\n?([\s\S]*?)```/g)

		for (const match of matches) {
			if (match[1]) {
				blocks.push(match[1].trim())
			}
		}

		return blocks
	}
}

// 导出单例实例
export const contentAnalyzer = new ContentAnalyzer()
