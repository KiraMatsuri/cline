/**
 * 任务分类器 - 基于规则的学生任务意图识别
 * Task Classifier - Rule-based student task intent recognition
 */

import type { TaskCategory } from "./types"

/**
 * 分类规则定义
 */
interface ClassificationRule {
	category: TaskCategory
	keywords: string[]
	/** 权重，用于多规则匹配时的优先级 */
	weight: number
}

/**
 * TaskClassifier - 任务分类器
 * 将学生输入的任务描述分类为预定义的类别
 */
export class TaskClassifier {
	private readonly rules: ClassificationRule[] = [
		{
			category: "algorithm",
			keywords: [
				"排序",
				"sort",
				"merge sort",
				"quick sort",
				"算法",
				"complexity",
				"时间复杂度",
				"空间复杂度",
				"递归",
				"recursion",
				"动态规划",
				"dp",
				"二分",
				"binary search",
				"图论",
				"graph",
				"树",
				"tree",
				"链表",
				"linked list",
				"栈",
				"stack",
				"队列",
				"queue",
				"哈希",
				"hash",
				"bfs",
				"dfs",
				"sorting",
				"sorted",
				"trees",
				"queues",
				"hashing",
				"graphs",
			],
			weight: 10,
		},
		{
			category: "debugging",
			keywords: [
				"报错",
				"error",
				"exception",
				"stack trace",
				"bug",
				"crash",
				"失败",
				"fail",
				"不工作",
				"not working",
				"修复",
				"fix",
				"调试",
				"debug",
				"segfault",
				"segmentation fault",
				"编译错误",
				"compile error",
				"运行错误",
				"runtime error",
				"为什么不行",
				"为什么报错",
				"errors",
				"failed",
				"failure",
				"debugging",
				"crashes",
				"fixed",
			],
			weight: 9,
		},
		{
			category: "explanation",
			keywords: [
				"解释",
				"explain",
				"原理",
				"why",
				"how does",
				"原理是什么",
				"什么是",
				"what is",
				"为什么",
				"怎么理解",
				"含义",
				"meaning",
				"概念",
				"concept",
				"区别",
				"difference",
				"比较",
				"compare",
				"explains",
				"explained",
				"explanation",
				"differences",
			],
			weight: 8,
		},
		{
			category: "code_generation",
			keywords: [
				"写一个",
				"write",
				"实现",
				"implement",
				"生成",
				"generate",
				"创建",
				"create",
				"编写",
				"code",
				"帮我写",
				"帮我实现",
				"给我一个",
				"give me",
				"写个",
				"写段",
				"writing",
				"writes",
				"implementing",
				"generated",
				"creating",
			],
			weight: 7,
		},
		{
			category: "refactoring",
			keywords: [
				"重构",
				"refactor",
				"优化",
				"optimize",
				"改进",
				"improve",
				"简化",
				"simplify",
				"清理",
				"clean",
				"整理",
				"性能",
				"performance",
				"refactoring",
				"optimized",
				"optimizing",
				"improved",
				"improving",
			],
			weight: 6,
		},
		{
			category: "testing",
			keywords: [
				"测试",
				"test",
				"单元测试",
				"unit test",
				"用例",
				"test case",
				"断言",
				"assert",
				"mock",
				"覆盖率",
				"coverage",
				"testing",
				"tests",
				"assertion",
				"mocks",
			],
			weight: 5,
		},
		{
			category: "language_request",
			keywords: [
				"python",
				"java",
				"c++",
				"cpp",
				"javascript",
				"js",
				"ts",
				"typescript",
				"用 python",
				"用java",
				"用c++",
				"c语言",
				"c#",
				"csharp",
				"go",
				"golang",
				"rust",
				"ruby",
				"php",
				"swift",
				"kotlin",
				"python3",
				"nodejs",
			],
			weight: 4,
		},
	]

	/**
	 * 对输入文本进行分类
	 * @param text 学生输入的任务描述
	 * @returns 任务分类
	 */
	public classify(text?: string): TaskCategory {
		if (!text || text.trim().length === 0) {
			return "other"
		}

		const lowerText = text.toLowerCase()
		const matchedRules: Array<{ category: TaskCategory; weight: number; matchCount: number }> = []

		for (const rule of this.rules) {
			const matchCount = this.countMatches(lowerText, rule.keywords)
			if (matchCount > 0) {
				matchedRules.push({
					category: rule.category,
					weight: rule.weight,
					matchCount,
				})
			}
		}

		if (matchedRules.length === 0) {
			return "other"
		}

		// 按 (matchCount * weight) 降序排序，选择得分最高的分类
		matchedRules.sort((a, b) => b.matchCount * b.weight - a.matchCount * a.weight)

		return matchedRules[0].category
	}

	/**
	 * 获取所有匹配的分类及其置信度
	 * @param text 输入文本
	 * @returns 所有匹配的分类和得分
	 */
	public classifyWithScores(text?: string): Array<{ category: TaskCategory; score: number }> {
		if (!text || text.trim().length === 0) {
			return [{ category: "other", score: 0 }]
		}

		const lowerText = text.toLowerCase()
		const results: Array<{ category: TaskCategory; score: number }> = []

		for (const rule of this.rules) {
			const matchCount = this.countMatches(lowerText, rule.keywords)
			if (matchCount > 0) {
				results.push({
					category: rule.category,
					score: matchCount * rule.weight,
				})
			}
		}

		if (results.length === 0) {
			return [{ category: "other", score: 0 }]
		}

		return results.sort((a, b) => b.score - a.score)
	}

	/**
	 * 计算文本中匹配的关键词数量。
	 *
	 * 【F5/F11】ASCII 拉丁词必须用**词边界**匹配，否则 `go` 会命中 `algorithm`/`going`、
	 * `js` 会命中 `json`，制造假分类（实测：助手输出被误判为 `language_request`）。
	 * CJK 没有词边界概念，保持 `includes`。
	 *
	 * ⚠️ 不能直接用 `\b`：`c++` / `c#` 以非单词字符结尾，`\bc\+\+\b` 在任何文本上都不成立。
	 * 因此按首/尾字符是否为 `\w` **分别**加边界断言。
	 */
	private countMatches(text: string, keywords: string[]): number {
		let count = 0
		for (const keyword of keywords) {
			const k = keyword.toLowerCase()
			if (!/^[a-z0-9+#.]+$/.test(k)) {
				// CJK 或多词短语：无词边界概念
				if (text.includes(k)) count++
				continue
			}
			const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			const left = /^\w/.test(k) ? "(?<![\\w])" : ""
			const right = /\w$/.test(k) ? "(?![\\w])" : ""
			if (new RegExp(`${left}${esc}${right}`, "i").test(text)) count++
		}
		return count
	}

	/**
	 * 添加自定义分类规则
	 * @param rule 分类规则
	 */
	public addRule(rule: ClassificationRule): void {
		this.rules.push(rule)
	}

	/**
	 * 获取所有支持的分类类别
	 */
	public getSupportedCategories(): TaskCategory[] {
		const categories = new Set<TaskCategory>(this.rules.map((r) => r.category))
		categories.add("other")
		return Array.from(categories)
	}
}

// 导出单例实例，方便直接使用
export const taskClassifier = new TaskClassifier()
