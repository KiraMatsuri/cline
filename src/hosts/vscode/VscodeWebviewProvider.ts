import { sendShowWebviewEvent } from "@core/controller/ui/subscribeToShowWebview"
import { WebviewProvider } from "@core/webview"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import type { AssignmentMessage } from "@/core/teaching/AssignmentManager"
import { AssignmentManager } from "@/core/teaching/AssignmentManager"
import { LLMWikiService } from "@/core/teaching/LLMWikiService"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { WebviewMessage } from "@/shared/WebviewMessage"

/**
 * Wiki 资料管理 + 进度感知 RAG 的 IPC 消息协议（v1.3 增量）
 * Webview → Extension 单向消息，response 通过 postMessageToWebview 回传
 */
export type WikiCommand =
	| { type: "wiki_command"; command: "switchWeek"; week: number }
	| { type: "wiki_command"; command: "fetchWiki"; week: number }
	| { type: "wiki_command"; command: "updateServerUrl"; url: string }
	| { type: "wiki_command"; command: "loadHeaderState" }
	| { type: "wiki_command"; command: "loadLLMSettings" }
	| {
			type: "wiki_command"
			command: "saveLLMSettings"
			provider: string
			baseUrl: string
			apiKey: string
			model: string
			enableTools: boolean
			/** 【v2.8】教学限制模式（可选，旧版前端不传） */
			pasteLimit?: boolean
	  }
	| { type: "wiki_command"; command: "testLLMConnection"; baseUrl: string; apiKey: string; model: string }

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/

export class VscodeWebviewProvider extends WebviewProvider implements vscode.WebviewViewProvider {
	// Used in package.json as the view's id. This value cannot be changed due to how vscode caches
	// views based on their id, and updating the id would break existing instances of the extension.
	public static readonly SIDEBAR_ID = ExtensionRegistryInfo.views.Sidebar

	private webview?: vscode.WebviewView
	private disposables: vscode.Disposable[] = []

	/**
	 * 实验任务管理模块（获取任务、提交实验）
	 *
	 * 【方案 B — 运行时配置注入】
	 * 这里直接调用 refreshApiBaseFromConfig()，从 VS Code 配置 teaching.apiBase
	 * 读取地址；若用户修改了配置，listenConfigChanges() 会自动同步。
	 * 卸载时通过 context.subscriptions 调用 dispose()。
	 */
	public assignmentManager: AssignmentManager = (() => {
		const m = new AssignmentManager()
		m.refreshApiBaseFromConfig()
		m.listenConfigChanges()
		// 【v2.5】自动日志路径：工作区变化时创建/检测 student_interactions.log。
		// 必须在持有 IPC 分发能力的同一个实例上调用，确保 queryAutoLogPath
		// 能拿到同一份 cachedAutoLogPath（与 extension.ts 的独立实例隔离）。
		m.startWatchingWorkspaceOpen()
		return m
	})()

	override getWebviewUrl(path: string) {
		if (!this.webview) {
			throw new Error("Webview not initialized")
		}
		const uri = this.webview.webview.asWebviewUri(vscode.Uri.file(path))
		return uri.toString()
	}

	override getCspSource() {
		if (!this.webview) {
			throw new Error("Webview not initialized")
		}
		return this.webview.webview.cspSource
	}

	override isVisible() {
		return this.webview?.visible || false
	}

	public getWebview(): vscode.WebviewView | undefined {
		return this.webview
	}

	/**
	 * Initializes and sets up the webview when it's first created.
	 *
	 * @param webviewView - The sidebar webview view instance to be resolved
	 * @returns A promise that resolves when the webview has been fully initialized
	 */
	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.webview = webviewView

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
		}

		webviewView.webview.html =
			this.context.extensionMode === vscode.ExtensionMode.Development
				? await this.getHMRHtmlContent()
				: this.getHtmlContent()

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received
		this.setWebviewMessageListener(webviewView.webview)

		// Logs show up in bottom panel > Debug Console
		//Logger.log("registering listener")

		// Listen for when the sidebar becomes visible
		// https://github.com/microsoft/vscode-discussions/discussions/840

		// onDidChangeVisibility is only available on the sidebar webview
		// Otherwise WebviewView and WebviewPanel have all the same properties except for this visibility listener
		// WebviewPanel is not currently used in the extension
		webviewView.onDidChangeVisibility(
			async () => {
				if (this.webview?.visible) {
					// View becoming visible should not steal editor focus.
					await sendShowWebviewEvent(true)
				}
			},
			null,
			this.disposables,
		)

		// Listen for when the view is disposed
		// This happens when the user closes the view or when the view is closed programmatically
		webviewView.onDidDispose(
			async () => {
				await this.dispose()
			},
			null,
			this.disposables,
		)

		// Listen for configuration changes
		vscode.workspace.onDidChangeConfiguration(
			async (e) => {
				if (e && e.affectsConfiguration("cline.mcpMarketplace.enabled")) {
					// Update state when marketplace tab setting changes
					await this.controller.postStateToWebview()
				}
			},
			null,
			this.disposables,
		)

		// if the extension is starting a new session, clear previous task state
		this.controller.clearTask()

		Logger.log("[VscodeWebviewProvider] Webview view resolved")

		// Title setting logic removed to allow VSCode to use the container title primarily.
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * IMPORTANT: When passing methods as callbacks in JavaScript/TypeScript, the method's
	 * 'this' context can be lost. This happens because the method is passed as a
	 * standalone function reference, detached from its original object.
	 *
	 * The Problem:
	 * Doing: webview.onDidReceiveMessage(this.controller.handleWebviewMessage)
	 * Would cause 'this' inside handleWebviewMessage to be undefined or wrong,
	 * leading to "TypeError: this.setUserInfo is not a function"
	 *
	 * The Solution:
	 * We wrap the method call in an arrow function, which:
	 * 1. Preserves the lexical scope's 'this' binding
	 * 2. Ensures handleWebviewMessage is called as a method on the controller instance
	 * 3. Maintains access to all controller methods and properties
	 *
	 * Alternative solutions could use .bind() or making handleWebviewMessage an arrow
	 * function property, but this approach is clean and explicit.
	 *
	 * @param webview The webview instance to attach the message listener to
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage(
			(message) => {
				this.handleWebviewMessage(message)
			},
			null,
			this.disposables,
		)
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	async handleWebviewMessage(message: WebviewMessage) {
		const postMessageToWebview = (response: ExtensionMessage) => this.postMessageToWebview(response)

		// 检查是否为实验任务相关消息（assignment_command 类型）
		const msgType = (message as unknown as Record<string, string>).type
		if (msgType === "assignment_command") {
			const assignmentMsg = message as unknown as AssignmentMessage
			await this.assignmentManager.handleMessage(assignmentMsg, (response) => {
				this.postMessageToWebview(response as unknown as ExtensionMessage)
			})
			return
		}

		// 【v1.3 增量】Wiki 资料管理 + 进度感知 RAG 消息分发
		if (msgType === "wiki_command") {
			await this.handleWikiCommand(message as unknown as WikiCommand, postMessageToWebview)
			return
		}

		switch (message.type) {
			case "grpc_request": {
				if (message.grpc_request) {
					await handleGrpcRequest(this.controller, postMessageToWebview, message.grpc_request)
				}
				break
			}
			case "grpc_request_cancel": {
				if (message.grpc_request_cancel) {
					await handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel)
				}
				break
			}
			default: {
				Logger.error("Received unhandled WebviewMessage type:", JSON.stringify(message))
			}
		}
	}

	/**
	 * Sends a message from the extension to the webview.
	 *
	 * @param message - The message to send to the webview
	 * @returns A thenable that resolves to a boolean indicating success, or undefined if the webview is not available
	 */
	private async postMessageToWebview(message: ExtensionMessage): Promise<boolean | undefined> {
		return this.webview?.webview.postMessage(message)
	}

	// ============================================================================
	//  Wiki 资料管理 + 进度感知 RAG 消息分发（v1.3 增量）
	// ============================================================================
	//
	// 接收来自 LLMSettingsView / AssignmentHeader 的 wiki_command 消息，
	// 调用 LLMWikiService 单例处理，统一回写到 Webview。
	//
	// ============================================================================

	private async handleWikiCommand(
		msg: WikiCommand,
		post: (response: ExtensionMessage) => Promise<boolean | undefined>,
	): Promise<void> {
		const llm = LLMWikiService.getInstance()
		const respond = (cmd: string, success: boolean, data?: unknown, error?: string) => {
			post({
				type: "wiki_response",
				command: cmd,
				success,
				data,
				error,
			} as unknown as ExtensionMessage)
		}

		try {
			switch (msg.command) {
				case "loadHeaderState": {
					// 返回当前生效的 serverUrl + currentWeek（用于 Header 初始化回填）
					respond("loadHeaderState", true, {
						week: llm.getCurrentWeek(),
						serverUrl: llm.getServerUrl(),
					})
					return
				}

				case "switchWeek": {
					// 周数切换：拉取 ≤ 当前周 的所有 wiki chunk
					const chunks = await llm.fetchWikiForWeek(msg.week)
					vscode.window.showInformationMessage(
						`已成功载入第 ${msg.week} 周及之前的教学资料（共 ${chunks.length} 条）！`,
					)
					respond("switchWeek", true, { week: msg.week, count: chunks.length })
					return
				}

				case "fetchWiki": {
					// "获取任务"按钮（与 switchWeek 等价，但不下拉提示）
					const chunks = await llm.fetchWikiForWeek(msg.week)
					respond("fetchWiki", true, {
						week: msg.week,
						count: chunks.length,
						message: `已载入第 ${msg.week} 周及之前的资料（${chunks.length} 条）`,
					})
					return
				}

				case "updateServerUrl": {
					// 学生动态修改服务器地址 → 写 VS Code 全局配置 + 失效缓存
					await vscode.workspace
						.getConfiguration("clineTeaching")
						.update("serverUrl", msg.url, vscode.ConfigurationTarget.Global)
					llm.invalidateCache()
					Logger.log(`[VscodeWebviewProvider] serverUrl 已更新为 ${msg.url}`)
					vscode.window.showInformationMessage(`服务器地址已更新为 ${msg.url}`)
					respond("updateServerUrl", true, { url: msg.url })
					return
				}

				case "saveLLMSettings": {
					// 转发到 LLMSettingsViewProvider 的 _handleMessage（已经处理过）；
					// 这里做兜底：如果消息没有先经过 LLMSettingsViewProvider，则直接写入 .env + 推送到后端
					await this._proxyLLMSettings(
						msg.provider,
						msg.baseUrl,
						msg.apiKey,
						msg.model,
						msg.enableTools,
						typeof msg.pasteLimit === "boolean" ? msg.pasteLimit : undefined,
					)
					respond("saveLLMSettings", true)
					return
				}

				case "testLLMConnection": {
					// 转发到后端测试接口
					const resp = await fetch(`${llm.getServerUrl()}/api/v1/internal/llm-test`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							baseUrl: msg.baseUrl,
							apiKey: msg.apiKey,
							model: msg.model,
						}),
					})
					const data = (await resp.json()) as { ok: boolean; message?: string }
					respond("testLLMConnection", data.ok, data, data.ok ? undefined : data.message)
					return
				}

				default: {
					respond(msg.command, false, undefined, "unknown wiki_command")
				}
			}
		} catch (e) {
			Logger.error("[VscodeWebviewProvider] handleWikiCommand 异常:", e)
			respond(msg.command, false, undefined, e instanceof Error ? e.message : String(e))
		}
	}

	/**
	 * 兜底：直接保存 LLM 配置（若 LLMSettingsViewProvider 未先处理）
	 * 实际主路径走 LLMSettingsViewProvider._handleMessage，此处仅作为 fallback
	 */
	private async _proxyLLMSettings(
		provider: string,
		baseUrl: string,
		apiKey: string,
		model: string,
		enableTools: boolean,
		pasteLimit?: boolean,
	): Promise<void> {
		// 【v2.8】教学限制模式：同步 VS Code 配置（键绑定生效开关）
		if (typeof pasteLimit === "boolean") {
			await vscode.workspace
				.getConfiguration("clineTeaching")
				.update("pasteLimitEnabled", pasteLimit, vscode.ConfigurationTarget.Global)
		}
		const url = `${LLMWikiService.getInstance().getServerUrl()}/api/v1/internal/llm-env`
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider, baseUrl, apiKey, model, enableTools, pasteLimit }),
		})
	}

	override async dispose() {
		// WebviewView doesn't have a dispose method, it's managed by VSCode
		// We just need to clean up our disposables
		while (this.disposables.length) {
			const x = this.disposables.pop()
			if (x) {
				x.dispose()
			}
		}
		// 释放 AssignmentManager 内部订阅（disposables 之外的资源）
		this.assignmentManager.dispose()
		super.dispose()
	}
}
