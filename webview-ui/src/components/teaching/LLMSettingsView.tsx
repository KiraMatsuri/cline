/**
 * =============================================================================
 *  LLMSettingsView — 教学 LLM 设置 WebviewView（v1.3 增量）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 提供给学生的 LLM API 配置面板：
 *   1. 预置模型下拉框（GPT-4o-mini / GPT-4o / Claude-3.5 / DeepSeek / Qwen-Long / 自定义）
 *   2. 选择模型后自动填充 baseUrl
 *   3. 手动填写 API Key（密码框）
 *   4. "测试连接"按钮 → POST /api/v1/internal/llm-test
 *   5. 工具调用答疑开关（karpathy 式）+ 说明文案
 *   6. "保存"按钮 → 写本地 ~/.cline/teaching-llm.env + 推送到后端
 *
 * 【数据流】
 *   学生填写 → postMessage({command: 'saveLLMSettings', ...})
 *     → 插件主进程写 ~/.cline/teaching-llm.env
 *     → POST /api/v1/internal/llm-env → 后端写 teaching-server/.env
 *     → 后端热加载 LLM 配置（无需重启）
 *
 * 【v1.3 决策】
 *   - 8.A：API Key 走插件设置页 → 后端 .env（与 Cline 主对话模型解耦）
 *   - 8.C：工具调用开关默认关闭 + 设置页开启提示
 *
 * =============================================================================
 */

import type { FC } from "react"
import { useCallback, useEffect, useState } from "react"
import { getVsCodeApiInstance } from "@/config/platform.config"
import ResponsiveModal from "../common/ResponsiveModal"

// ============================================================================
//  类型定义
// ============================================================================

/** 预置模型定义 */
interface PresetModel {
	id: string
	label: string
	baseUrl: string
}

/** 保存到 .env 的完整 LLM 配置 */
export interface LLMSettings {
	provider: string
	baseUrl: string
	apiKey: string
	model: string
	enableTools: boolean
}

/** 加载时回填的数据（不含 apiKey，只显示是否已配置） */
interface LLMSettingsStatus {
	configured: boolean
	provider?: string
	baseUrl?: string
	model?: string
	enableTools?: boolean
	/** API Key 仅显示前 4 位 + 后 4 位，中间省略 */
	apiKeyMasked?: string
}

/** Extension → Webview 的响应 */
interface WikiResponse {
	command: string
	success: boolean
	data?: unknown
	error?: string
}

/** VS Code API 抽象 */
interface VsCodeApi {
	postMessage(message: Record<string, unknown>): void
	getState(): Record<string, unknown> | undefined
	setState(state: Record<string, unknown>): void
}

// ============================================================================
//  常量
// ============================================================================

/** 预置模型列表（v1.3 决策） */
const PRESET_MODELS: PresetModel[] = [
	{ id: "gpt-4o-mini", label: "GPT-4o-mini (OpenAI) · 推荐", baseUrl: "https://api.openai.com/v1" },
	{ id: "gpt-4o", label: "GPT-4o (OpenAI)", baseUrl: "https://api.openai.com/v1" },
	{
		id: "claude-3-5-sonnet-20241022",
		label: "Claude 3.5 Sonnet (Anthropic)",
		baseUrl: "https://api.anthropic.com/v1",
	},
	{ id: "deepseek-chat", label: "DeepSeek Chat", baseUrl: "https://api.deepseek.com/v1" },
	{
		id: "qwen-long",
		label: "通义千问 Qwen-Long (DashScope)",
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	},
	{ id: "custom", label: "自定义（手动填 baseUrl）", baseUrl: "" },
]

/** 从 model id 推断 provider（用于 .env 的 TEACHING_LLM_PROVIDER 字段） */
function inferProvider(modelId: string): string {
	if (modelId.startsWith("gpt-")) return "openai"
	if (modelId.startsWith("claude-")) return "anthropic"
	if (modelId.startsWith("deepseek-")) return "deepseek"
	if (modelId.startsWith("qwen-")) return "qwen"
	return "custom"
}

// ============================================================================
//  组件
// ============================================================================

const LLMSettingsView: FC = () => {
	// ----- 状态 -----
	const [selectedModelId, setSelectedModelId] = useState<string>("gpt-4o-mini")
	const [baseUrl, setBaseUrl] = useState<string>(PRESET_MODELS[0].baseUrl)
	const [apiKey, setApiKey] = useState<string>("")
	const [enableTools, setEnableTools] = useState<boolean>(false)
	const [testing, setTesting] = useState<boolean>(false)
	const [saving, setSaving] = useState<boolean>(false)
	const [testStatus, setTestStatus] = useState<"idle" | "success" | "fail">("idle")
	const [testMessage, setTestMessage] = useState<string>("")
	const [savedNotice, setSavedNotice] = useState<string>("")
	const [toolsConfirmVisible, setToolsConfirmVisible] = useState<boolean>(false)

	// ----- VS Code API -----
	const getVsCodeApi = (): VsCodeApi | null => {
		const api = getVsCodeApiInstance()
		if (!api) {
			console.warn("[LLMSettingsView] VS Code API 不可用")
			return null
		}
		return api as VsCodeApi
	}

	// ----- 加载已有配置 -----
	useEffect(() => {
		const api = getVsCodeApi()
		if (!api) return
		api.postMessage({ type: "wiki_command", command: "loadLLMSettings" })

		const handler = (event: MessageEvent) => {
			const msg = event.data as WikiResponse
			if (msg?.command === "loadLLMSettings" && msg.success && msg.data) {
				const cfg = msg.data as LLMSettingsStatus
				if (cfg.model && PRESET_MODELS.some((m) => m.id === cfg.model)) {
					setSelectedModelId(cfg.model)
				} else if (cfg.model) {
					setSelectedModelId("custom")
				}
				if (cfg.baseUrl) setBaseUrl(cfg.baseUrl)
				if (cfg.apiKeyMasked) setApiKey(cfg.apiKeyMasked) // 仅做占位提示，不回填真值
				if (typeof cfg.enableTools === "boolean") setEnableTools(cfg.enableTools)
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	// ----- 切换模型时自动填 baseUrl -----
	const onModelChange = (modelId: string) => {
		setSelectedModelId(modelId)
		if (modelId !== "custom") {
			const preset = PRESET_MODELS.find((m) => m.id === modelId)
			if (preset) setBaseUrl(preset.baseUrl)
		}
	}

	// ----- 测试连接 -----
	const onTest = useCallback(async () => {
		if (!apiKey || !baseUrl || !selectedModelId || selectedModelId === "custom") {
			setTestStatus("fail")
			setTestMessage("请填写完整的 baseUrl / API Key / 模型")
			return
		}
		if (selectedModelId === "custom" && !baseUrl.trim()) {
			setTestStatus("fail")
			setTestMessage("自定义模式必须填写 baseUrl")
			return
		}

		setTesting(true)
		setTestStatus("idle")
		setTestMessage("")
		const api = getVsCodeApi()
		if (!api) {
			setTesting(false)
			setTestStatus("fail")
			setTestMessage("VS Code API 不可用")
			return
		}
		api.postMessage({
			type: "wiki_command",
			command: "testLLMConnection",
			baseUrl,
			apiKey,
			model: selectedModelId,
		})
	}, [apiKey, baseUrl, selectedModelId])

	// ----- 监听测试结果 -----
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const msg = event.data as WikiResponse
			if (msg?.command === "testLLMConnection") {
				setTesting(false)
				if (msg.success) {
					setTestStatus("success")
					setTestMessage((msg.data as { message?: string })?.message ?? "连接成功")
				} else {
					setTestStatus("fail")
					setTestMessage(msg.error ?? "连接失败")
				}
			}
			if (msg?.command === "saveLLMSettings") {
				setSaving(false)
				if (msg.success) {
					setSavedNotice("✅ 已保存到本地 + 后端 .env（热加载立即生效）")
					setTimeout(() => setSavedNotice(""), 3500)
				} else {
					setSavedNotice(`❌ 保存失败：${msg.error ?? "未知错误"}`)
				}
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	// ----- 切换工具调用开关的二次确认 -----
	const onToolsToggle = (next: boolean) => {
		if (next && !enableTools) {
			// 由关→开：弹确认
			setToolsConfirmVisible(true)
		} else {
			setEnableTools(next)
		}
	}

	const confirmTools = () => {
		setEnableTools(true)
		setToolsConfirmVisible(false)
	}

	// ----- 保存 -----
	const onSave = () => {
		if (!apiKey || !baseUrl || !selectedModelId) {
			setSavedNotice("❌ 请填写完整的配置")
			return
		}
		setSaving(true)
		const api = getVsCodeApi()
		if (!api) return
		api.postMessage({
			type: "wiki_command",
			command: "saveLLMSettings",
			provider: inferProvider(selectedModelId),
			baseUrl,
			apiKey,
			model: selectedModelId,
			enableTools,
		})
	}

	// ----- 恢复默认 -----
	const onReset = () => {
		setSelectedModelId("gpt-4o-mini")
		setBaseUrl(PRESET_MODELS[0].baseUrl)
		setApiKey("")
		setEnableTools(false)
		setTestStatus("idle")
		setTestMessage("")
	}

	// ----- 渲染 -----
	return (
		<div style={styles.container}>
			<h2 style={styles.title}>📚 教学 LLM 设置</h2>
			<p style={styles.subtitle}>
				为 Wiki 资料清洗与工具调用答疑配置 LLM。
				<br />
				<span style={styles.warning}>⚠ 与 Cline 主对话模型解耦 —— 此处的配置仅用于教学功能，不会影响 AI 编程对话。</span>
			</p>

			{/* 模型选择 */}
			<Section title="模型选择">
				<select onChange={(e) => onModelChange(e.target.value)} style={styles.select} value={selectedModelId}>
					{PRESET_MODELS.map((m) => (
						<option key={m.id} value={m.id}>
							{m.label}
						</option>
					))}
				</select>
				<p style={styles.hint}>选择预置模型后，baseUrl 会自动填充。也可选"自定义"手动填 baseUrl。</p>
			</Section>

			{/* Base URL */}
			<Section title="Base URL">
				<input
					disabled={selectedModelId !== "custom"}
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder="https://api.openai.com/v1"
					style={styles.input}
					type="text"
					value={baseUrl}
				/>
			</Section>

			{/* API Key */}
			<Section title="API Key">
				<input
					autoComplete="off"
					onChange={(e) => setApiKey(e.target.value)}
					placeholder="sk-..."
					style={styles.input}
					type="password"
					value={apiKey}
				/>
				<p style={styles.hint}>
					🔒 API Key 仅写入本地 <code>~/.cline/teaching-llm.env</code> 与后端 <code>teaching-server/.env</code>
					，不会上传至任何远程。
				</p>
			</Section>

			{/* 测试连接 */}
			<div style={{ marginTop: 16 }}>
				<button disabled={testing} onClick={onTest} style={{ ...styles.button, ...styles.secondaryButton }}>
					{testing ? "测试中..." : "🔌 测试连接"}
				</button>
				{testStatus !== "idle" && (
					<span
						style={{
							marginLeft: 12,
							color:
								testStatus === "success" ? "var(--vscode-terminal-ansiGreen)" : "var(--vscode-errorForeground)",
							fontSize: 13,
						}}>
						{testStatus === "success" ? "✅" : "❌"} {testMessage}
					</span>
				)}
			</div>

			<hr style={styles.divider} />

			{/* 高级选项：工具调用答疑 */}
			<Section title="⚙ 高级选项">
				<label style={styles.toggleRow}>
					<input
						checked={enableTools}
						onChange={(e) => onToolsToggle(e.target.checked)}
						style={{ marginRight: 8 }}
						type="checkbox"
					/>
					<span style={{ fontWeight: 600 }}>启用 karpathy 式工具调用答疑</span>
				</label>
				<div style={styles.toggleHint}>
					<p>
						开启后，跨周复杂问题（如"对比第 3 周和第 7 周的概念"）将由 LLM 自主调用 grep_wiki / read_chunk 工具检索
						Wiki。
					</p>
					<p style={{ color: "var(--vscode-editorWarning-foreground)" }}>
						⚠ 开启后：
						<br />• 平均 token 消耗增加 30%~80%
						<br />• 答疑延迟可能 +2~5 秒
						<br />• 建议在"对比"、"综合"类提问时开启
					</p>
				</div>
			</Section>

			<hr style={styles.divider} />

			{/* 保存按钮 */}
			<div style={{ display: "flex", gap: 12 }}>
				<button disabled={saving} onClick={onSave} style={{ ...styles.button, ...styles.primaryButton }}>
					{saving ? "保存中..." : "💾 保存"}
				</button>
				<button onClick={onReset} style={{ ...styles.button, ...styles.secondaryButton }}>
					🔄 恢复默认
				</button>
			</div>
			{savedNotice && <div style={styles.notice}>{savedNotice}</div>}

			{/* 工具调用开启确认弹窗 */}
			{toolsConfirmVisible && (
				<ResponsiveModal maxWidth={420} onClose={() => setToolsConfirmVisible(false)} visible={toolsConfirmVisible}>
					<h3 style={{ marginTop: 0 }}>⚠ 启用工具调用答疑</h3>
					<p>启用后：</p>
					<ul>
						<li>跨周复杂问题将由 LLM 自主检索 Wiki</li>
						<li>平均 token 消耗增加 30%~80%</li>
						<li>答疑延迟可能 +2~5 秒</li>
						<li>建议在"对比"、"综合"类提问时启用</li>
					</ul>
					<p>是否确认开启？</p>
					<div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
						<button
							onClick={() => setToolsConfirmVisible(false)}
							style={{ ...styles.button, ...styles.secondaryButton }}>
							取消
						</button>
						<button onClick={confirmTools} style={{ ...styles.button, ...styles.primaryButton }}>
							确认开启
						</button>
					</div>
				</ResponsiveModal>
			)}
		</div>
	)
}

// ============================================================================
//  子组件与样式
// ============================================================================

const Section: FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
	<div style={{ marginBottom: 14 }}>
		<label style={styles.label}>{title}</label>
		{children}
	</div>
)

const styles: Record<string, React.CSSProperties> = {
	container: {
		padding: "16px 20px",
		maxWidth: 600,
		color: "var(--vscode-foreground)",
		fontSize: 13,
	},
	title: { margin: "0 0 6px 0", fontSize: 18, fontWeight: 700 },
	subtitle: {
		margin: "0 0 18px 0",
		fontSize: 12,
		color: "var(--vscode-descriptionForeground)",
		lineHeight: 1.6,
	},
	warning: { color: "var(--vscode-editorWarning-foreground)" },
	label: { display: "block", marginBottom: 6, fontWeight: 600 },
	select: {
		width: "100%",
		padding: "6px 10px",
		background: "var(--vscode-input-background)",
		color: "var(--vscode-input-foreground)",
		border: "1px solid var(--vscode-input-border)",
		borderRadius: 4,
		fontSize: 13,
	},
	input: {
		width: "100%",
		padding: "6px 10px",
		background: "var(--vscode-input-background)",
		color: "var(--vscode-input-foreground)",
		border: "1px solid var(--vscode-input-border)",
		borderRadius: 4,
		fontSize: 13,
		boxSizing: "border-box",
	},
	hint: {
		margin: "4px 0 0 0",
		fontSize: 11,
		color: "var(--vscode-descriptionForeground)",
		lineHeight: 1.5,
	},
	button: {
		padding: "8px 18px",
		border: "none",
		borderRadius: 4,
		fontSize: 13,
		fontWeight: 600,
		cursor: "pointer",
	},
	primaryButton: {
		background: "var(--vscode-button-background)",
		color: "var(--vscode-button-foreground)",
	},
	secondaryButton: {
		background: "var(--vscode-button-secondaryBackground)",
		color: "var(--vscode-button-secondaryForeground)",
	},
	divider: {
		margin: "20px 0",
		border: "none",
		borderTop: "1px solid var(--vscode-panel-border)",
	},
	toggleRow: {
		display: "flex",
		alignItems: "center",
		cursor: "pointer",
	},
	toggleHint: {
		marginTop: 8,
		paddingLeft: 24,
		fontSize: 11,
		color: "var(--vscode-descriptionForeground)",
		lineHeight: 1.6,
	},
	notice: {
		marginTop: 12,
		padding: 10,
		borderRadius: 4,
		background: "var(--vscode-textBlockQuote-background)",
		fontSize: 12,
	},
	modalOverlay: {
		position: "fixed",
		inset: 0,
		background: "rgba(0,0,0,0.4)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 9999,
	},
	modal: {
		background: "var(--vscode-editor-background)",
		border: "1px solid var(--vscode-panel-border)",
		padding: 20,
		borderRadius: 6,
		maxWidth: 420,
		fontSize: 13,
	},
}

export default LLMSettingsView
