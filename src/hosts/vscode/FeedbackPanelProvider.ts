/**
 * =============================================================================
 *  FeedbackPanelProvider — 问题反馈编辑器区面板宿主（v2.9.2 增量）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 在编辑器区（工作台正中）以 WebviewPanel 标签页形式承载 FeedbackForm。
 * 为什么是面板而非侧栏弹窗：
 *   - LLM 设置视图是侧栏独立 webview，高度受用户布局限制，高弹窗显示不全
 *   - VS Code 表单类 UI 的标准范式即编辑器区面板（同设置界面 / 快捷键编辑器）
 *   - 单例：LLM 设置的"问题反馈"按钮重复点击只聚焦已有面板，不重复开
 *
 * 【消息路由】（与 webview 的 wiki_command 信封一致）
 *   - submitFeedback     → 校验 + 附加版本/平台元数据 → POST {serverUrl}/api/v1/feedback
 *   - closeFeedbackPanel → 关闭面板（提交成功自动关 / 用户点取消）
 *
 * 【触发链路】
 *   LLMSettingsView 按钮 → postMessage "openFeedback"
 *     → LLMSettingsViewProvider case "openFeedback" → 本类 reveal()
 *
 * =============================================================================
 */

import * as os from "os"
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"

export class FeedbackPanelProvider {
	/** WebviewPanel viewType（动态面板无需 package.json 声明） */
	public static readonly viewId = "clineFeedbackPanel"

	/** 由 LLMSettingsViewProvider 首次触发时创建 */
	private static _instance: FeedbackPanelProvider | null = null

	/** 当前面板（0/1 个，单例） */
	private _panel: vscode.WebviewPanel | null = null

	private constructor(private readonly _extensionUri: vscode.Uri) {}

	public static getInstance(extensionUri?: vscode.Uri): FeedbackPanelProvider {
		if (!FeedbackPanelProvider._instance) {
			if (!extensionUri) {
				throw new Error("FeedbackPanelProvider 首次创建必须传入 extensionUri")
			}
			FeedbackPanelProvider._instance = new FeedbackPanelProvider(extensionUri)
		}
		return FeedbackPanelProvider._instance
	}

	// ============================================================================
	//  面板生命周期
	// ============================================================================

	/** 打开或聚焦反馈面板（编辑器区，窗口正中） */
	public reveal(): void {
		if (this._panel) {
			this._panel.reveal()
			return
		}

		const panel = vscode.window.createWebviewPanel(FeedbackPanelProvider.viewId, "📝 问题反馈", vscode.ViewColumn.Active, {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
			// 表单填写中途切换标签不丢已填内容（面板存续期间保留 webview 状态）
			retainContextWhenHidden: true,
		})
		this._panel = panel

		panel.webview.html = this._getHtmlForWebview(panel.webview)

		// 监听随面板销毁自动清理（WebviewPanel 生命周期即订阅生命周期）
		panel.webview.onDidReceiveMessage((msg: Record<string, unknown>) => this._handleMessage(msg))

		panel.onDidDispose(() => {
			this._panel = null
		})
	}

	// ============================================================================
	//  消息分发
	// ============================================================================

	private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
		const cmd = msg["command"] as string | undefined
		const post = (response: Record<string, unknown>) => {
			this._panel?.webview.postMessage(response)
		}

		try {
			switch (cmd) {
				case "submitFeedback": {
					// 与 LLMSettingsViewProvider v2.9 的转发逻辑一致
					const category = (msg["category"] as string) ?? "other"
					const content = (msg["content"] as string) ?? ""
					const studentId = (msg["studentId"] as string) ?? ""

					if (!content.trim() || content.length > 5000) {
						post({ command: "submitFeedback", success: false, error: "反馈内容必须为 1~5000 字符" })
						return
					}

					const serverUrl = this._getServerUrl()
					try {
						const resp = await fetch(`${serverUrl}/api/v1/feedback`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								category,
								content: content.trim(),
								studentId: studentId.trim(),
								extensionVersion: ExtensionRegistryInfo.version,
								platform: `${os.platform()} ${os.release()}`,
							}),
						})
						const data = (await resp.json()) as { ok: boolean; message?: string }
						if (!resp.ok || !data.ok) {
							post({
								command: "submitFeedback",
								success: false,
								error: data.message ?? `提交失败 (HTTP ${resp.status})`,
							})
							return
						}
						post({ command: "submitFeedback", success: true, data })
						Logger.log("[FeedbackPanelProvider] 学生反馈已提交")
					} catch (e) {
						// 网络不可达时给出友好提示（校园网/热点下间歇性 RST 为已知问题）
						const rawMsg = e instanceof Error ? e.message : String(e)
						const isFetchFailed = /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT/i.test(rawMsg)
						const friendlyMsg = isFetchFailed
							? `无法连接服务器 ${serverUrl}，请稍后重试；若持续失败可尝试切换网络`
							: `提交失败: ${rawMsg}`
						post({ command: "submitFeedback", success: false, error: friendlyMsg })
						Logger.warn(`[FeedbackPanelProvider] submitFeedback 失败: ${rawMsg}`)
					}
					break
				}

				case "closeFeedbackPanel": {
					this._panel?.dispose()
					break
				}

				default:
					post({ command: cmd ?? "unknown", success: false, error: "unknown command" })
			}
		} catch (e) {
			Logger.error("[FeedbackPanelProvider] handleMessage 异常:", e)
			post({ command: cmd ?? "unknown", success: false, error: e instanceof Error ? e.message : String(e) })
		}
	}

	// ============================================================================
	//  配置
	// ============================================================================

	private _getServerUrl(): string {
		const cfg = vscode.workspace.getConfiguration("clineTeaching")
		const v = cfg.get<string>("serverUrl")
		if (v && v.trim()) return v.trim()
		// fallback 到旧配置
		const oldCfg = vscode.workspace.getConfiguration("teaching")
		const oldV = oldCfg.get<string>("apiBase")
		if (oldV && oldV.trim()) return oldV.trim()
		return "http://localhost:4001"
	}

	// ============================================================================
	//  HTML 渲染（与 LLMSettingsViewProvider 对齐，data-view 换为反馈面板）
	// ============================================================================

	private _getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "index.js"),
		)
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
  <title>问题反馈</title>
</head>
<body>
  <div id="root" data-view="clineFeedbackPanel"></div>
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
