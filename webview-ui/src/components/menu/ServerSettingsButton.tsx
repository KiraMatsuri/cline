/**
 * ServerSettingsButton — 主工具栏服务器设置按钮（v1.3 增量）
 * 点击弹出 Modal 动态修改 serverUrl
 *
 * 【职责】
 * - 显示当前 serverUrl
 * - 弹出 Modal 提供输入框 + 保存/取消
 * - 保存后 IPC 通知 extension.ts → updateServerUrl
 *
 * 【v1.3 决策】直接暴露在主工具栏，与 LLM 设置（独立 WebviewView）解耦
 */

import { ServerIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getVsCodeApiInstance } from "@/config/platform.config"

export function ServerSettingsButton() {
	const [serverUrl, setServerUrl] = useState<string>("http://localhost:4001")
	const [draftUrl, setDraftUrl] = useState<string>("")
	const [modalVisible, setModalVisible] = useState(false)
	const [saving, setSaving] = useState(false)

	// 加载初始 serverUrl
	useEffect(() => {
		const api = getVsCodeApiInstance()
		if (api) {
			api.postMessage({ type: "wiki_command", command: "loadHeaderState" })
		}

		const handler = (event: MessageEvent) => {
			const msg = event.data as { command?: string; success?: boolean; data?: unknown }
			if (msg?.command === "loadHeaderState" && msg.success && msg.data) {
				const state = msg.data as { serverUrl?: string }
				if (state.serverUrl) setServerUrl(state.serverUrl)
			}
			if (msg?.command === "updateServerUrl") {
				setSaving(false)
				if (msg.success) {
					setServerUrl((msg.data as { url?: string })?.url ?? serverUrl)
					setModalVisible(false)
				}
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [serverUrl])

	const open = () => {
		setDraftUrl(serverUrl)
		setModalVisible(true)
	}

	const onSave = () => {
		if (!draftUrl.trim()) return
		setSaving(true)
		const api = getVsCodeApiInstance()
		if (!api) return
		api.postMessage({
			type: "wiki_command",
			command: "updateServerUrl",
			url: draftUrl.trim(),
		})
	}

	return (
		<>
			<Tooltip>
				<TooltipContent side="bottom">服务器设置（{serverUrl}）</TooltipContent>
				<TooltipTrigger asChild>
					<Button
						aria-label="服务器设置"
						className="p-0 h-7"
						data-testid="tab-server-settings"
						onClick={open}
						size="icon"
						variant="icon">
						<ServerIcon className="stroke-1 [svg]:size-4" size={18} />
					</Button>
				</TooltipTrigger>
			</Tooltip>

			{modalVisible && (
				<div onClick={() => !saving && setModalVisible(false)} style={modalOverlay}>
					<div onClick={(e) => e.stopPropagation()} style={modalBox}>
						<h3 style={{ marginTop: 0, marginBottom: 12 }}>⚙ 服务器设置</h3>
						<p style={hintStyle}>
							修改后端 API 地址（教学 Wiki 与实验任务共用此地址）。
							<br />
							修改后会立即刷新 Wiki 缓存。
						</p>
						<label style={labelStyle}>Server URL</label>
						<input
							autoFocus
							disabled={saving}
							onChange={(e) => setDraftUrl(e.target.value)}
							placeholder="http://localhost:4001"
							style={inputStyle}
							type="text"
							value={draftUrl}
						/>
						<p style={hintStyle}>格式：http(s)://host:port（与 VS Code 配置 clineTeaching.serverUrl 同源）</p>
						<div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
							<button
								disabled={saving}
								onClick={() => setModalVisible(false)}
								style={{ ...btnStyle, ...secondaryBtnStyle }}>
								取消
							</button>
							<button disabled={saving} onClick={onSave} style={{ ...btnStyle, ...primaryBtnStyle }}>
								{saving ? "保存中..." : "保存"}
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	)
}

// ============================================================================
//  样式
// ============================================================================

const modalOverlay: React.CSSProperties = {
	position: "fixed",
	inset: 0,
	background: "rgba(0,0,0,0.4)",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	zIndex: 9999,
}

const modalBox: React.CSSProperties = {
	background: "var(--vscode-editor-background)",
	border: "1px solid var(--vscode-panel-border)",
	padding: 20,
	borderRadius: 6,
	minWidth: 360,
	maxWidth: 480,
	fontSize: 13,
}

const labelStyle: React.CSSProperties = {
	display: "block",
	marginBottom: 4,
	fontWeight: 600,
	fontSize: 12,
}

const inputStyle: React.CSSProperties = {
	width: "100%",
	padding: "6px 10px",
	background: "var(--vscode-input-background)",
	color: "var(--vscode-input-foreground)",
	border: "1px solid var(--vscode-input-border)",
	borderRadius: 4,
	fontSize: 13,
	boxSizing: "border-box",
}

const hintStyle: React.CSSProperties = {
	margin: "4px 0 12px 0",
	fontSize: 11,
	color: "var(--vscode-descriptionForeground)",
	lineHeight: 1.6,
}

const btnStyle: React.CSSProperties = {
	padding: "6px 14px",
	border: "none",
	borderRadius: 4,
	fontSize: 12,
	fontWeight: 600,
	cursor: "pointer",
}

const primaryBtnStyle: React.CSSProperties = {
	background: "var(--vscode-button-background)",
	color: "var(--vscode-button-foreground)",
}

const secondaryBtnStyle: React.CSSProperties = {
	background: "var(--vscode-button-secondaryBackground)",
	color: "var(--vscode-button-secondaryForeground)",
}
