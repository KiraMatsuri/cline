/**
 * =============================================================================
 *  PasteLimitManager — 教学限制模式：编辑器粘贴限行（v2.8）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【动机】
 * 防止学生整段拷贝代码/答案完成实验：启用后 VS Code 编辑器内单次粘贴
 * 最多允许 5 行内容，超出则拦截并提示。
 *
 * 【实现】
 * 通过 keybinding 覆盖编辑器内 Ctrl+V / Cmd+V：
 *   package.json contributes.keybindings:
 *     command: cline.teachingPasteWithLimit
 *     when:    config.clineTeaching.pasteLimitEnabled && editorTextFocus && !editorReadonly
 * when 子句为 false（未启用/非编辑器场景）时按键自动回落 VS Code 默认粘贴，
 * 对正常使用零影响。
 *
 * 命令逻辑：读剪贴板 → 行数 ≤5 转发原生粘贴；>5 警告并中止。
 *
 * 【设计说明】
 * - 曾计划叠加 DocumentPasteEditProvider 兜底（覆盖右键粘贴），但该 API
 *   不在当前 @types/vscode@1.84 中（更高版本才稳定），按设计文档预案降级为
 *   仅保留 keybinding 主防线 —— 已覆盖键盘粘贴这一绝对主流输入路径。
 * - 已知局限（软限制定位）：拖放文本插入、外部编辑器、终端内粘贴不受限。
 * - 剪贴板读取仅发生在用户主动按下粘贴键时，无后台监听。
 *
 * 【行计数规则】
 * 按 \r\n | \r | \n 分段；末尾换行产生的空行不计（"abc\n" 算 1 行）。
 * =============================================================================
 */

import * as vscode from "vscode"

export class PasteLimitManager {
	/** 单次粘贴允许的最大行数（决策 D3：固定 5 行） */
	public static readonly MAX_LINES = 5

	/** 配置节与键名（与 package.json contributes.configuration 对齐） */
	public static readonly CONFIG_KEY = "clineTeaching.pasteLimitEnabled"

	/** 命令 ID（与 package.json contributes.commands/keybindings 对齐） */
	public static readonly COMMAND_ID = "cline.teachingPasteWithLimit"

	/**
	 * 统计文本行数（末尾换行不计）。
	 * 空字符串算 0 行；"a\nb\n" 算 2 行。
	 */
	public static countLines(text: string): number {
		if (!text) return 0
		// 统一按 \n 切分（先把 \r\n 与孤立 \r 归一化）
		const normalized = text.replace(/\r\n?/g, "\n")
		const lines = normalized.split("\n")
		// 末尾空行（由结尾换行产生）不计
		if (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop()
		}
		return lines.length
	}

	/**
	 * 读取配置开关当前状态。
	 */
	public static isEnabled(): boolean {
		return vscode.workspace.getConfiguration("clineTeaching").get<boolean>("pasteLimitEnabled") === true
	}

	/**
	 * 注册粘贴拦截命令。在 activate() 中调用一次。
	 *
	 * 注意：命令本身不再检查配置开关 —— keybinding 的 when 子句已保证
	 * 只有「启用 + 编辑器聚焦 + 非只读」时才会路由到此命令；用户从命令
	 * 面板手动执行时则视为显式意图，同样按限行逻辑处理。
	 */
	public static register(context: vscode.ExtensionContext): void {
		const disposable = vscode.commands.registerTextEditorCommand(
			PasteLimitManager.COMMAND_ID,
			async (_editor, _edit) => {
				try {
					const clip = await vscode.env.clipboard.readText()
					const lineCount = PasteLimitManager.countLines(clip)

					if (lineCount <= PasteLimitManager.MAX_LINES) {
						// 放行：转发给 VS Code 原生粘贴（保持剪贴板格式行为一致）
						await vscode.commands.executeCommand("editor.action.clipboardPasteAction")
						return
					}

					// 拦截（决策 D1：拒绝并提示，不做截断插入）
					await vscode.window.showWarningMessage(
						`教学限制模式：单次粘贴最多 ${PasteLimitManager.MAX_LINES} 行（本次 ${lineCount} 行，已拦截）。`,
					)
				} catch (err) {
					// 任何异常都不阻塞用户：回落原生粘贴
					const msg = err instanceof Error ? err.message : String(err)
					vscode.window.showErrorMessage(`粘贴检查失败，已按默认方式粘贴: ${msg}`)
					await vscode.commands.executeCommand("editor.action.clipboardPasteAction")
				}
			},
		)
		context.subscriptions.push(disposable)
	}
}
