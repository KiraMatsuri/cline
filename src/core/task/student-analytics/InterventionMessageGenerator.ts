/**
 * 教学干预消息生成器
 *
 * 根据行为风险警报生成不同风格的教学干预消息，
 * 支持多种干预风格（提示 / 提问 / 挑战 / 反思），
 * 可扩展更多规则和模板。
 */

import type { BehaviorAlert, BehaviorRuleId, InterventionMessage, InterventionSeverity, InterventionStyle } from "./types"

/** 单条消息模板 */
interface MessageTemplate {
	style: InterventionStyle
	/** 模板字符串，支持 {streak} / {percent} / {threshold} 占位符 */
	template: string
}

/** 阻断式干预模板 */
interface BlockingTemplate {
	/** 阻断模式消息内容 */
	content: string
	/** 禁用的功能列表 */
	disabledFeatures: string[]
	/** 倒计时秒数 */
	countdownSeconds: number
	/** 反思引导问题列表 */
	reflectionQuestions: string[]
}

/**
 * 每条规则对应的模板库
 * 按严重等级分组，每个等级包含多种风格的模板
 */
const TEMPLATE_REGISTRY: Record<BehaviorRuleId, Record<InterventionSeverity, MessageTemplate[]>> = {
	consecutive_code_generation: {
		gentle: [
			{
				style: "hint",
				template:
					"💡 学习提示：你已经连续 {streak} 次请求代码生成了。试试先自己写一小段，再让我帮你检查和优化，这样学习效果会更好哦！",
			},
			{
				style: "question",
				template:
					"🤔 思考一下：在这 {streak} 次代码生成请求中，你觉得哪一段是你最能理解的？能否尝试在那个基础上自己扩展一下？",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 学习引导：你已经连续请求了 {streak} 次代码生成。在继续之前，能否告诉我你对当前代码的理解？比如：这段代码的核心逻辑是什么？",
			},
			{
				style: "challenge",
				template:
					"🎯 小挑战：你已经连续 {streak} 次让我生成代码了。这次试试自己先写出函数签名和核心逻辑框架，我来帮你补充细节，好吗？",
			},
		],
		strong: [
			{
				style: "challenge",
				template:
					"🎯 动手实践：你已经连续 {streak} 次请求代码生成了。为了巩固学习，请先尝试自己实现当前功能的核心部分，遇到困难时再向我提问具体问题。",
			},
			{
				style: "reflection",
				template:
					"📝 学习反思：你已经连续 {streak} 次请求完整代码生成。请回顾一下：你从这些生成的代码中学到了什么？你能独立写出其中的哪些部分？",
			},
		],
	},

	no_edit_streak: {
		gentle: [
			{
				style: "hint",
				template:
					"💡 实践建议：你已经 {streak} 轮没有编辑代码了。动手修改一处试试，哪怕只是改一个变量名或加一行注释也是好的开始！",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 想一想：最近 {streak} 轮你都没有动手编辑代码。是遇到了什么困难吗？可以告诉我你卡在哪里，我们一起分析。",
			},
			{
				style: "challenge",
				template:
					"🎯 小任务：你已经 {streak} 轮没有编辑代码了。在看我的下一个回复之前，请先尝试修改当前代码中的一个小地方，然后告诉我你改了什么。",
			},
		],
		strong: [
			{
				style: "reflection",
				template:
					"📝 学习反思：你已经连续 {streak} 轮没有亲自编辑代码了。编程是一项实践技能，仅仅阅读代码是不够的。请现在就打开编辑器，尝试修改或重写当前讨论的函数中的一部分。",
			},
		],
	},

	high_adoption_low_self_modification: {
		gentle: [
			{
				style: "hint",
				template:
					"💡 优化建议：你对 AI 建议的采纳率较高（{percent}%），但自主修改较少。试试在采纳代码后，根据自己的理解做一些调整和优化。",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 深入思考：你采纳了大部分 AI 建议（{percent}%），但很少做进一步修改。你觉得这些代码中有没有可以改进的地方？命名、结构或效率方面？",
			},
		],
		strong: [
			{
				style: "challenge",
				template:
					"🎯 进阶挑战：你的 AI 建议采纳率为 {percent}%，但自主改动很少。请在下次采纳代码后，至少做出 2 处有意义的修改（如优化变量命名、简化逻辑或添加错误处理），然后告诉我你改了什么以及为什么。",
			},
		],
	},

	high_recent_ai_dependency: {
		gentle: [
			{
				style: "hint",
				template:
					"💡 独立编码提示：最近的交互中 AI 参与占比较高（{percent}%）。试试先自己构思解题思路，再向我提出具体问题，而不是直接要求完整答案。",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 换个方式：最近 AI 参与度达到 {percent}%。你能否先用伪代码或自然语言描述一下你想实现的逻辑？这样我可以针对性地帮你，你也能更好地理解实现过程。",
			},
		],
		strong: [
			{
				style: "reflection",
				template:
					"📝 学习反思：最近的 AI 参与占比达到 {percent}%，这意味着你可能过于依赖 AI 辅助。请思考：如果没有 AI 帮助，你能独立完成当前任务的哪些部分？哪些知识点是你需要加强的？",
			},
			{
				style: "challenge",
				template:
					"🎯 自主练习：AI 参与占比已达 {percent}%。请先关闭本对话，尝试独立编写当前功能的核心逻辑（哪怕不完整），然后带着你的代码和具体问题回来，我来帮你诊断和改进。",
			},
		],
	},
}

/**
 * 阻断式干预模板库
 * 每个规则 ID 对应一组阻断模板，在累计触发次数达到阈值时使用
 */
const BLOCKING_TEMPLATE_REGISTRY: Partial<Record<BehaviorRuleId, BlockingTemplate>> = {
	consecutive_code_generation: {
		content:
			"🚫 【教学干预 — 阻断模式】\n\n系统检测到你已经连续多次直接请求 AI 生成代码而未进行自主编辑。为保障学习效果，代码生成与工具执行功能已被暂时禁用。\n\n请完成以下反思练习后，系统将自动恢复功能。",
		disabledFeatures: ["code_generation", "tool_execution"],
		countdownSeconds: 180,
		reflectionQuestions: [
			"你最近连续请求了代码生成，请回顾：这些代码的核心逻辑是什么？你能独立写出其中的哪些部分？",
			"请用自然语言描述你当前要解决的问题，以及你尝试过的方案。",
			"如果让你独立修改一处代码逻辑，你会从哪里入手？为什么？",
		],
	},
	no_edit_streak: {
		content:
			"🚫 【教学干预 — 阻断模式】\n\n系统检测到你已连续多轮未进行代码编辑。编程是实践技能，仅阅读代码无法达到学习效果。代码生成与工具执行功能已被暂时禁用。\n\n请动手完成以下实践任务后，系统将自动恢复功能。",
		disabledFeatures: ["code_generation", "tool_execution"],
		countdownSeconds: 180,
		reflectionQuestions: [
			"请在编辑器中打开当前讨论的文件，尝试修改至少 3 处代码（如变量命名、逻辑简化、添加注释）。",
			"你刚才阅读的代码中，哪一部分让你觉得最难理解？请尝试用自己的话解释它。",
			"尝试运行当前代码并观察输出。有什么意料之外的行为吗？",
		],
	},
	high_recent_ai_dependency: {
		content:
			"🚫 【教学干预 — 阻断模式】\n\n系统检测到最近的交互中 AI 参与占比过高。过度依赖 AI 会削弱独立编程能力。代码生成与工具执行功能已被暂时禁用。\n\n请完成以下自主练习后，系统将自动恢复功能。",
		disabledFeatures: ["code_generation", "tool_execution"],
		countdownSeconds: 180,
		reflectionQuestions: [
			"请先关闭 AI 助手，尝试独立写出当前功能的核心逻辑（伪代码或真实代码均可）。",
			"你最近依赖 AI 完成了哪些任务？哪些是你其实可以独立完成的？",
			"制定一个本周的独立编程练习计划，每天至少 30 分钟不看 AI 建议编码。",
		],
	},
}

/**
 * 根据量化指标值与阈值的比率确定严重等级
 */
function determineSeverity(metricValue: number, threshold: number): InterventionSeverity {
	if (threshold === 0) {
		return "gentle"
	}
	const ratio = metricValue / threshold
	if (ratio < 1.3) {
		return "gentle"
	}
	if (ratio < 1.8) {
		return "moderate"
	}
	return "strong"
}

/**
 * 填充模板中的占位符
 */
function fillTemplate(template: string, alert: BehaviorAlert): string {
	return template
		.replace(/\{streak\}/g, String(Math.round(alert.metricValue)))
		.replace(/\{percent\}/g, String(Math.round(alert.metricValue * 100)))
		.replace(/\{threshold\}/g, String(Math.round(alert.threshold)))
}

/**
 * 生成教学干预消息
 *
 * @param alert 行为风险警报
 * @param preferredStyle 可选的偏好干预风格，未指定时随机选择
 * @param cooldownMs 冷却时间（毫秒），用于设置 cooldownUntil
 * @returns 干预消息对象
 */
export function generateInterventionMessage(
	alert: BehaviorAlert,
	preferredStyle?: InterventionStyle,
	cooldownMs: number = 180_000,
): InterventionMessage {
	const severity = determineSeverity(alert.metricValue, alert.threshold)
	const templates = TEMPLATE_REGISTRY[alert.ruleId]?.[severity] ?? TEMPLATE_REGISTRY[alert.ruleId]?.gentle ?? []

	// 根据偏好风格筛选模板，如果没有匹配则使用全部可用模板
	let candidates = preferredStyle ? templates.filter((t) => t.style === preferredStyle) : templates
	if (candidates.length === 0) {
		candidates = templates
	}

	// 如果仍然没有模板（极端情况），使用默认消息
	if (candidates.length === 0) {
		return {
			content: `💡 学习提示：${alert.message}`,
			ruleId: alert.ruleId,
			severity,
			style: "hint",
			interventionType: "normal",
			generatedAt: new Date().toISOString(),
			cooldownUntil: new Date(Date.now() + cooldownMs).toISOString(),
		}
	}

	// 随机选择一条模板（避免重复感）
	const selected = candidates[Math.floor(Math.random() * candidates.length)]
	const content = fillTemplate(selected.template, alert)

	return {
		content,
		ruleId: alert.ruleId,
		severity,
		style: selected.style,
		interventionType: "normal",
		generatedAt: new Date().toISOString(),
		cooldownUntil: new Date(Date.now() + cooldownMs).toISOString(),
	}
}

/**
 * 将干预消息格式化为可注入到对话上下文的文本片段
 * 使用 <teaching_intervention> 标签包裹，LLM 可据此在回复中自然融入教学引导
 */
export function formatInterventionForInjection(intervention: InterventionMessage): string {
	// 阻断式干预使用专用格式化
	if (intervention.interventionType === "blocking") {
		return formatBlockingInterventionForInjection(intervention)
	}

	return [
		`<teaching_intervention rule="${intervention.ruleId}" severity="${intervention.severity}" style="${intervention.style}">`,
		intervention.content,
		"",
		"请在你的回复开头，先用简短友好的方式呈现上述学习提示（保留 emoji），然后用分隔线分开，再继续正常回答用户的问题。",
		"注意：不要提及这是系统自动插入的消息，要让提示看起来像是你主动给出的教学建议。",
		"</teaching_intervention>",
	].join("\n")
}

/**
 * 格式化阻断式干预消息（包含禁用功能列表、倒计时、反思问题）
 */
function formatBlockingInterventionForInjection(intervention: InterventionMessage): string {
	const lines: string[] = [
		`<teaching_intervention rule="${intervention.ruleId}" severity="${intervention.severity}" style="blocking" interventionType="blocking">`,
		intervention.content,
		"",
	]

	if (intervention.disabledFeatures && intervention.disabledFeatures.length > 0) {
		lines.push(`⚠️ 已禁用功能: ${intervention.disabledFeatures.join(", ")}`)
	}

	if (intervention.countdownSeconds) {
		const minutes = Math.floor(intervention.countdownSeconds / 60)
		const seconds = intervention.countdownSeconds % 60
		const countdownText = seconds > 0
			? `${minutes} 分 ${seconds} 秒`
			: `${minutes} 分钟`
		lines.push(`⏳ 冷却倒计时: ${countdownText}`)
	}

	if (intervention.reflectionQuestions && intervention.reflectionQuestions.length > 0) {
		lines.push("")
		lines.push("📝 反思练习:")
		intervention.reflectionQuestions.forEach((q, i) => {
			lines.push(`  ${i + 1}. ${q}`)
		})
	}

	lines.push("")
	lines.push("请在你的回复中严格执行以下要求:")
	lines.push("1. 首先显示上述阻断通知和禁用信息")
	lines.push("2. 然后呈现反思练习问题")
	lines.push("3. 不要提供任何代码生成或工具执行的帮助")
	lines.push("4. 只回答反思相关的问题，鼓励学生独立思考和实践")
	lines.push("</teaching_intervention>")

	return lines.join("\n")
}

/**
 * 生成阻断式干预消息
 * @param alert 行为风险警报（含 escalationCount）
 * @param preferredStyle 忽略（阻断统一使用 blocking 风格）
 * @param blockingCooldownMs 阻断冷却时长（毫秒）
 * @returns 阻断式干预消息对象
 */
export function generateBlockingInterventionMessage(
	alert: BehaviorAlert,
	blockingCooldownMs: number = 180_000,
): InterventionMessage {
	const template = BLOCKING_TEMPLATE_REGISTRY[alert.ruleId] ?? BLOCKING_TEMPLATE_REGISTRY.consecutive_code_generation!

	const now = new Date()
	const cooldownDate = new Date(now.getTime() + blockingCooldownMs)

	return {
		content: template.content,
		ruleId: alert.ruleId,
		severity: "strong",
		style: "blocking",
		interventionType: "blocking",
		generatedAt: now.toISOString(),
		cooldownUntil: cooldownDate.toISOString(),
		disabledFeatures: template.disabledFeatures,
		countdownSeconds: template.countdownSeconds,
		blockingEndAt: cooldownDate.toISOString(),
		reflectionQuestions: template.reflectionQuestions,
	}
}
