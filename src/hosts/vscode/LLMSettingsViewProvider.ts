/**
 * =============================================================================
 *  LLMSettingsViewProvider — 教学 LLM 设置 WebviewView 容器（v1.3 增量）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 在 VS Code 侧边栏注册独立的 WebviewView，承载 LLMSettingsView.tsx UI。
 * 处理四类 IPC 消息：
 *   - loadLLMSettings    → 回填当前配置（apiKey 仅返回掩码）
 *   - saveLLMSettings    → 写本地 ~/.cline/teaching-llm.env + 推送到后端
 *   - testLLMConnection  → 转发到后端 /api/v1/internal/llm-test
 *   - openFeedback       → 【v2.9.2】打开编辑器区反馈面板（FeedbackPanelProvider）
 *
 * 【与现有模式的对齐】
 * 借鉴 VscodeWebviewProvider 的 message 路由模式，但本类独立工作：
 *   - 不依赖 WebviewProvider 单例
 *   - 自己的 disposables 数组管理生命周期
 *
 * =============================================================================
 */

import * as vscode from "vscode"
import { FeedbackPanelProvider } from "@/hosts/vscode/FeedbackPanelProvider"
import { Logger } from "@/shared/services/Logger"
import { DEFAULT_SERVER_URL, describeTestConnectionFailure, normalizeServerUrl } from "@/core/teaching/serverUrl"

// ============================================================================
//  类型定义
// ============================================================================

/** 【v2.11】本机教学偏好：LLM 的密钥/模型/Base URL 由教师维护，插件端只保存本机开关 */
export interface LocalTeachingPrefs {
	enableTools: boolean
	/** 【v2.8】教学限制模式：编辑器粘贴限行开关（可选，向后兼容） */
	pasteLimit?: boolean
}

/** 回填到前端的只读状态（LLM 配置来自后端只读接口，密钥仅掩码） */
export interface LLMSettingsStatus {
	configured: boolean
	provider?: string
	baseUrl?: string
	model?: string
	enableTools?: boolean
	/** 【v2.8】教学限制模式回显（以 VS Code 配置为准，其为生效开关） */
	pasteLimit?: boolean
	/** API Key 掩码（由后端返回；插件端不持有明文） */
	apiKeyMasked?: string
	/** 【v2.11】配置归属标识：teacher */
	managedBy?: string
	/** 未配置 / 后端不可达时的提示文案 */
	message?: string
}

// ============================================================================
//  Provider 实现
// ============================================================================

export class LLMSettingsViewProvider implements vscode.WebviewViewProvider {
	/** 注册到 package.json contributes.views 的 viewId */
	public static readonly viewId = "clineLLMSettings"

	/** 由 extension.ts 在 activate 时创建一次 */
	private static _instance: LLMSettingsViewProvider | null = null

	/** 当前激活的 webview（可能有 0/1 个） */
	private _view: vscode.WebviewView | null = null

	/** 订阅 disposable 数组 */
	private readonly _disposables: vscode.Disposable[] = []

	private constructor(private readonly _extensionUri: vscode.Uri) {}

	public static getInstance(extensionUri?: vscode.Uri): LLMSettingsViewProvider {
		if (!LLMSettingsViewProvider._instance) {
			if (!extensionUri) {
				throw new Error("LLMSettingsViewProvider 首次创建必须传入 extensionUri")
			}
			LLMSettingsViewProvider._instance = new LLMSettingsViewProvider(extensionUri)
		}
		return LLMSettingsViewProvider._instance
	}

	// ============================================================================
	//  WebviewViewProvider 接口实现
	// ============================================================================

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this._view = webviewView

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		}

		webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

		// 注册消息监听
		webviewView.webview.onDidReceiveMessage(
			(msg: Record<string, unknown>) => this._handleMessage(msg),
			null,
			this._disposables,
		)

		// 视图被关闭时清理
		webviewView.onDidDispose(
			() => {
				this._view = null
			},
			null,
			this._disposables,
		)
	}

	public dispose(): void {
		while (this._disposables.length) {
			const d = this._disposables.pop()
			d?.dispose()
		}
		LLMSettingsViewProvider._instance = null
	}

	// ============================================================================
	//  消息分发
	// ============================================================================

	private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
		const cmd = msg["command"] as string | undefined
		const post = (response: Record<string, unknown>) => {
			this._view?.webview.postMessage(response)
		}

		try {
			switch (cmd) {
				case "loadLLMSettings": {
					// 【v2.11】LLM 配置（含密钥）由教师维护，插件端只读回显 + 读取本机偏好
					const status = await this._loadStatus()
					post({ command: "loadLLMSettings", success: true, data: status })
					break
				}

				case "saveLLMSettings": {
					// 【v2.11】只保存本机偏好（工具调用开关 / 教学限制模式）。
					// API Key / 模型 / Base URL 由教师写入 teaching-server/.env，插件端不再保存与推送
					// （历史事故：插件把掩码 "sk-x...1234" 当真的 key 推送，覆盖有效密钥导致全部 LLM 功能 401）
					const prefs: LocalTeachingPrefs = {
						enableTools: Boolean(msg["enableTools"]),
						// 【v2.8】教学限制模式（未传则不改变现有开关状态）
						pasteLimit: typeof msg["pasteLimit"] === "boolean" ? (msg["pasteLimit"] as boolean) : undefined,
					}

					await this._syncVSCodeConfig(prefs)

					post({ command: "saveLLMSettings", success: true })
					Logger.log("[LLMSettingsViewProvider] 本机教学偏好已保存（LLM 密钥由教师维护）")
					break
				}

				case "testLLMConnection": {
					// 【v2.11】用后端已配置的 Key 测试 LLM 连通性（学生无需、也无法提供 Key）：
					// 既验证"插件 ↔ 教学服务器"连通，也验证"服务器 ↔ LLM 供应商"是否可用。
					// 【2026-10-25 线上修复】两点：
					// 1) 地址必须归一化（去尾斜杠）再拼路径 —— 学生填 `http://host/` 时会拼出
					//    `http://host//api/v1/...`，nginx/Express 返回 404 HTML；
					// 2) 不再盲信 `resp.json()` —— 失败时后端返回的是 HTML 错误页/SPA 回退页，
					//    直接解析只会抛 `Unexpected token '<', "<!DOCTYPE "...`，学生无法定位。
					const serverUrl = this._getServerUrl()
					try {
						const resp = await fetch(`${serverUrl}/api/v1/internal/llm-test-current`, { method: "POST" })
						const rawBody = await resp.text()
						type LlmTestResponse = { ok?: boolean; message?: string; model?: string; provider?: string }
						let data: LlmTestResponse | null = null
						try {
							data = rawBody.trim() ? (JSON.parse(rawBody) as LlmTestResponse) : null
						} catch {
							data = null
						}
						if (!data) {
							const reason = describeTestConnectionFailure({
								serverUrl,
								status: resp.status,
								contentType: resp.headers.get("content-type"),
								body: rawBody,
							})
							post({ command: "testLLMConnection", success: false, error: reason })
							Logger.warn(
								`[LLMSettingsViewProvider] llm-test-current 返回非 JSON（HTTP ${resp.status}）: ${rawBody.slice(0, 120)}`,
							)
							break
						}
						post({
							command: "testLLMConnection",
							success: Boolean(data.ok),
							data,
							error: data.ok ? undefined : (data.message ?? `HTTP ${resp.status}`),
						})
					} catch (e) {
						const rawMsg = e instanceof Error ? e.message : String(e)
						post({
							command: "testLLMConnection",
							success: false,
							error: describeTestConnectionFailure({ serverUrl, error: e }),
						})
						Logger.warn(`[LLMSettingsViewProvider] llm-test-current 不可达: ${rawMsg}`)
					}
					break
				}

				case "openFeedback": {
					// 【v2.9.2】LLM 设置页"问题反馈"按钮 → 编辑器区反馈面板（窗口正中，FeedbackForm 全页渲染）
					FeedbackPanelProvider.getInstance(this._extensionUri).reveal()
					break
				}

				default:
					post({ command: cmd ?? "unknown", success: false, error: "unknown command" })
			}
		} catch (e) {
			Logger.error("[LLMSettingsViewProvider] handleMessage 异常:", e)
			post({ command: cmd ?? "unknown", success: false, error: e instanceof Error ? e.message : String(e) })
		}
	}

	// ============================================================================
	//  配置读取（LLM 配置来自后端只读接口；本机偏好来自 VS Code 配置）
	// ============================================================================

	/**
	 * 【v2.11】读取配置状态：
	 *   - LLM 配置（provider / model / baseUrl / 密钥掩码）→ 后端只读接口（教师维护，插件不持有明文）
	 *   - 本机偏好（工具调用开关 / 教学限制模式）→ VS Code 全局配置
	 *
	 * 注：此前实现会写本地 ~/.cline/teaching-llm.env 并推送密钥到后端 .env；
	 *     因"掩码被当真的 key 写入"覆盖有效密钥（导致全部 LLM 功能 401），该链路已彻底移除。
	 */
	private async _loadStatus(): Promise<LLMSettingsStatus> {
		const cfg = vscode.workspace.getConfiguration("clineTeaching")
		const pasteLimit = cfg.get<boolean>("pasteLimitEnabled")
		const enableTools = cfg.get<boolean>("llmEnableTools") ?? false
		const base: LLMSettingsStatus = { configured: false, enableTools, pasteLimit }

		try {
			const resp = await fetch(`${this._getServerUrl()}/api/v1/internal/llm-status`)
			const data = (await resp.json()) as LLMSettingsStatus & { ok?: boolean }
			return {
				...base,
				configured: Boolean(data.configured),
				provider: data.provider,
				baseUrl: data.baseUrl,
				model: data.model,
				apiKeyMasked: data.apiKeyMasked,
				managedBy: data.managedBy,
				message: data.message,
			}
		} catch {
			// 后端不可达：仍返回本机偏好，便于学生查看/修改本机开关
			return { ...base, message: "无法连接教学服务器，未能读取 LLM 配置状态" }
		}
	}

	// ============================================================================
	//  配置同步
	// ============================================================================

	private _getServerUrl(): string {
		const cfg = vscode.workspace.getConfiguration("clineTeaching")
		const v = cfg.get<string>("serverUrl")
		if (v && v.trim()) return normalizeServerUrl(v)
		// fallback 到旧配置
		const oldCfg = vscode.workspace.getConfiguration("teaching")
		const oldV = oldCfg.get<string>("apiBase")
		if (oldV && oldV.trim()) return normalizeServerUrl(oldV)
		return DEFAULT_SERVER_URL
	}

	/** 【v2.11】只同步本机偏好（不再写 llmPresetModel —— 模型由教师在后端 .env 维护） */
	private async _syncVSCodeConfig(p: LocalTeachingPrefs): Promise<void> {
		const cfg = vscode.workspace.getConfiguration("clineTeaching")
		await cfg.update("llmEnableTools", p.enableTools, vscode.ConfigurationTarget.Global)
		// 【v2.8】教学限制模式：同步到 pasteLimitEnabled（键绑定 when 子句的生效开关）
		if (typeof p.pasteLimit === "boolean") {
			await cfg.update("pasteLimitEnabled", p.pasteLimit, vscode.ConfigurationTarget.Global)
		}
	}

	// ============================================================================
	//  HTML 渲染
	// ============================================================================

	private _getHtmlForWebview(webview: vscode.Webview): string {
		// 复用主 webview 入口（与 WebviewProvider.getHtmlContent 对齐）
		// 注意：v1.3 此 view 渲染的是与主 webview 共享的 React 应用，由前端按 viewType 区分页面
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "index.js"),
		)
		// 【v2.8】补齐样式表引用：此前只加载 JS 未加载 index.css/codicon.css，
		// 存在样式与字体图标加载失败的同源隐患（codicon 由 scripts/copy-codicons.mjs 拷入产物）
		const stylesUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "index.css"),
		)
		const codiconsUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "codicon.css"),
		)
		const nonce = getNonce()
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${stylesUri}">
  <link rel="stylesheet" href="${codiconsUri}">
  <title>LLM 设置</title>
</head>
<body>
  <div id="root" data-view="clineLLMSettings"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`
	}
}

/** 生成 CSP nonce */
function getNonce(): string {
	let text = ""
	const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length))
	}
	return text
}
