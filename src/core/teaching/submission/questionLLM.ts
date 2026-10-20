/**
 * 出题用的模型解析（v2.13.1）
 *
 * 目标：出题**直接复用 Cline 自带设置里已经填好的模型提供商与 API Key**。
 * 学生只需要在 Cline 的「设置 → API 配置」里配置一次（平时聊天用的那套），
 * 出题就不再需要工作区 `.env`、插件侧「教学 LLM 设置」或任何额外的 key 输入框。
 *
 * 这里只做纯数据解析（不 import vscode、不构造 handler），便于单测：
 *   resolveQuestionLLMTarget(config) → 选哪个模式 / 哪个 provider / 哪个模型
 *   describeLLMUnavailable(config)   → 为什么没有可用模型（给面板的提示语）
 *   describeLLMFailure(error, target)→ 把 401 / 缺 key 翻译成学生能照做的话
 *
 * 为什么不能看 `config.apiProvider`：
 *   Cline 的 ApiConfiguration 里根本没有这个字段，模式与提供商分列在
 *   `actModeApiProvider` / `planModeApiProvider` 上，`buildApiHandler()` 也只读这两项。
 *   早期版本按 `apiProvider` 判断，于是「有配置也永远判成没配置」→ 每次出题都退化成通用题。
 */

/** Cline 的两种模式：主对话默认 act，plan 是规划模式 */
export type QuestionLLMMode = "act" | "plan"

/**
 * 从 `StateManager.getApiConfiguration()` 里取出用得到的字段。
 * 用宽松类型接收整份配置：调用方直接传入真实对象，单测只构造这几个键。
 */
export interface QuestionLLMConfig {
	actModeApiProvider?: string | null
	planModeApiProvider?: string | null
	actModeApiModelId?: string | null
	planModeApiModelId?: string | null
}

export interface QuestionLLMTarget {
	/** 实际用于调用模型的模式 */
	mode: QuestionLLMMode
	/** 提供商 id，例如 openrouter / anthropic / cline */
	provider: string
	/** 模型 id（可能为空：交给 provider 的默认模型） */
	model?: string
}

function clean(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 选出用于出题的模型。
 *
 * 优先 **act**（与主对话默认模式一致，学生平时能聊通的配置就是它）；
 * act 没配置时才退回 **plan**；两者都没有则返回 null（调用方走通用题）。
 * 注意空字符串 / 纯空格视为「未配置」——设置页清空输入框时常见这种值。
 */
export function resolveQuestionLLMTarget(config: QuestionLLMConfig | null | undefined): QuestionLLMTarget | null {
	if (!config) return null

	const actProvider = clean(config.actModeApiProvider)
	if (actProvider) {
		return { mode: "act", provider: actProvider, model: clean(config.actModeApiModelId) }
	}

	const planProvider = clean(config.planModeApiProvider)
	if (planProvider) {
		return { mode: "plan", provider: planProvider, model: clean(config.planModeApiModelId) }
	}

	return null
}

/** 面板上显示的「哪个模型出的题」，例如 `openrouter · deepseek/deepseek-chat` */
export function formatQuestionLLMTarget(target: QuestionLLMTarget | null | undefined): string | undefined {
	if (!target) return undefined
	return target.model ? `${target.provider} · ${target.model}` : target.provider
}

/**
 * 按「优先 act、其次 plan」列出可尝试的模型（已去重）。
 *
 * 为什么需要「多个」：`actModeApiProvider` 有默认值 `openrouter`，所以即便学生只在
 * plan 模式下配好了 Anthropic，act 看上去也是「已配置」——直接用它只会拿到 401。
 * 调用方按顺序尝试，**只对鉴权类失败换下一个**（网络错误换模型也没用）。
 */
export function resolveQuestionLLMTargets(config: QuestionLLMConfig | null | undefined): QuestionLLMTarget[] {
	const targets: QuestionLLMTarget[] = []
	const primary = resolveQuestionLLMTarget(config)
	if (primary) targets.push(primary)

	const actProvider = clean(config?.actModeApiProvider)
	const planProvider = clean(config?.planModeApiProvider)
	if (primary?.mode !== "plan" && planProvider && planProvider !== actProvider) {
		targets.push({ mode: "plan", provider: planProvider, model: clean(config?.planModeApiModelId) })
	}
	return targets
}

/**
 * 缺少可用模型时的说明。
 *
 * 刻意点出「Cline 设置 → API 配置」：学生在哪儿填 key 是这套流程最容易卡住的地方，
 * 而这里的正确答案就是**复用平时聊天用的那套配置**，不需要再填一次。
 */
export function describeLLMUnavailable(config?: QuestionLLMConfig | null): string {
	const target = resolveQuestionLLMTarget(config)
	if (target) {
		return `未能使用 ${formatQuestionLLMTarget(target)} 出题，已使用通用思考题`
	}
	return "尚未在 Cline 中配置模型（设置 → API 配置 → 选择提供商并填写 API Key），已使用通用思考题"
}

/** 常见「没填 key / key 失效」的错误特征 */
const KEY_ERROR_PATTERN =
	/401|403|unauthori[sz]ed|invalid[\s_-]*api[\s_-]*key|api[\s_-]*key[\s_-]*(is[\s_-]*)?(not[\s_-]*set|missing|required)|no[\s_-]*api[\s_-]*key|authentication|insufficient[\s_-]*credit|quota/i

/**
 * 是否属于「鉴权类」失败（401/403、缺 key、额度不足）。
 *
 * 这类失败换一个 provider 才可能成功；网络错误、模型过载换 provider 只是浪费时间。
 */
export function isAuthFailure(error: unknown): boolean {
	const raw = error instanceof Error ? error.message : String(error ?? "")
	return KEY_ERROR_PATTERN.test(raw)
}

/**
 * 把模型调用异常翻译成一句话。
 *
 * 401/403/缺少 key 这类错误对学生的可操作性最强：直接指向 Cline 的设置项，
 * 其余错误保留原始 message（截断），方便教师排查。
 */
export function describeLLMFailure(
	error: unknown,
	target?: QuestionLLMTarget | null,
	options: { maxLength?: number } = {},
): string {
	const maxLength = options.maxLength ?? 160
	const raw = error instanceof Error ? error.message : String(error ?? "")
	const detail = raw.trim().replace(/\s+/g, " ").slice(0, maxLength)
	const label = formatQuestionLLMTarget(target) ?? "模型"

	if (KEY_ERROR_PATTERN.test(raw)) {
		return `${label} 调用被拒（API Key 无效或未配置）：请到 Cline 设置 → API 配置检查密钥`
	}
	return detail ? `${label} 调用失败：${detail}` : `${label} 调用失败（无错误信息）`
}
