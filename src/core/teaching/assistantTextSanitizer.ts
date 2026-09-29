/**
 * assistantTextSanitizer — 剔除助手正文里的「工具调用标记残渣」（v2.13 教学修复）
 *
 * 【实测证据】（2026-09-29，DeepSeek 系模型 + 原生工具调用，taskId=1790691098981）
 * UI 消息里**没有**任何 `say:reasoning`（思考链抑制是生效的），但存在两条 `say:text`，
 * 内容形如（下方用「」示意尖括号，实际是全角竖线 U+FF5C 包围的 DSML 标记）：
 *
 *   「」｜｜DSML｜｜ calls「」                       ← 分隔符是全角竖线 U+FF5C，不是 ASCII 竖线
 *   「」｜｜DSML｜｜ invoke name="use_mcp_tool"「」
 *   「」｜｜DSML｜｜ parameter name="server_name"「」wiki「」/｜｜DSML｜｜ parameter「」
 *   「」/｜｜DSML｜｜ invoke「」
 *   「」/｜｜DSML｜｜ calls「」
 *
 * 成因：模型在**结构化 tool_calls 通道**里正常发起了调用（Cline 也确实执行了、拿到了结果），
 * 但同时又把同一批调用标记**也写进了 content**。上游解析器只认识 Cline 自己的 XML 方言，
 * 认不出这种标记 → 整段被当成普通 text 推送 → 学生在聊天里看到一屏乱码。
 *
 * 【为什么不写「通用 XML / 标签清洗」】
 * 学生正文里合法出现代码、尖括号、比较符号是常态。宽泛清洗很容易误删正常内容，
 * 代价远高于收益。这里只认**实测确认**的那个特征（全角竖线），
 * 保证对正常文本是**恒等变换**。
 */

/** 全角竖线 U+FF5C。刻意写成转义，避免被误读成 ASCII 竖线而在正则里被当成"或" */
const FULLWIDTH_PIPE = "\uFF5C"

/**
 * 清洗助手正文：剔除所有含工具调用标记的行。
 *
 * 策略（保守）：
 *   1. 不含全角竖线 → **原样返回**（恒等变换，覆盖正常回复的绝大多数情况）；
 *   2. 含标记 → 按行丢弃「含全角竖线的行」，其余行保留并 trim。
 *
 * 剩余为空时返回空串：webview 侧本来就会丢弃空的 text 消息
 * （`filterVisibleMessages` 的 `case "text"` 分支），因此调用方无需额外判空。
 */
export function stripLeakedToolCallMarkup(text: string): string {
	if (!text || !text.includes(FULLWIDTH_PIPE)) {
		return text
	}
	return text
		.split("\n")
		.filter((line) => !line.includes(FULLWIDTH_PIPE))
		.join("\n")
		.trim()
}
