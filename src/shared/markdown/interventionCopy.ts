/**
 * 【F13】干预回执块 `<teaching_intervention_copy …>…</teaching_intervention_copy>` 的解析与剥离。
 *
 * 分层前提「决策留给代码，措辞交给模型」：文案由**模型**叙述，但「是否采用」由
 * `InterventionCopyContract.validateCopy()` 判定，「展示什么」由 `interventionDisplay.ts` 决定。
 * 本模块只做纯文本处理：无副作用、不依赖 vscode，因此可在两条展示路径
 * （`index.ts` 的 `say("text")` 与 `AttemptCompletionHandler` 的 `completion_result`）复用。
 *
 * ⚠️ **剥离只能发生在展示路径**：持久化用的是另一个变量（`assistantTextOnly` →
 * `addToApiConversationHistory`），回执块必须留在 `apiConversationHistory` 里，
 * 否则 M9' 的 `C`（回执块数）恒为 0、守恒式失去锚点（F13 硬要求 2）。
 */

/** 回执块开标签（不含 `>`：属性可选） */
const OPEN_TAG = "<teaching_intervention_copy"
/** 回执块闭标签 */
const CLOSE_TAG = "</teaching_intervention_copy>"

/** 完整（已闭合）回执块：开标签 + 可选属性 + 内文 + 闭标签。刻意**不**匹配未闭合的开标签 */
const BLOCK_RE = new RegExp(`${OPEN_TAG}(?:\\s[^>]*)?>([\\s\\S]*?)${CLOSE_TAG}`, "g")
/** 开标签内的属性（`rule="…"` / `severity="…"`） */
const ATTR_RE = /([a-zA-Z_][\w-]*)\s*=\s*"([^"]*)"/g

export interface ExtractedCopy {
	/** 回执块里声明的规则 ID（缺失时为 undefined —— 不臆造） */
	rule?: string
	/** 回执块里声明的力度档（缺失时为 undefined —— 不臆造） */
	severity?: string
	/** 提示文案本体（已 trim；空块为 `""`，交由校验层拒绝） */
	copy: string
}

export interface InterventionCopyExtraction {
	/** 首个回执块；无完整块（含仅有未闭合开标签）时为 null */
	found: ExtractedCopy | null
	/** 剥离全部完整回执块后的正文 */
	rest: string
}

function parseAttrs(rawAttrs: string): Pick<ExtractedCopy, "rule" | "severity"> {
	const attrs: Record<string, string> = {}
	for (const m of rawAttrs.matchAll(ATTR_RE)) {
		attrs[m[1]] = m[2]
	}
	return { rule: attrs.rule, severity: attrs.severity }
}

/**
 * 解析并剥离回执块。
 *
 * 契约（逐条有单测）：
 *   ① 不含开标签 → `found === null` 且 `rest` 与原文**逐字节**相等（热路径前提：绝大多数
 *      助手正文没有该标签，不允许做任何归一化）；
 *   ② 命中 → 取**首个**块为 `found`，其余块**一并剥离**（学生只看到文案）；
 *   ③ 仅有未闭合开标签（流式中间态）→ `found === null` 且 `rest === 原文`（恒等），
 *      由 partial 分支的 `dropUnclosedInterventionCopy()` 另行丢弃；
 *   ④ 空块 → `copy === ""`，块仍被剥离。
 */
export function extractInterventionCopy(text: string): InterventionCopyExtraction {
	if (typeof text !== "string" || !text.includes(OPEN_TAG)) {
		return { found: null, rest: typeof text === "string" ? text : "" }
	}

	// 每次新建正则实例，避免 `lastIndex` 残留（本函数是热路径，不能依赖调用方的重置）
	const re = new RegExp(BLOCK_RE.source, "g")
	let found: ExtractedCopy | null = null
	let rest = ""
	let cursor = 0
	let match: RegExpExecArray | null

	while ((match = re.exec(text)) !== null) {
		rest += text.slice(cursor, match.index)

		if (!found) {
			const openTagText = match[0].slice(0, match[0].indexOf(">") + 1)
			found = { ...parseAttrs(openTagText.slice(OPEN_TAG.length, -1)), copy: match[1].trim() }
		}

		cursor = match.index + match[0].length
		// 回执块通常独占一行（`…</teaching_intervention_copy>\n\n正文`）：连带吃掉紧跟其后的换行，
		// 否则剥离后会留下"块留下的空行"，学生可见的正文会莫名其妙从空行开始。
		while (cursor < text.length && (text[cursor] === "\n" || text[cursor] === "\r")) {
			cursor++
		}
	}

	if (!found) {
		return { found: null, rest: text }
	}

	rest += text.slice(cursor)
	return { found, rest: rest.trim() }
}

/**
 * 丢弃**未闭合**回执块的流式中间态：从第一个开标签起（含）截断。
 *
 * 为什么要单独一个函数：流式期间 `say("text", …, partial=true)` 会把当前累积文本
 * **整条替换**到同一条消息上（`index.ts` 的 partial 分支语义），此时回执块通常还没闭合
 * ——`extractInterventionCopy()` 按契约恒等返回，开标签会被 webview 直接渲染出来。
 * 因此 partial 阶段必须把开标签及其后全部内容丢掉，只预览前缀；等 `partial=false`
 * 的整条替换再呈现最终文案（含模型文案 + 正文）。
 *
 * 已闭合的块**同样**会被截断（此时块之后的内容也一并丢掉）：partial 只预览前缀，
 * 最终呈现由整条替换负责，不会丢内容。
 */
export function dropUnclosedInterventionCopy(text: string): string {
	if (typeof text !== "string") {
		return ""
	}
	const idx = text.indexOf(OPEN_TAG)
	if (idx === -1) {
		return text
	}
	return text.slice(0, idx).trim()
}
