/**
 * =============================================================================
 *  AssignmentDetailPanelProvider — 实验任务详情面板宿主（P1-2）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 点侧栏里的实验任务 → 在编辑器区（工作台正中）打开详情面板，展示
 * 标题 / 周次 / 描述 / 实验指导书正文 / 附件下载 / 模板预览，并提供「开始实验」。
 *
 * 为什么换成面板（而不是继续在侧栏内嵌详情）：
 *   - 侧栏宽度有限，指导书正文与附件的 Markdown 表格会被挤成竖条；
 *   - 详情需要长期可见（学生边看指导书边写代码），编辑器区标签页更合适；
 *   - 与「问题反馈」「思考题」两个面板保持同一形态，学生不用学两套交互。
 *
 * 【消息路由】（webview → 扩展）
 *   - ready               → 回推 `loadDetail`（载荷）
 *   - openAttachment      → 下载并在编辑器中打开附件（复用 AssignmentManager）
 *   - startExperiment     → 建/复用实验目录并打开模板（P1-3）
 *   - closeAssignmentDetail → 关闭面板
 *
 * 载荷与业务分支都在 `core/teaching/assignmentDetail.ts`（纯函数、可单测），
 * 这里只负责面板生命周期与把消息转给回调。
 * =============================================================================
 */

import * as vscode from "vscode"
import type { AssignmentDetailPayload } from "@/core/teaching/assignmentDetail"
import { Logger } from "@/shared/services/Logger"

export interface AssignmentDetailHandlers {
	/** 下载附件（并且通常会在编辑器里打开） */
	openAttachment: (attachmentId: number) => Promise<{ ok: boolean; message?: string }>
	/** 开始/继续实验：建目录、写模板与 GUIDE.md、打开模板 */
	startExperiment: () => Promise<{ ok: boolean; message?: string; experimentDir?: string }>
	/** 「提交实验」：复用侧栏同款两段式提交 */
	submitExperiment: () => Promise<{ ok: boolean; message?: string }>
	/** 「结束实验」：直接结束会话（实验目录/日志保留） */
	endExperiment: () => Promise<{ ok: boolean; message?: string }>
}

export class AssignmentDetailPanelProvider {
	public static readonly viewId = "clineAssignmentDetailPanel"

	private static _instance: AssignmentDetailPanelProvider | null = null

	private _panel: vscode.WebviewPanel | null = null
	private _payload: AssignmentDetailPayload | null = null
	private _handlers: AssignmentDetailHandlers | null = null

	private constructor(private readonly _extensionUri: vscode.Uri) {}

	public static getInstance(extensionUri?: vscode.Uri): AssignmentDetailPanelProvider {
		if (!AssignmentDetailPanelProvider._instance) {
			if (!extensionUri) {
				throw new Error("AssignmentDetailPanelProvider 首次创建必须传入 extensionUri")
			}
			AssignmentDetailPanelProvider._instance = new AssignmentDetailPanelProvider(extensionUri)
		}
		return AssignmentDetailPanelProvider._instance
	}

	// ============================================================================
	//  面板生命周期
	// ============================================================================

	/**
	 * 打开或聚焦详情面板。
	 *
	 * 已存在面板时**只替换载荷并重新推送**（学生连续点两个任务不会开两个标签页），
	 * 这也是「单例」的意义：面板标题会随任务变化。
	 */
	public reveal(payload: AssignmentDetailPayload, handlers: AssignmentDetailHandlers): void {
		this._payload = payload
		this._handlers = handlers

		if (this._panel) {
			this._panel.title = `📘 ${payload.title}`
			this._panel.reveal()
			this._push()
			return
		}

		const panel = vscode.window.createWebviewPanel(
			AssignmentDetailPanelProvider.viewId,
			`📘 ${payload.title}`,
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [this._extensionUri],
				retainContextWhenHidden: true,
			},
		)
		this._panel = panel

		panel.webview.html = this._getHtmlForWebview(panel.webview)
		panel.webview.onDidReceiveMessage((msg: Record<string, unknown>) => this._handleMessage(msg))
		panel.onDidDispose(() => {
			this._panel = null
			this._payload = null
			this._handlers = null
		})
	}

	/** 载荷变化时刷新（例如「开始实验」之后按钮要变「继续实验」） */
	public update(payload: AssignmentDetailPayload): void {
		this._payload = payload
		if (this._panel) {
			this._panel.title = `📘 ${payload.title}`
			this._push()
		}
	}

	public dispose(): void {
		this._panel?.dispose()
		this._panel = null
		this._payload = null
		this._handlers = null
	}

	private _push(): void {
		if (!this._panel || !this._payload) {
			return
		}
		void this._panel.webview.postMessage({ command: "loadDetail", success: true, data: this._payload })
	}

	// ============================================================================
	//  消息分发
	// ============================================================================

	private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
		const cmd = msg["command"] as string | undefined
		const post = (response: Record<string, unknown>) => {
			void this._panel?.webview.postMessage(response)
		}

		try {
			switch (cmd) {
				case "ready":
				case "assignmentDetailReady": {
					this._push()
					break
				}
				case "openAttachment": {
					const id = Number(msg["attachmentId"])
					if (!Number.isFinite(id)) {
						post({ command: "openAttachment", success: false, error: "缺少附件 id" })
						break
					}
					const result = await this._handlers?.openAttachment(id)
					post({
						command: "openAttachment",
						success: result?.ok === true,
						error: result?.ok === true ? undefined : (result?.message ?? "下载附件失败"),
						data: result?.ok === true ? { message: result.message } : undefined,
					})
					break
				}
				case "startExperiment": {
					const result = await this._handlers?.startExperiment()
					post({
						command: "startExperiment",
						success: result?.ok === true,
						error: result?.ok === true ? undefined : (result?.message ?? "开始实验失败"),
						data: result?.ok === true ? { message: result.message, experimentDir: result.experimentDir } : undefined,
					})
					if (result?.ok === true && this._payload) {
						this.update({
							...this._payload,
							started: true,
							sessionActive: true,
							experimentDir: result.experimentDir ?? this._payload.experimentDir,
						})
					}
					break
				}
				case "submitExperiment": {
					const result = await this._handlers?.submitExperiment()
					post({
						command: "submitExperiment",
						success: result?.ok === true,
						error: result?.ok === true ? undefined : (result?.message ?? "打开提交面板失败"),
						data: result?.ok === true ? { message: result.message } : undefined,
					})
					break
				}
				case "endExperiment": {
					const result = await this._handlers?.endExperiment()
					post({
						command: "endExperiment",
						success: result?.ok === true,
						error: result?.ok === true ? undefined : (result?.message ?? "结束实验失败"),
						data: result?.ok === true ? { message: result.message } : undefined,
					})
					if (result?.ok === true && this._payload) {
						this.update({ ...this._payload, sessionActive: false })
					}
					break
				}
				case "closeAssignmentDetail": {
					this._panel?.dispose()
					break
				}
				default: {
					post({ command: cmd ?? "unknown", success: false, error: "unknown command" })
				}
			}
		} catch (e) {
			Logger.error("[AssignmentDetailPanelProvider] handleMessage 异常:", e)
			post({ command: cmd ?? "unknown", success: false, error: e instanceof Error ? e.message : String(e) })
		}
	}

	// ============================================================================
	//  HTML 渲染（与 FeedbackPanelProvider 一致，data-view 换为详情面板）
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
  <title>实验任务详情</title>
</head>
<body>
  <div id="root" data-view="clineAssignmentDetailPanel"></div>
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
