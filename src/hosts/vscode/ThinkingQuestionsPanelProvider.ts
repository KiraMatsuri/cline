/**
 * =============================================================================
 *  ThinkingQuestionsPanelProvider — 提交前思考题答题面板（编辑器区）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【位置选择】用 `createWebviewPanel` 在编辑器区打开，而不是复用侧栏。
 * 侧栏此刻还停留在任务列表上，学生需要同时看到题面与代码；编辑器区面板
 * 还能被拖动分屏，答题时对照代码更方便。范式与 FeedbackPanelProvider 一致。
 *
 * 【关键流程】面板只负责「展示题目 / 收集答案 / 显示结果」，真正的上传由
 * AssignmentManager 在 `onConfirm` 回调里完成 —— 面板不碰网络，也就不会
 * 出现「面板发了一次、Webview 又发一次」的重复上传。
 *
 * 设计文档：docs/design/teaching-submission-bundle-design.md §7
 * =============================================================================
 */

import * as vscode from "vscode"
import type { BundleAnswer, ThinkingConfirmResult, ThinkingQuestionsPayload } from "@/core/teaching/submission/bundleTypes"
import { Logger } from "@/shared/services/Logger"

type ConfirmHandler = (answers: BundleAnswer[]) => Promise<ThinkingConfirmResult>

export class ThinkingQuestionsPanelProvider {
	static readonly viewId = "clineThinkingQuestionsPanel"

	private static _instance: ThinkingQuestionsPanelProvider | null = null

	private _panel: vscode.WebviewPanel | null = null
	private _payload: ThinkingQuestionsPayload | null = null
	private _onConfirm: ConfirmHandler | null = null

	private constructor(private readonly _extensionUri: vscode.Uri) {}

	/** 单例：首次创建必须传 extensionUri（与 FeedbackPanelProvider 约定一致） */
	static getInstance(extensionUri?: vscode.Uri): ThinkingQuestionsPanelProvider {
		if (!ThinkingQuestionsPanelProvider._instance) {
			if (!extensionUri) {
				throw new Error("ThinkingQuestionsPanelProvider 首次创建必须传入 extensionUri")
			}
			ThinkingQuestionsPanelProvider._instance = new ThinkingQuestionsPanelProvider(extensionUri)
		}
		return ThinkingQuestionsPanelProvider._instance
	}

	/** 用新载荷打开（或刷新）面板 */
	reveal(payload: ThinkingQuestionsPayload, onConfirm: ConfirmHandler): void {
		this._payload = payload
		this._onConfirm = onConfirm

		if (this._panel) {
			this._panel.reveal(vscode.ViewColumn.Active, false)
			void this._panel.webview.postMessage({ type: "thinkingQuestions", command: "loadQuestions", data: payload })
			return
		}

		const panel = vscode.window.createWebviewPanel(
			ThinkingQuestionsPanelProvider.viewId,
			"💭 提交前思考题",
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				localResourceRoots: [this._extensionUri],
				retainContextWhenHidden: true,
			},
		)
		this._panel = panel
		panel.webview.html = this._getHtmlForWebview(panel.webview)
		panel.webview.onDidReceiveMessage((message) => {
			void this._handleMessage(message)
		})
		panel.onDidDispose(() => {
			this._panel = null
			this._payload = null
			this._onConfirm = null
		})
	}

	/** 被动关闭（例如学生取消了待提交内容） */
	dispose(): void {
		this._panel?.dispose()
	}

	private async _handleMessage(message: unknown): Promise<void> {
		const msg = (message ?? {}) as Record<string, unknown>
		const cmd = typeof msg.command === "string" ? msg.command : msg.type === "ready" ? "ready" : undefined
		const post = (payload: Record<string, unknown>) => {
			void this._panel?.webview.postMessage(payload)
		}

		try {
			switch (cmd) {
				case "ready": {
					if (!this._payload) {
						post({ command: "loadQuestions", success: false, error: "没有待提交的内容，请回到任务列表重新点击提交" })
						return
					}
					post({ type: "thinkingQuestions", command: "loadQuestions", success: true, data: this._payload })
					break
				}

				case "confirmAnswers": {
					const rawAnswers = Array.isArray(msg.answers) ? (msg.answers as Record<string, unknown>[]) : []
					if (!this._payload || !this._onConfirm) {
						post({ command: "confirmAnswers", success: false, error: "提交上下文已失效，请重新点击提交" })
						return
					}
					const normalized = this._normalizeAnswers(rawAnswers)
					if (typeof normalized === "string") {
						post({ command: "confirmAnswers", success: false, error: normalized })
						return
					}
					// 面板先进入「上传中」状态，避免学生连点导致重复提交
					post({ command: "confirmAnswers", success: false, error: "", uploading: true })
					const result = await this._onConfirm(normalized)
					if (result.success) {
						Logger.log("[ThinkingQuestionsPanelProvider] 思考题答案已随提交包上传")
						post({ command: "confirmAnswers", success: true, data: result.data })
					} else {
						post({ command: "confirmAnswers", success: false, error: result.error ?? "上传失败" })
					}
					break
				}

				case "cancelThinkingQuestions": {
					this._panel?.dispose()
					break
				}

				default:
					post({ command: cmd ?? "unknown", success: false, error: "unknown command" })
			}
		} catch (e) {
			const msgText = e instanceof Error ? e.message : String(e)
			Logger.error("[ThinkingQuestionsPanelProvider] handleMessage 异常:", e)
			post({ command: cmd ?? "unknown", success: false, error: msgText })
		}
	}

	/**
	 * 校验答案：必须每题都有非空答案（文档 §7.2「全部非空才可提交」）。
	 * 返回数组=合法，返回字符串=错误提示。
	 */
	private _normalizeAnswers(rawAnswers: Record<string, unknown>[]): BundleAnswer[] | string {
		const questions = this._payload?.questions ?? []
		if (questions.length === 0) return "题目为空，请重新点击提交"

		const answerBySeq = new Map<number, string>()
		for (const item of rawAnswers) {
			const seq = Number(item.seq)
			const answer = typeof item.answer === "string" ? item.answer.trim() : ""
			if (!Number.isInteger(seq) || seq <= 0) continue
			if (!answer) continue
			if (answer.length > 2000) return `第 ${seq} 题的答案过长（上限 2000 字），请精简后再提交`
			answerBySeq.set(seq, answer)
		}

		const missing: number[] = []
		const result: BundleAnswer[] = []
		for (const question of questions) {
			const answer = answerBySeq.get(question.seq)
			if (!answer) {
				missing.push(question.seq)
				continue
			}
			result.push({ seq: question.seq, answer })
		}
		if (missing.length > 0) return `第 ${missing.join("、")} 题还没作答，请补全后提交`
		return result
	}

	// ============================================================================
	//  HTML 渲染（与 FeedbackPanelProvider 对齐，data-view 换成思考题面板）
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
  <title>提交前思考题</title>
</head>
<body>
  <div id="root" data-view="clineThinkingQuestionsPanel"></div>
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
