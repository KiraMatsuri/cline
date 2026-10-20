/**
 * =============================================================================
 *  bundleTypes — 提交包契约（扩展侧镜像）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【为什么要有这个文件】
 * 提交包是「扩展 → teaching-server」的跨端契约，服务端对应
 * `web-dashboard/teaching-server/src/submission/bundleContract.ts`。
 * 两侧字段必须逐字一致，任何一侧单方面改字段都会让上传静默丢数据；
 * 因此把常量与类型集中在这里，并用 `scripts/verify/contract-check.mjs`
 * 做机械比对（CI 与本地都能跑）。
 *
 * 【一次提交包含什么】
 *   meta   —— JSON 文本字段（学生/任务/题目/答案/日志摘要）
 *   log    —— 工作区 .cline-logs/student_interactions.log 原文
 *   code   —— 任务相关代码文件（可多个），第 i 个的相对路径放在 code_path_<i>
 *
 * 设计文档：docs/design/teaching-submission-bundle-design.md §4/§5
 * =============================================================================
 */

/** 契约版本号，服务端 schema 不匹配会返回 400 META_INVALID */
export const BUNDLE_SCHEMA = "submission-bundle/v1"

/** multipart 分区名（与教学端 BUNDLE_PART_FIELDS 一致） */
export const BUNDLE_PART_FIELDS = {
	meta: "meta",
	log: "log",
	code: "code",
	codePathPrefix: "code_path_",
} as const

/** 服务端硬上限（超了会被 413 拒绝，扩展侧提前截断更友好） */
export const BUNDLE_LIMITS = {
	maxCodeFiles: 20,
	maxCodeFileBytes: 1024 * 1024,
	maxTotalBytes: 25 * 1024 * 1024,
	maxQuestions: 5,
	minQuestions: 3,
} as const

export type QuestionDifficulty = "easy" | "medium" | "hard"
export type QuestionSource = "llm" | "template"

/** 思考题（seq 从 1 开始，答案按 seq 对齐） */
export interface BundleQuestion {
	seq: number
	question: string
	/** 出题意图，仅教师端展示用 */
	intent?: string
	difficulty?: QuestionDifficulty
	hint?: string
	source?: QuestionSource
}

/** 学生对某道题的回答 */
export interface BundleAnswer {
	seq: number
	answer: string
}

/** 日志摘要（原文另以上传文件形式提交） */
export interface BundleLogInfo {
	original_path?: string
	line_count?: number
	sha256?: string
	truncated?: boolean
	/** 无法解析的行数（BN-04：全坏行也要能入库） */
	bad_lines?: number
	/** 日志里找不到本次 task_id（BN-06：只带 run_result + 最近 200 行） */
	slice_missing?: boolean
}

/** 编码过程中的一次运行/报错痕迹（P1 由终端监听填充） */
export interface BundleRunTrace {
	ts?: string
	command?: string
	exit_code?: number | null
	stdout_tail?: string
	stderr_tail?: string
	task_id?: string
}

/** 上传的元数据 */
export interface BundleMeta {
	schema: string
	assignment_id: string
	student_id: string
	student_name: string
	class_id: string
	submitted_at: string
	/** Cline 内部任务 id（与任务面板上的任务一一对应） */
	task_id?: string
	questions?: BundleQuestion[]
	answers?: BundleAnswer[]
	log?: BundleLogInfo
	run_traces?: BundleRunTrace[]
	client_version?: string
	/** 同一次提交的重试key：网络重试不会产生多份记录 */
	idempotency_key?: string
	/** 提交时还没保存到磁盘的文件（BN-16：只有编辑器缓冲区里有内容） */
	unsaved_files?: string[]
}

/** 服务端 201 返回体 */
export interface BundleIngestResult {
	ok: boolean
	submission_id: number
	revision: number
	deduplicated?: boolean
	stored?: {
		bundle_dir: string
		log_object: string | null
		code_count: number
	}
	metrics?: {
		ai_dependency: number
		metric_gaming_score: number
		user_edit_count: number
		metrics_source?: string
	}
	indexed_events?: number
	warnings?: string[]
	parse_errors?: number
}

/** 服务端错误返回体 */
export interface BundleErrorResult {
	ok: false
	code: string
	error: string
}

/** 交给答题面板渲染的载荷 */
export interface ThinkingQuestionsPayload {
	assignmentId: string
	assignmentTitle: string
	assignmentDescription?: string
	questions: BundleQuestion[]
	codeFiles: { relPath: string; sizeBytes: number }[]
	logPath: string | null
	logLineCount: number
	runTraceCount: number
	/** 出题来源：llm 全部由模型出、template 全模板、mixed 模型不足由模板补齐 */
	generatedBy: QuestionSource | "mixed"
	/** 降级/补齐提示（例如「模型调用失败，已使用通用思考题」） */
	questionWarning?: string
	/** 题数决策依据（例如「按材料计分 3 分算出 4 题」） */
	questionCountReason?: string
	submittedAt: string
	/** 已打码的敏感信息处数（BN-11） */
	redactionHits?: number
	/** 内容取自编辑器缓冲区、磁盘未保存的文件（BN-16） */
	unsavedFiles?: string[]
	/**
	 * 出题实际使用的模型提供方（来自 Cline 自带设置，例如 `openrouter`）。
	 * 缺省表示没有可用模型、本次是通用题 —— 面板据此说明「为什么不是模型出的题」。
	 */
	llmProvider?: string
	/** 出题实际使用的模型 id（可能为空：用 provider 默认模型） */
	llmModel?: string
}

/** 面板确认提交后回传的答案 */
export interface ThinkingConfirmResult {
	success: boolean
	error?: string
	data?: BundleIngestResult
}
