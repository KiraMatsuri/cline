/**
 * WikiWeekSelector — 主工具栏周数选择器（v1.3 增量）
 * 直接渲染在 Cline 主 Navbar 上，无需进入"实验任务"子视图
 *
 * 【职责】
 * - 显示当前周数 1~18
 * - 切换时通过 IPC 通知 extension.ts → fetchWikiForWeek(week)
 *
 * 【v1.3 决策】直接暴露在主工具栏，避免学生需要先点击"实验任务"
 */

import { CalendarIcon } from "lucide-react"
import { useEffect, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getVsCodeApiInstance } from "@/config/platform.config"

export function WikiWeekSelector() {
	const [currentWeek, setCurrentWeek] = useState<number>(1)
	const [loading, setLoading] = useState(false)

	// 初始加载 + 监听响应
	useEffect(() => {
		const api = getVsCodeApiInstance()
		if (api) {
			api.postMessage({ type: "wiki_command", command: "loadHeaderState" })
		}

		const handler = (event: MessageEvent) => {
			const msg = event.data as { command?: string; success?: boolean; data?: unknown }
			if (msg?.command === "loadHeaderState" && msg.success && msg.data) {
				const state = msg.data as { week?: number }
				if (typeof state.week === "number") setCurrentWeek(state.week)
			}
			if (msg?.command === "switchWeek" && msg.success) {
				setLoading(false)
			}
			if (msg?.command === "fetchWiki" && msg.success) {
				setLoading(false)
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
		const week = Number(e.target.value)
		setCurrentWeek(week)
		const api = getVsCodeApiInstance()
		if (!api) return
		setLoading(true)
		api.postMessage({
			type: "wiki_command",
			command: "switchWeek",
			week,
		})
	}

	return (
		<Tooltip>
			<TooltipContent side="bottom">学习进度（Wiki 资料周数）</TooltipContent>
			<TooltipTrigger asChild>
				<div
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
						padding: "0 6px",
						height: 28,
						border: "1px solid var(--vscode-panel-border)",
						borderRadius: 4,
						// 浅色背景以承载深色字体（与 VS Code 主题解耦）
						background: "#ffffff",
					}}>
					<CalendarIcon color="#1f1f1f" size={14} />
					<select
						aria-label="学习进度周数"
						disabled={loading}
						onChange={onChange}
						style={{
							background: "transparent",
							border: "none",
							// 强制深色字体，避免浅色主题下看不清
							color: "#1f1f1f",
							fontSize: 12,
							fontWeight: 600,
							outline: "none",
							cursor: "pointer",
						}}
						value={currentWeek}>
						{Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
							<option
								key={w}
								style={{
									background: "#ffffff",
									color: "#1f1f1f",
								}}
								value={w}>
								第 {w} 周
							</option>
						))}
					</select>
				</div>
			</TooltipTrigger>
		</Tooltip>
	)
}
