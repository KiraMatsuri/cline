/**
 * =============================================================================
 *  secrets — 上传前的密钥打码（P2-1 / BN-11、BN-12）
 * =============================================================================
 *
 * 【为什么必须做】
 *   学生的代码里常有 `api_key = "sk-..."`、`.env` 里的数据库密码、测试用的
 *   token。这些文件一旦随提交包上传，就进了教师端数据库与磁盘，属于真实泄漏。
 *   服务端不应承担「猜哪段是密钥」的责任——它没有原始上下文。所以在客户端
 *   （内容还完整的时刻）就地打码，并在报告与面板上明确告知已打码。
 *
 * 【策略】
 *   ① 识别常见「赋值给敏感名字」的字面量：api_key / secret / token / password /
 *      passwd / pwd / private_key / access_key / auth 等（大小写不敏感）
 *   ② 只打码「看起来像密钥的值」（长度 ≥ 8 且不含空格的串），避免把
 *      `const password = prompt("...")` 之类误伤成 REDACTED
 *   ③ 额外识别常见厂商前缀：`sk-`、`ghp_`、`xox[baprs]-`、`AKIA`、`AIza`、
 *      JWT（`eyJ...`）、私钥块 `-----BEGIN ... PRIVATE KEY-----`
 *   ④ `.env` / `.env.*` 文件整体按 KEY=VALUE 打码敏感键
 *
 * 纯函数，无副作用。
 * =============================================================================
 */

/** 打码后的占位符（报告页与面板都会展示它，便于学生理解） */
export const REDACTED = "***REDACTED***"

/** 敏感键名（大小写不敏感，允许连接符/下划线） */
const SENSITIVE_KEY_PATTERN =
	/(api[_-]?key|apikey|secret|token|password|passwd|pwd|private[_-]?key|access[_-]?key|auth[_-]?key|credential|session[_-]?id|client[_-]?secret)/i

/** 值「像密钥」：带引号、长度 ≥ 8、且不含空白（排除自然语言） */
const SECRETISH_VALUE = /^["'`][^"'`\s]{8,}["'`]$/

/** 厂商前缀 / 结构性密钥 */
const VENDOR_PATTERNS: RegExp[] = [
	/\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI 等
	/\bghp_[A-Za-z0-9]{20,}/g, // GitHub PAT
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained
	/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
	/\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
	/\bAIza[0-9A-Za-z_-]{30,}/g, // Google API key
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // 私钥块
]

/** `.env` 风格文件 */
const ENV_FILE_PATTERN = /(^|[\\/])\.env(\.|$)|\.env\.[a-z]+$/i

/** 赋值语句：`apiKey: "xxx"` / `PASSWORD='xxx'` / `"token": \`xxx\`` */
const ASSIGNMENT_PATTERN =
	/(?<keyQuote>["']?)(?<key>[A-Za-z_][A-Za-z0-9_.-]*)\k<keyQuote>\s*[:=]\s*(?<quote>["'`])(?<value>[^"'`\n]*)\k<quote>/g

/** 块状配置（YAML/TOML/properties）：`  password: xxx`（只吃行内空白，不能跨行） */
const BLOCK_PATTERN = /^([ \t]*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?[ \t]*[:=][ \t]*)([^\s"'#][^\n#]*)$/gm

export interface RedactResult {
	/** 打码后的内容 */
	text: string
	/** 命中次数（报告/日志用） */
	hits: number
}

/** 判断某个文件名是否 `.env` 类文件 */
export function isEnvFile(relPath: string): boolean {
	return ENV_FILE_PATTERN.test(relPath)
}

/**
 * 对一段源码打码。
 * 返回命中次数，0 表示原样返回（便于面板显示「未发现敏感信息」）。
 */
export function redactSecrets(input: string): RedactResult {
	if (!input) return { text: input, hits: 0 }
	let text = input
	let hits = 0

	// ① 厂商前缀 / 私钥块：整段替换
	for (const pattern of VENDOR_PATTERNS) {
		text = text.replace(pattern, () => {
			hits++
			return REDACTED
		})
	}

	// ② 赋值语句里「敏感键 + 像密钥的字面量」
	text = text.replace(ASSIGNMENT_PATTERN, (match: string, ...rest: unknown[]) => {
		const groups = rest[rest.length - 1] as { key?: string; quote?: string; value?: string }
		const key = groups?.key ?? ""
		const value = groups?.value ?? ""
		const quote = groups?.quote ?? '"'
		if (!SENSITIVE_KEY_PATTERN.test(key)) return match
		if (!SECRETISH_VALUE.test(`${quote}${value}${quote}`)) return match
		hits++
		return match.replace(value, REDACTED)
	})

	// ③ 块状配置（YAML/TOML/properties）
	text = text.replace(BLOCK_PATTERN, (line: string, prefix: string, key: string, value: string) => {
		if (!SENSITIVE_KEY_PATTERN.test(key)) return line
		const trimmed = value.trim()
		if (trimmed.length < 8 || /\s/.test(trimmed)) return line
		if (trimmed === REDACTED) return line
		hits++
		return `${prefix}${REDACTED}`
	})

	return { text, hits }
}

/** `.env` 文件：逐行打码敏感键（值整体替换，保留键名便于学生对照） */
export function redactEnvFile(content: string): RedactResult {
	if (!content) return { text: content, hits: 0 }
	let hits = 0
	const lines = content.split(/\r?\n/).map((line) => {
		const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/.exec(line)
		if (!match) return line
		const key = match[2] ?? ""
		const rawValue = (match[4] ?? "").trim()
		if (!rawValue || rawValue === REDACTED) return line
		if (!SENSITIVE_KEY_PATTERN.test(key)) return line
		hits++
		return `${match[1]}${key}${match[3]}${REDACTED}`
	})
	return { text: lines.join("\n"), hits }
}

/** 按文件类型选择打码策略 */
export function redactForFile(relPath: string, content: string): RedactResult {
	return isEnvFile(relPath) ? redactEnvFile(content) : redactSecrets(content)
}
