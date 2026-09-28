/**
 * =============================================================================
 *  LLMSettingsView — 教学 LLM 状态与偏好设置 WebviewView（v1.3 增量 / v2.11 改版）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 面向学生的教学 LLM **只读状态面板 + 本机偏好设置**：
 *   1. 展示教师在后端配置的 LLM 信息（provider / model / baseUrl / 密钥掩码，只读）
 *   2. "测试连接" → POST /api/v1/internal/llm-test-current（用后端已配置的 Key 测连通，学生无需填 Key）
 *   3. 工具调用答疑开关（karpathy 式）+ 教学限制模式开关（本机偏好，可保存）
 *   4. 【v2.9.2】"问题反馈"按钮 → 编辑器区反馈面板（窗口正中），避开侧栏高度限制
 *
 * 【数据流】
 *   加载：postMessage({command:'loadLLMSettings'})
 *     → 宿主读后端 GET /api/v1/internal/llm-status（只读、密钥脱敏）+ VS Code 本机偏好
 *   保存：postMessage({command:'saveLLMSettings', enableTools, pasteLimit})
 *     → 仅写 VS Code 全局配置（不再写本地 env、不再向后端推送密钥）
 *
 * 【v2.11 决策】
 *   - 教学 LLM 的 API Key / 模型 / Base URL 由教师直接写入 teaching-server/.env
 *   - 插件端**不再持有、不再保存、不再推送** API Key（此前掩码被当真 key 推送，
 *     覆盖有效密钥导致全部 LLM 功能 401；学生也无权修改教师配置）
 *   - 与 Cline 主对话模型仍解耦（本页配置仅用于教学功能）
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

/** 【v2.11】LLM 配置由教师维护，前端只读回显（密钥仅掩码） */
interface LLMSettingsStatus {
	configured: boolean
	provider?: string
	baseUrl?: string
	model?: string
	enableTools?: boolean
	/** 【v2.8】教学限制模式回显 */
	pasteLimit?: boolean
	/** API Key 掩码（由后端返回；前端不持有明文） */
	apiKeyMasked?: string
	/** 配置归属：teacher */
	managedBy?: string
	/** 未配置 / 后端不可达时的提示 */
	message?: string
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

// ============================================================================
//  组件
// ============================================================================

const LLMSettingsView: FC = () => {
	// ----- 状态 -----
	// 【v2.11】LLM 配置（模型 / Base URL / 密钥）由教师维护：前端仅只读展示后端返回的状态
	const [status, setStatus] = useState<LLMSettingsStatus>({ configured: false })
	const [enableTools, setEnableTools] = useState<boolean>(false)
	// 【v2.8】教学限制模式：启用后编辑器单次粘贴最多 5 行
	const [pasteLimit, setPasteLimit] = useState<boolean>(false)
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

	// ----- 加载配置状态（LLM 配置来自后端，本机偏好来自 VS Code 配置） -----
	useEffect(() => {
		const api = getVsCodeApi()
		if (!api) return
		api.postMessage({ type: "wiki_command", command: "loadLLMSettings" })

		const handler = (event: MessageEvent) => {
			const msg = event.data as WikiResponse
			if (msg?.command === "loadLLMSettings" && msg.success && msg.data) {
				const cfg = msg.data as LLMSettingsStatus
				// 【v2.11】只读展示教师配置的 LLM 信息（密钥仅掩码），不回填任何可编辑字段
				setStatus(cfg)
				if (typeof cfg.enableTools === "boolean") setEnableTools(cfg.enableTools)
				if (typeof cfg.pasteLimit === "boolean") setPasteLimit(cfg.pasteLimit)
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	// ----- 测试连接（用后端已配置的 Key 测连通，学生无需、也无法提供 Key） -----
	const onTest = useCallback(async () => {
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
		api.postMessage({ type: "wiki_command", command: "testLLMConnection" })
	}, [])

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
					// 【v2.11】保存的只是本机偏好；LLM 模型与密钥由教师统一配置
					setSavedNotice("✅ 本机偏好已保存（LLM 模型与密钥由教师统一配置）")
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

	// ----- 保存（仅本机偏好：工具调用开关 / 教学限制模式） -----
	const onSave = () => {
		setSaving(true)
		const api = getVsCodeApi()
		if (!api) {
			setSaving(false)
			return
		}
		api.postMessage({
			type: "wiki_command",
			command: "saveLLMSettings",
			enableTools,
			pasteLimit,
		})
	}

	// ----- 【v2.9.2】打开问题反馈（编辑器区面板，窗口正中） -----
	const onOpenFeedback = () => {
		const api = getVsCodeApi()
		if (!api) return
		api.postMessage({ type: "wiki_command", command: "openFeedback" })
	}

	// ----- 渲染 -----
	return (
		<div style={styles.container}>
			<h2 style={styles.title}>📚 教学 LLM 状态</h2>
			<p style={styles.subtitle}>
				教学 LLM 的模型、Base URL 与 API Key 由教师统一配置（写入教学服务器 teaching-server/.env）。
				<br />
				<span style={styles.warning}>
					⚠ 与 Cline 主对话模型解耦 —— 此处配置仅用于教学功能（资料清洗 / 约束答疑），不影响 AI 编程对话。
				</span>
			</p>

			{/* 【v2.11】服务端 LLM 配置：只读展示（教师维护，密钥仅掩码） */}
			<Section title="服务端 LLM 配置（教师维护 · 只读）">
				<div style={styles.statusCard}>
					{status.configured ? (
						<>
							<div style={styles.statusRow}>
								<span style={styles.statusKey}>模型</span>
								<span>{status.model ?? "-"}</span>
							</div>
							<div style={styles.statusRow}>
								<span style={styles.statusKey}>Base URL</span>
								<span style={{ wordBreak: "break-all" }}>{status.baseUrl ?? "-"}</span>
							</div>
							<div style={styles.statusRow}>
								<span style={styles.statusKey}>API Key</span>
								<span>{status.apiKeyMasked ?? "已配置"}</span>
							</div>
							<div style={styles.statusRow}>
								<span style={styles.statusKey}>服务商</span>
								<span>{status.provider ?? "-"}</span>
							</div>
						</>
					) : (
						<p style={{ ...styles.hint, margin: 0, color: "var(--vscode-editorWarning-foreground)" }}>
							⚠ {status.message ?? "服务端尚未配置 LLM"}
						</p>
					)}
				</div>
				<p style={styles.hint}>
					🔒 密钥由教师写入服务器 <code>.env</code>：插件端不保存、不上传，也无法修改。
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

			{/* 高级选项：工具调用答疑 + 教学限制模式（v2.8） */}
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

				<hr style={styles.divider} />

				{/* 教学限制模式：编辑器粘贴限行 */}
				<label style={styles.toggleRow}>
					<input
						checked={pasteLimit}
						onChange={(e) => setPasteLimit(e.target.checked)}
						style={{ marginRight: 8 }}
						type="checkbox"
					/>
					<span style={{ fontWeight: 600 }}>教学限制模式：限制编辑器粘贴（单次最多 5 行）</span>
				</label>
				<div style={styles.toggleHint}>
					<p>
						开启后，VS Code 编辑器内单次粘贴超过 5 行会被拦截并提示（防整段拷贝代码/答案）。 仅影响编辑器内
						Ctrl/⌘+V，关闭后立即恢复正常粘贴。
					</p>
					<p style={{ color: "var(--vscode-editorWarning-foreground)" }}>
						⚠ 属软限制：拖放插入、外部编辑器、终端粘贴不受限。
					</p>
				</div>
			</Section>

			<hr style={styles.divider} />

			{/* 保存：仅保存本机偏好（LLM 模型/密钥由教师维护，无需在此保存） */}
			<div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
				<button disabled={saving} onClick={onSave} style={{ ...styles.button, ...styles.primaryButton }}>
					{saving ? "保存中..." : "💾 保存本机偏好"}
				</button>
				<span style={{ fontSize: 11, color: "var(--vscode-descriptionForeground)" }}>
					仅保存工具调用开关与教学限制模式（LLM 配置由教师维护）
				</span>
			</div>
			{savedNotice && <div style={styles.notice}>{savedNotice}</div>}

			{/* 【v2.9.2】问题反馈入口 —— 在编辑器区（窗口正中）打开反馈面板，避开侧栏高度限制 */}
			<hr style={styles.divider} />
			<div style={{ display: "flex", alignItems: "center", gap: 12 }}>
				<button onClick={onOpenFeedback} style={{ ...styles.button, ...styles.secondaryButton }}>
					📝 问题反馈
				</button>
				<span style={{ fontSize: 11, color: "var(--vscode-descriptionForeground)" }}>
					发现 bug 或有改进建议？在窗口中心打开反馈表单
				</span>
			</div>

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
	statusCard: {
		padding: "8px 10px",
		border: "1px solid var(--vscode-panel-border)",
		borderRadius: 4,
		background: "var(--vscode-textBlockQuote-background)",
		fontSize: 12,
		lineHeight: 1.8,
	},
	statusRow: {
		display: "flex",
		gap: 8,
	},
	statusKey: {
		flex: "0 0 72px",
		color: "var(--vscode-descriptionForeground)",
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
