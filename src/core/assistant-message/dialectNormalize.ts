/**
 * 【F12】把 DeepSeek 系模型的 **DSML 方言**归一化为 Cline 规范 XML。
 *
 * 为什么需要（实测，spec §7.5）：`parseAssistantMessageV2` 对 `<tool>` / `<param>` / `</param>`
 * 做**精确 `startsWith`** 匹配，而模型有时整段用方言输出（全角竖线包裹的 DSML 标记），
 * 于是一个 `tool_use` 都产不出 ⇒ `consecutiveMistakeCount++` ⇒ 「AI 连续 N 次没能正确调用工具」，
 * 整轮作废（M1 用例即因此不可用）。`stripLeakedToolCallMarkup` 只处理**渲染层**，感知层无人管。
 *
 * 设计约束（与 `stripLeakedToolCallMarkup` 同一保守原则，逐条有单测）：
 *   ① **不含全角竖线 ⇒ 恒等变换**（覆盖正常回复与合法 XML 的绝大多数情况，热路径几乎零成本）；
 *   ② **没动过任何标签 ⇒ 也返回原文**（文本里恰好含全角竖线但并非方言时，逐字节恒等）；
 *   ③ 只在**含标记的行**上改写；`write_to_file` 的 `content` 正文行原样保留（防止误改学生代码）；
 *   ④ **不得凭空造出工具调用**：`invoke` / `parameter` 外壳只有在属性里给出**已知**工具名/参数名时才产出标签；
 *   ⑤ 闭合用**栈匹配**（DSML 的闭合标记不带名字）；跨"标记差异"出栈只在**方言区域**（`calls` 包裹层内）允许，
 *      区域外的孤立闭合标记一律丢弃 —— 否则会提前闭合一个正常开放的文件写入块（截断内容）；
 *   ⑥ 本函数**只**用于 `parseAssistantMessageV2` 的**输入**，不是通用 XML 清洗器（刻意的）；UI 侧仍有
 *      `stripLeakedToolCallMarkup` 兜底。
 */

import { toolUseNames } from "@shared/tools"
import { toolParamNames } from "."

/** 全角竖线（U+FF5C）—— 方言唯一的"入口特征" */
const FULLWIDTH_PIPE = "\uFF5C"
/** DSML 标记本体：全角竖线 ×2 + DSML + 全角竖线 ×2 */
const DSML_MARK = `${FULLWIDTH_PIPE}${FULLWIDTH_PIPE}DSML${FULLWIDTH_PIPE}${FULLWIDTH_PIPE}`

const TOOL_NAMES: ReadonlySet<string> = new Set<string>(toolUseNames.map((n) => String(n)))
const PARAM_NAMES: ReadonlySet<string> = new Set<string>(toolParamNames)

/**
 * 标签样构造：`<[/][MARK]名称 属性…>`。
 * 同时覆盖三种真实形态：
 *   - DSML 元素：`<MARK invoke name="use_mcp_tool">`
 *   - DSML 闭合：`</MARK parameter>`（名字是 `parameter`，靠栈回填真实名字）
 *   - 合法 XML：`<use_mcp_tool>`（方言与 XML 混排时成为栈的支撑）
 * ⚠️ `name` 属性值用 `[^"]*`，因此值里含 `>` 也不会截断标签。
 */
const TAG_RE = new RegExp(`<\\/?\\s*(?:${DSML_MARK}\\s*)?([A-Za-z][\\w-]*)((?:\\s+[A-Za-z_][\\w-]*\\s*=\\s*"[^"]*")*)\\s*>`, "g")

/**
 * 【P5/T18】畸形开标签：属性**引号未闭合**、名字与值粘在一起（真实样本 S5）。
 *
 * 实测样本：`‹｜｜DSML｜｜ parameter name="server_name›wiki‹/server_name›`。
 * `TAG_RE` 要求成对引号 ⇒ 该标签整体不匹配 ⇒ 解析器只能命中后面的
 * `‹tool_name›` / `‹arguments›`，于是 `use_mcp_tool` **缺 `server_name`**；
 * 现场表现：`Cline tried to use use_mcp_tool without value for required parameter 'server_name'. Retrying...`。
 *
 * 处理：把 `name="NAME` 之后直到 `›` 的全部内容丢掉，只留规范开标签 `‹NAME›`（值由后续文本继续携带）。
 * 约束：仍**不臆造** —— 只有名字在已知工具/参数表里时才改写。
 * 注：成对引号的正常标签也会匹配本式，但产出与标准路径**逐字相同**，故可以安全前置。
 */
const MALFORMED_OPEN_RE = new RegExp(`<${DSML_MARK}\\s*(?:invoke|parameter)\\s+name="([A-Za-z_][\\w-]*)[^>]*>`, "g")

interface OpenElement {
	name: string
	/** 开标签是否出现在**含 DSML 标记的行**里（这类元素才允许被 DSML 闭合标记出栈） */
	dsml: boolean
}

/**
 * 归一化入口。**对不含方言标记的文本是恒等变换**（约束 ①/②）。
 *
 * @param raw 模型原始输出（`assistantMessage`，**不是**写进历史的那份副本）
 */
export function normalizeAssistantDialect(raw: string): string {
	if (!raw || !raw.includes(FULLWIDTH_PIPE)) {
		return raw
	}

	const stack: OpenElement[] = []
	/** `calls` 包裹层嵌套深度：> 0 表示"当前处于方言区域"（约束 ⑤） */
	let dialectDepth = 0
	/** 是否真的改写过任何标签；为 false 时返回原文，保证逐字节恒等 */
	let touched = false

	const out = raw
		.split("\n")
		.map((line): string | null => {
			const lineHasMark = line.includes(DSML_MARK)

			// 【P5/T18】先修畸形开标签（属性引号未闭合），否则成对引号的 TAG_RE 根本匹配不到它
			const pre = lineHasMark
				? line.replace(MALFORMED_OPEN_RE, (full: string, name: string) => {
						if (!TOOL_NAMES.has(name) && !PARAM_NAMES.has(name)) {
							return full // 未知名字：不改写（不臆造工具调用）
						}
						touched = true
						return `<${name}>`
					})
				: line

			const rebuilt = pre.replace(TAG_RE, (full: string, name: string, attrs: string) => {
				const isDsml = full.includes(DSML_MARK)
				const isClosing = /^<\s*\//.test(full)
				const attrName = /name\s*=\s*"([^"]*)"/.exec(attrs)?.[1]

				// `calls` 包裹层：只维护方言区域深度，不产出任何标签
				if (name === "calls") {
					touched = true
					dialectDepth = isClosing ? Math.max(0, dialectDepth - 1) : dialectDepth + 1
					return ""
				}

				if (isClosing) {
					const top: OpenElement | undefined = stack[stack.length - 1]
					// `invoke` 只能闭合工具、`parameter` 只能闭合参数（防"提前闭合文件写入块"）
					const kindMatches =
						top !== undefined &&
						(name === "invoke" ? TOOL_NAMES.has(top.name) : name === "parameter" ? PARAM_NAMES.has(top.name) : true)

					if (isDsml) {
						if (top && kindMatches && (top.dsml || dialectDepth > 0)) {
							stack.pop()
							touched = true
							return `</${top.name}>`
						}
						// 方言区域外的孤立闭合标记：丢弃（不清栈，也不产出标签）
						touched = true
						return ""
					}
					// 合法 XML 闭合：原样保留，仅在同名栈顶时出栈
					if (top?.name === name) {
						stack.pop()
					}
					return full
				}

				// `invoke` / `parameter` 外壳：只有在**含标记的行**里、且属性给出了已知名字时才改写（约束 ③/④）
				if ((name === "invoke" || name === "parameter") && lineHasMark) {
					if (attrName && (TOOL_NAMES.has(attrName) || PARAM_NAMES.has(attrName))) {
						stack.push({ name: attrName, dsml: true })
						touched = true
						return `<${attrName}>`
					}
					// 无名外壳：丢弃，绝不臆造工具调用（同为真实改写 ⇒ 必须置 touched）
					touched = true
					return ""
				}

				if (TOOL_NAMES.has(name) || PARAM_NAMES.has(name)) {
					stack.push({ name, dsml: lineHasMark })
					return full
				}

				// 方言里不认识的外壳：它是标记语法的一部分，不是正文 ⇒ 丢弃
				if (isDsml) {
					touched = true
					return ""
				}
				return full
			})
			// 整行只剩方言语法（外层壳 / 孤立闭合标记）⇒ 整行移除，不在正文里留空行
			return lineHasMark && rebuilt.trim() === "" ? null : rebuilt
		})
		.filter((line): line is string => line !== null)
		.join("\n")

	return touched ? out : raw
}
