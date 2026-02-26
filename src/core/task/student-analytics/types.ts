/**
 * 学生编程行为数据采集 - 类型定义
 * Student Programming Behavior Analytics - Type Definitions
 */

/**
 * 任务分类类型
 */
export type TaskCategory =
	| "algorithm" // 算法相关
	| "debugging" // 调试/报错
	| "explanation" // 解释/原理
	| "language_request" // 语言相关请求
	| "code_generation" // 代码生成
	| "refactoring" // 重构
	| "testing" // 测试相关
	| "other" // 其他

/**
 * 编程语言提示
 */
export type LanguageHint = "cpp" | "python" | "java" | "javascript" | "typescript" | "c" | "unknown"

/**
 * 日志事件类型
 */
export type LogEventType =
	| "task_start" // 新任务开始
	| "turn_message" // 用户/AI 在同一任务内发送的消息
	| "code_edit" // 学生代码编辑行为
	| "file_save" // 学生保存文件行为
	| "adoption_infer" // AI 建议采纳推断结果

/**
 * 消息角色
 */
export type MessageRole = "user" | "assistant" | "system"

/**
 * AI 建议类型（用于 assistant turn）
 */
export type SuggestionType =
	| "code_generation" // AI 生成了代码
	| "code_edit" // AI 修改了代码（replace_in_file / apply_patch）
	| "explanation" // AI 纯文本解释
	| "question" // AI 反问用户（ask_followup_question）
	| "completion" // AI 完成任务（attempt_completion）
	| "command" // AI 执行命令（execute_command）
	| "mixed" // AI 混合了多种工具
	| "other" // 其他

/**
 * AI 建议采纳状态
 */
export type AdoptionStatus =
	| "adopted" // 已采纳（在 AI 回复后有相关代码编辑或文件保存）
	| "rejected" // 未采纳（用户追问了不同问题 / 长时间无行动）
	| "continued" // 继续追问（用户在该建议基础上继续对话）
	| "unknown" // 无法判断

/**
 * 学生交互日志数据结构
 * Unified log structure for student interaction data
 */
export interface StudentInteractionLog {
	/** ISO 8601 时间戳 */
	ts: string
	/** 任务唯一标识 */
	taskId: string
	/** 事件类型 */
	eventType: LogEventType
	/** 消息角色 */
	role: MessageRole
	/** 任务分类 */
	category: TaskCategory
	/** 输入内容长度（字符数） */
	contentLength: number
	/** 是否包含代码 */
	hasCode: boolean
	/** 推断的编程语言 */
	languageHint: LanguageHint
	/** 附带图片数量 */
	imageCount: number
	/** 附带文件数量 */
	fileCount: number
	/** 对话轮次索引（当前任务内第几次交互） */
	turnIndex: number
	/** 原始输入内容（可选，用于离线分析） */
	rawContent?: string
	// ===== 2.0 新增字段 =====
	/** AI 建议类型（仅 role=assistant 时有值） */
	suggestionType?: SuggestionType
	/** AI 使用的工具列表（仅 role=assistant 时有值） */
	toolsUsed?: string[]
	/** 代码编辑涉及的文件路径（仅 eventType=code_edit/file_save 时有值） */
	filePath?: string
	/** 代码编辑变更量（字符差异，仅 eventType=code_edit 时有值） */
	changeDelta?: number
	/** AI 建议采纳推断（仅 role=assistant 时，会在后续事件中回填） */
	adoptionStatus?: AdoptionStatus
}

/**
 * 内容分析结果
 */
export interface ContentAnalysisResult {
	/** 内容长度 */
	contentLength: number
	/** 是否包含代码 */
	hasCode: boolean
	/** 推断的语言类型 */
	languageHint: LanguageHint
	/** 检测到的代码片段数量 */
	codeBlockCount: number
}

/**
 * 日志统计摘要
 */
export interface LogStatsSummary {
	/** 总任务数 */
	totalTasks: number
	/** 各分类数量分布 */
	categoryDistribution: Record<TaskCategory, number>
	/** 平均输入长度 */
	averageContentLength: number
	/** 包含代码的任务比例 */
	codeInclusionRate: number
	/** 各语言分布 */
	languageDistribution: Record<LanguageHint, number>
	/** 时间范围 */
	timeRange: {
		start: string
		end: string
	}
}

// =============================================
// 学生能力画像 (Student Profile) 类型定义
// =============================================

/**
 * 学习风格分类
 *
 * - Exploratory: 探索型 — 大量多轮对话、尝试多种类别、主动修改代码
 * - Dependent:   依赖型 — 高度依赖 AI 输出、较少自主编辑
 * - Optimizer:   优化型 — 采纳 AI 建议后频繁自主修改和打磨
 * - Debugger:    调试型 — 以调试类任务为主
 * - Balanced:    均衡型 — 各维度表现适中
 */
export type LearningStyle = "Exploratory" | "Dependent" | "Optimizer" | "Debugger" | "Balanced"

/**
 * 学生能力画像
 */
export interface StudentProfile {
	// ---- 基础统计 ----
	/** 唯一任务数 */
	totalTasks: number
	/** 平均每任务轮次数 */
	avgTurnsPerTask: number
	/** 总交互记录数 */
	totalInteractions: number

	// ---- 核心能力指标 (0–1) ----
	/** AI 依赖度 = assistant turns / (user + assistant turns) */
	aiDependencyScore: number
	/** 代码编辑比 = code_edit 次数 / assistant 含代码回复数 */
	codeEditRatio: number
	/** AI 建议采纳率 = adopted / (adopted + rejected + continued) */
	adoptionRate: number
	/** 自主修改率 = 有 code_edit 事件的任务数 / 有 AI 代码输出的任务数 */
	selfModificationRate: number
	/** 调试频率 = debugging 类任务 / 总任务 (对话维度) */
	debuggingFrequency: number
	/** 探索广度 = 使用的不同 category 数 / 所有可用 category 数 */
	explorationBreadth: number

	// ---- 高级维度 ----
	/** 主导任务类别 */
	dominantCategory: TaskCategory | "unknown"
	/** 综合学习风格 */
	learningStyle: LearningStyle
	/** 学习风格置信度 (0–1)；越高说明特征越鲜明 */
	styleConfidence: number

	// ---- 元数据 ----
	/** 画像生成时间 (ISO 8601) */
	generatedAt: string
	/** 分析所覆盖的时间区间 */
	timeRange: { start: string; end: string }
}

// =============================================
// 教学干预 (Teaching Intervention) 类型定义
// =============================================

/**
 * 行为风险规则 ID
 */
export type BehaviorRuleId =
	| "consecutive_code_generation"
	| "no_edit_streak"
	| "high_adoption_low_self_modification"
	| "high_recent_ai_dependency"

/**
 * 干预严重等级
 *
 * - gentle:    温和提示 — 轻微依赖倾向，鼓励式引导
 * - moderate:  中度干预 — 明显依赖模式，提问式引导
 * - strong:    强力干预 — 严重依赖，挑战式引导
 */
export type InterventionSeverity = "gentle" | "moderate" | "strong"

/**
 * 干预消息风格
 *
 * - hint:      提示型 — 简短的学习建议
 * - question:  提问型 — 引导学生思考的问题
 * - challenge: 挑战型 — 给出小任务让学生自主完成
 * - reflection: 反思型 — 引导学生回顾自己的学习过程
 */
export type InterventionStyle = "hint" | "question" | "challenge" | "reflection"

/**
 * 行为风险警报（BehaviorMonitor 输出的结构化警报）
 */
export interface BehaviorAlert {
	/** 触发的规则 ID */
	ruleId: BehaviorRuleId
	/** 人类可读的描述 */
	message: string
	/** 触发时间 (ISO 8601) */
	triggeredAt: string
	/** 相关的量化指标值 */
	metricValue: number
	/** 对应的阈值 */
	threshold: number
}

/**
 * 教学干预消息
 */
export interface InterventionMessage {
	/** 干预消息内容 */
	content: string
	/** 触发的规则 ID */
	ruleId: BehaviorRuleId
	/** 严重等级 */
	severity: InterventionSeverity
	/** 干预风格 */
	style: InterventionStyle
	/** 生成时间 (ISO 8601) */
	generatedAt: string
	/** 冷却到期时间 (ISO 8601)，在该时间之前不再对同一规则触发干预 */
	cooldownUntil: string
}

/**
 * 干预历史记录（用于日志分析）
 */
export interface InterventionRecord {
	/** 干预消息 */
	intervention: InterventionMessage
	/** 所属任务 ID */
	taskId: string
	/** 是否实际注入到对话 */
	injected: boolean
	/** 注入时的对话轮次索引 */
	turnIndex: number
}

/**
 * 干预管理器配置选项
 */
export interface InterventionManagerOptions {
	/** 是否启用干预 */
	enabled?: boolean
	/** 全局冷却时间（毫秒），同一规则两次干预之间的最小间隔 */
	globalCooldownMs?: number
	/** 单个任务内最大干预次数 */
	maxInterventionsPerTask?: number
	/** 连续两次干预之间最少需间隔的对话轮次数 */
	minTurnsBetweenInterventions?: number
	/** 干预风格偏好（默认随机选择） */
	preferredStyle?: InterventionStyle
	/** 是否在 OutputChannel 同时输出干预日志 */
	logToOutputChannel?: boolean
}
