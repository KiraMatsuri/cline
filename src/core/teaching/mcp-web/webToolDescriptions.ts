/**
 * 联网检索 MCP 工具的 description 文本（抽出来是为了可单测）。
 *
 * 为什么必须单独成模块：`webSearchServer.ts` 是 stdio 入口，import 它会真的启动 server，
 * 因此那些 description 在单测里无法被断言到 —— 而 `web_search` 的描述正是
 * 「外部资料只用于校验、不得覆盖教材」与「失败返回结构化错误、不得编造」这两条行为的**直接指令源**。
 * 一旦回潮，必须有人报警。
 */

/** 在外部公开资料中检索（provider 无关；仅用于校验通用知识） */
export const WEB_SEARCH_DESCRIPTION =
	"在**外部公开资料**中检索（非课程资料库）。仅用于**校验通用知识**；回答口径仍以教材为准，外部资料不得覆盖教材定义。失败时返回结构化错误，不要据此编造内容。"

/**
 * 成功结果的前置声明（逐字出现在工具输出开头）。
 * 与 description 同源：再次提醒模型外部资料**不得覆盖教材定义**。
 */
export const WEB_SEARCH_RESULT_HEADER = "（以下为外部资料，仅供校验；最终回答请以教材为准）"
