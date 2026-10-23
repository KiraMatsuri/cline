/**
 * 教学干预消息生成器
 *
 * 根据行为风险警报生成不同风格的教学干预消息，
 * 支持多种干预风格（提示 / 提问 / 挑战 / 反思），
 * 可扩展更多规则和模板。
 */

import { buildCopyTaskSheet } from "./InterventionCopyContract"
import {
	FULL_IMPL_DEMAND_RELEASE_COUNT,
	isSoftInterventionRule,
	SOFT_INTERVENTION_COOLDOWN_MS,
	type SoftInterventionRuleId,
} from "./rulePolicy"
import type { BehaviorAlert, BehaviorRuleId, InterventionMessage, InterventionSeverity, InterventionStyle } from "./types"

/** 单条消息模板 */
interface MessageTemplate {
	style: InterventionStyle
	/** 模板字符串，支持 {streak} / {count} / {percent} / {threshold} 占位符 */
	template: string
}

/**
 * 旧六条规则的 ID（`BehaviorRuleId` 去掉【P2-3】六条软提示规则）。
 * `TEMPLATE_REGISTRY` 只服务旧规则，软规则有自己的 `SOFT_TEMPLATE_REGISTRY`。
 */
type LegacyBehaviorRuleId = Exclude<BehaviorRuleId, SoftInterventionRuleId>

/**
 * 每条规则对应的模板库
 * 按严重等级分组，每个等级包含多种风格的模板
 */
export const TEMPLATE_REGISTRY: Record<LegacyBehaviorRuleId, Record<InterventionSeverity, MessageTemplate[]>> = {
	consecutive_code_generation: {
		gentle: [
			{
				style: "hint",
				// 【P7/T5・附议 1】口径对齐：{streak} 是**助手回合**数，{count} 是**学生请求**数。
				// 2026-10-18 实测里学生只发了 2 条消息，文案却说「连续 3 轮」，读起来像学生在刷屏。
				template:
					"💡 学习提示：最近几个回合我给出的内容里一直带着代码（已记录 {count} 次）。要不要换一下顺序 —— 你先说说打算怎么实现，我再帮你补细节？",
			},
			{
				style: "question",
				template:
					"🤔 思考一下：最近 {streak} 个回合里，代码都是我写你。这里面哪一段是你已经能自己写出来的？试着从那段开始动手。",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 学习引导：最近几个回合我一直在直接给代码（已记录 {count} 次）。在继续之前，能否先讲讲你对当前实现的理解？比如：核心逻辑分几步？",
			},
			{
				style: "challenge",
				template:
					"🎯 小挑战：最近 {streak} 个回合都是我写代码。这一轮你先写出函数签名和核心步骤，我来帮你补充和检查，好吗？",
			},
		],
		strong: [
			{
				style: "challenge",
				template:
					"🎯 动手实践：最近几个回合我一直在提供完整代码（已记录 {count} 次）。为了真正掌握，请先自己实现核心部分，遇到具体卡点再来问我。",
			},
			{
				style: "reflection",
				template:
					"📝 学习反思：最近 {streak} 个回合里，你拿到的都是现成代码。请回顾一下：其中的核心逻辑你能独立复述吗？哪一部分你最没把握？",
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
	/** 【P5/T16】直接索要「完整实现」—— 概念型任务里也能计数与升级的那一条 */
	complete_impl_demand: {
		gentle: [
			{
				style: "hint",
				template:
					"💡 提醒：这是第 {streak} 次直接要完整实现了 —— 先自己写一版（哪怕只是循环骨架），再让 AI 对照，学得最快。",
			},
		],
		moderate: [
			{
				style: "question",
				template: "🤔 换个方式：完整实现先放一放。你能说出“第一步该做什么”吗？说对了我就接着往下拆（同样只给关键步骤）。",
			},
		],
		strong: [
			{
				style: "challenge",
				template:
					"🎯 这一步你自己先写：把函数名、输入、输出和循环能写多少写多少（不完整也算）。写完后贴出来，我只看你那几行。",
			},
		],
	},
	/** 【P6/T5】独立阻断通道：**我（AI）**在替学生写代码（不指控学生） */
	ai_coding_rounds: {
		gentle: [
			{
				style: "hint",
				template: "💡 提醒：这次是我（AI）把代码写完了。下一轮你先自己写一版，哪怕只是循环骨架，我再对照给你改。",
			},
		],
		moderate: [
			{
				style: "question",
				template: "🤔 换个方式：这几次都是我直接把代码写出来的。你能不能先说出“第一步做什么”，然后自己落笔写那一步？",
			},
		],
		strong: [
			{
				style: "challenge",
				template: "🎯 该你自己写了：接下来这一版请先由你独立完成（不完整也行），我只在你写完后指出问题。",
			},
		],
	},
}

// =============================================
// 【P2-3】六条软提示规则模板（只提示、永不阻断）
// =============================================

/**
 * 【P2-3】六条软提示规则的模板库。
 *
 * 与旧六条规则不同，软提示只有一种「力度」（gentle）与两种风格（hint / question），
 * 因为它们的定位是「轻轻推一下、把学生推回动手路径」，而不是纠正或施压：
 * 永远不阻断、不发起提问回合、不结束任务。
 *
 * 文案约束（`InterventionCopyContract.validateCopy`）：≤ 120 字、不含代码块、
 * 不含「系统/检测/自动」等机械词、必须给学生留白（先/试/想/写/改…）。
 */
export const SOFT_TEMPLATE_REGISTRY: Record<SoftInterventionRuleId, readonly MessageTemplate[]> = {
	// 连续 3 次停在 design（期间无 self_code）→ 先写 3 行伪代码猜一猜
	design_stall: [
		{
			style: "hint",
			template:
				"💡 学习提示：你已经连续 {streak} 次停在设计上了。先用 3 行伪代码写下你的猜测，再来问下一步怎么走。",
		},
		{
			style: "question",
			template: "🤔 先别急着问方案：你能用 3 行伪代码写出自己的猜测，再对照我的建议吗？",
		},
	],
	// 同一 exit_code + 同一首行错误出现 2 次 → 缩到最小复现
	same_error_twice: [
		{
			style: "hint",
			template: "💡 同一个报错出现了 {count} 次。先把最小复现代码缩到能稳定复现的那 5 行，再看看变量。",
		},
		{
			style: "question",
			template: "🤔 这次报错和上次是同一处吗？先从能复现的 5 行代码里找出第一处异常，再动手改。",
		},
	],
	// 本轮直接索要完整实现 → 拒绝 + 给方向；第 4 次起改用「放行」模板
	full_impl_demand: [
		{
			style: "hint",
			template: "💡 这是第 {streak} 次直接要完整实现了。先写出你的思路和伪代码，我再按你的方向补细节。",
		},
		{
			style: "question",
			template: "🤔 如果这段代码由你来写，第一步会先做什么？先写下 3 行思路，我们再一起看哪里会出错。",
		},
	],
	// 连续 2 次 ai_code（期间无 self_code）→ 读懂后自己改 3 行
	ai_code_streak: [
		{
			style: "hint",
			template: "💡 我已经连续 {streak} 次替你写完整代码了。读懂这段后，试着自己改 3 行（改注释也算）。",
		},
		{
			style: "question",
			template: "🤔 刚给的完整实现里，哪一行是关键？试着自己改 3 行，再运行看看结果。",
		},
	],
	// 连续 3 次 concept（期间无 self_code）→ 先动手试一行
	concept_streak: [
		{
			style: "hint",
			template: "💡 你已经连续 {streak} 次问概念了。先动手写一行试试，再来问为什么。",
		},
		{
			style: "question",
			template: "🤔 先试着写一行最小示例，看看会发生什么；然后再问这个概念为什么会这样？",
		},
	],
	// error_help 后 5 轮无 file_save / 新运行痕迹 → 加一行 print 或断点
	error_no_progress: [
		{
			style: "hint",
			template: "💡 报错求助后还没看到新的保存或运行。先加一行 print 看看变量，再动手改。",
		},
		{
			style: "question",
			template: "🤔 报错之后你试过加一行 print 或断点吗？先看看变量，再决定改哪里。",
		},
	],
}

/**
 * 【P2-3】`full_impl_demand` 的「放行」模板：第 `FULL_IMPL_DEMAND_RELEASE_COUNT` 次起
 * 不再直接拒绝，改为给伪代码方向（完整逻辑由学生自己落成代码）。
 */
const SOFT_DEMAND_RELEASED_TEMPLATES: readonly MessageTemplate[] = [
	{
		style: "hint",
		template: "💡 这是第 {streak} 次要完整实现了。这次给你伪代码：先读懂控制流，再自己翻译成代码。",
	},
	{
		style: "question",
		template: "🤔 我先把实现写成伪代码，你能先读懂每一行，再自己动手翻译成代码吗？",
	},
]

/** 【P2-3】按规则挑选软提示模板；`full_impl_demand` 达放行档位后改用伪代码模板 */
function pickSoftTemplates(alert: BehaviorAlert): readonly MessageTemplate[] {
	if (alert.ruleId === "full_impl_demand" && alert.metricValue >= FULL_IMPL_DEMAND_RELEASE_COUNT) {
		return SOFT_DEMAND_RELEASED_TEMPLATES
	}
	return SOFT_TEMPLATE_REGISTRY[alert.ruleId as SoftInterventionRuleId] ?? []
}

/**
 * 生成软提示消息（【P2-3】）。
 *
 * 与 `generateInterventionMessage` 的区别：力度恒为 `gentle`、风格从 hint/question 模板里取，
 * `interventionType` 恒为 `"normal"`（不存在阻断式软提示）。模板缺失时退回 `alert.message`，
 * 保证 BN-38「文案校验不过 → 模板兜底仍展示」。
 */
export function generateSoftInterventionMessage(
	alert: BehaviorAlert,
	cooldownMs: number = SOFT_INTERVENTION_COOLDOWN_MS,
): InterventionMessage {
	const candidates = pickSoftTemplates(alert)
	const selected = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : undefined
	return {
		content: selected ? fillTemplate(selected.template, alert) : `💡 学习提示：${alert.message}`,
		ruleId: alert.ruleId,
		severity: "gentle",
		style: selected?.style ?? "hint",
		interventionType: "normal",
		generatedAt: new Date().toISOString(),
		cooldownUntil: new Date(Date.now() + cooldownMs).toISOString(),
	}
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
	return (
		template
			.replace(/\{streak\}/g, String(Math.round(alert.metricValue)))
			// 【P7/T5】{count} = 该规则在**学生请求**口径下的累计次数（与 `{streak}` 的回合/指标口径区分）
			.replace(/\{count\}/g, String(Math.round(alert.escalationCount ?? alert.metricValue)))
			.replace(/\{percent\}/g, String(Math.round(alert.metricValue * 100)))
			.replace(/\{threshold\}/g, String(Math.round(alert.threshold)))
	)
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
	// 【P2-3】六条软提示规则走独立模板库：力度恒 gentle、风格只有 hint/question，永不阻断
	if (isSoftInterventionRule(alert.ruleId)) {
		return generateSoftInterventionMessage(alert, cooldownMs)
	}

	const legacyRuleId = alert.ruleId as LegacyBehaviorRuleId
	const severity = determineSeverity(alert.metricValue, alert.threshold)
	const templates = TEMPLATE_REGISTRY[legacyRuleId]?.[severity] ?? TEMPLATE_REGISTRY[legacyRuleId]?.gentle ?? []

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
 * 将干预消息格式化为可注入到系统提示的文本片段（用 <teaching_intervention> 标签包裹，便于审计）。
 *
 * 【F13】普通干预的下发内容不再是「请把上面这段提示呈现一遍」这种自由改写软指引，而是一份
 * **文案写作任务书**：决策（rule/severity/style）仍由代码给定，模型只负责「怎么说」。
 * 任务书里含三要素、硬约束与**回执块格式**，模型按契约把文案写在回执块里，
 * 由 `InterventionCopyContract.validateCopy()` 判定是否采用（不过则降级 `TEMPLATE_REGISTRY`）。
 *
 * @param intervention 干预消息
 * @param recentCopies 最近已展示过的文案（要求模型「换一种说法」）；缺省为空
 */
export function formatInterventionForInjection(intervention: InterventionMessage, recentCopies: readonly string[] = []): string {
	return buildCopyTaskSheet({
		ruleId: intervention.ruleId,
		severity: intervention.severity,
		style: intervention.style,
		templateText: intervention.content,
		recentCopies,
	})
}

