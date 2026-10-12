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
	/** 反思引导问题列表 */
	reflectionQuestions: string[]
}

/**
 * 每条规则对应的模板库
 * 按严重等级分组，每个等级包含多种风格的模板
 */
export const TEMPLATE_REGISTRY: Record<BehaviorRuleId, Record<InterventionSeverity, MessageTemplate[]>> = {
	consecutive_code_generation: {
		gentle: [
			{
				style: "hint",
				template:
					"💡 学习提示：刚才我连续 {streak} 轮给出的内容里都带了代码。要不要换一下顺序 —— 你先说说打算怎么实现，我再帮你补细节？",
			},
			{
				style: "question",
				template: "🤔 思考一下：这 {streak} 轮我都给了代码。这里面哪一段是你已经能自己写出来的？试着从那段开始动手。",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 学习引导：我已经连续 {streak} 轮直接给代码了。在继续之前，能否先讲讲你对当前实现的理解？比如：核心逻辑分几步？",
			},
			{
				style: "challenge",
				template: "🎯 小挑战：这 {streak} 轮都是我写代码。这一轮你先写出函数签名和核心步骤，我来帮你补充和检查，好吗？",
			},
		],
		strong: [
			{
				style: "challenge",
				template:
					"🎯 动手实践：我已经连续 {streak} 轮提供完整代码了。为了真正掌握，请先自己实现核心部分，遇到具体卡点再来问我。",
			},
			{
				style: "reflection",
				template:
					"📝 学习反思：这 {streak} 轮你拿到的都是现成代码。请回顾一下：其中的核心逻辑你能独立复述吗？哪一部分你最没把握？",
			},
		],
	},

	no_edit_streak: {
		gentle: [
			{
				style: "hint",
				template:
					"💡 实践建议：最近 {streak} 轮我们都在聊，还没动手改过代码。想不想挑一处小地方试试 —— 改个变量名、加一行注释都算开始。",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 想一想：最近 {streak} 轮我们都没有碰代码。是哪里不确定、不知道从哪下手吗？说说你卡住的位置，我们一起拆开看。",
			},
			{
				style: "challenge",
				template: "🎯 小任务：在看我的下一条回复之前，先试着改一个小地方，然后告诉我你改了什么、为什么这么改。",
			},
		],
		strong: [
			{
				style: "reflection",
				template:
					"📝 学习反思：我们已经连续 {streak} 轮没有动手写代码了。编程是实践技能，读懂和写出之间还有一段距离。现在就打开编辑器，试着修改或重写我们正在讨论的那部分函数中的一小段。",
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
				template: "💡 独立编码提示：这几轮基本都是我在说。要不要先自己构思一下解题思路，再把具体问题提给我？",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 换个方式：这几轮大多是你在提问、我在整理答案。你能否先用伪代码或自然语言描述一下你想实现的逻辑？这样我能针对性帮你，你也能更清楚自己的思路。",
			},
		],
		strong: [
			{
				style: "reflection",
				template:
					"📝 学习反思：这段时间基本是我在输出。请想一想：如果没有我帮忙，当前任务的哪些部分你能独立完成？哪些知识点还需要补？",
			},
			{
				style: "challenge",
				template:
					"🎯 自主练习：请先关掉这个对话，尝试独立编写当前功能的核心逻辑（不完整也没关系），然后带着你的代码和具体问题回来，我帮你诊断和改进。",
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
		reflectionQuestions: [
			"请在编辑器中打开当前讨论的文件，尝试修改至少 3 处代码（如变量命名、逻辑简化、添加注释）。",
			"你刚才阅读的代码中，哪一部分让你觉得最难理解？请尝试用自己的话解释它。",
			"尝试运行当前代码并观察输出。有什么意料之外的行为吗？",
		],
	},
	high_recent_ai_dependency: {
		content:
			"🚫 【教学干预 — 阻断模式】\n\n系统检测到最近几轮基本由 AI 输出、缺少你自己的动手环节。过度依赖 AI 会削弱独立编程能力。代码生成与工具执行功能已被暂时禁用。\n\n请完成以下自主练习后，系统将自动恢复功能。",
		disabledFeatures: ["code_generation", "tool_execution"],
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
		"请在你的回复开头，用 <teaching_intervention_copy> 块给出本轮的干预文案（格式见任务书）。",
		"注：不要提及这是系统自动插入的消息；但**必须**使用上述块，不得只在正文里自由发挥。",
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
		const countdownText = seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`
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
	blockingCooldownMs: number = 60_000,
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
		// ★ 由实际冷却时长推导，不再沿用模板里写死的 180 —— 否则注入文本会说"3 分钟"，
		// 而横幅按 blockingEndAt 从 1 分钟倒数，同屏两个数字互相矛盾。
		countdownSeconds: Math.round(blockingCooldownMs / 1000),
		blockingEndAt: cooldownDate.toISOString(),
		reflectionQuestions: template.reflectionQuestions,
	}
}
