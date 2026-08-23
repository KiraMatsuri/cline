/**
 * WikiWeekSelector — 主工具栏周数选择器（v1.3 增量 / v2.9 交互重做）
 * 直接渲染在 Cline 主 Navbar 上，无需进入"实验任务"子视图
 *
 * 【职责】
 * - 显示当前周数 1~18
 * - 变更时通过 IPC 通知 extension.ts → fetchWikiForWeek(week)
 *
 * 【v2.9 交互重做】
 * - UI：去除白色背景/边框/硬编码深色 → 透明背景 + 主题前景色（与 tab 栏图标一致）
 * - 交互：右侧 ▲▼ 步进（18+1→1、1-1→18 循环）；悬停滚轮步进（同箭头）；双击输入周数
 * - 非法输入（非 1-18 整数）保持原周数 + 内联红字提示 2s 自动消失
 * - IPC 防抖 500ms：连续调节只在停止操作后派发最终值，本地反馈零延迟
 *
 * 【实现要点】
 * - 滚轮：React onWheel 为 passive 监听无法 preventDefault（页面会跟着滚），
 *   故用 ref 挂原生 wheel 监听（passive:false），卸载时移除
 * - 原生监听存在闭包过期问题：周数/编辑态的最新值走 ref
 */

import { CalendarIcon, ChevronDown, ChevronUp } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { getVsCodeApiInstance } from "@/config/platform.config"

/** 周数范围 */
const MIN_WEEK = 1
const MAX_WEEK = 18
/** IPC 派发防抖（ms）：箭头/滚轮连续操作只发最终值 */
const DEBOUNCE_MS = 500

export function WikiWeekSelector() {
	const [currentWeek, setCurrentWeek] = useState<number>(1)
	const [loading, setLoading] = useState(false)
	// 双击编辑态（input）
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState("")
	// 非法输入内联提示（自动消失）
	const [error, setError] = useState("")

	// 原生 wheel 监听的闭包安全：周数/编辑态的最新值走 ref
	const weekRef = useRef(1)
	const editingRef = useRef(false)
	const rootRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)
	const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
	const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

	/** 更新本地周数（state + ref 同步） */
	const setWeek = (week: number) => {
		weekRef.current = week
		setCurrentWeek(week)
	}

	/** 进入编辑态（双击触发） */
	const startEditing = () => {
		setDraft(String(weekRef.current))
		editingRef.current = true
		setEditing(true)
	}

	/** 退出编辑态 */
	const exitEditing = () => {
		editingRef.current = false
		setEditing(false)
	}

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
				if (typeof state.week === "number") {
					weekRef.current = state.week
					setCurrentWeek(state.week)
				}
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

	// 卸载清理（防抖/提示定时器不残留）
	useEffect(() => {
		return () => {
			if (debounceTimer.current) clearTimeout(debounceTimer.current)
			if (errorTimer.current) clearTimeout(errorTimer.current)
		}
	}, [])

	// ----- IPC 派发（防抖 500ms，只发最终值）-----
	const dispatchSwitchWeek = (week: number) => {
		setLoading(true)
		if (debounceTimer.current) clearTimeout(debounceTimer.current)
		debounceTimer.current = setTimeout(() => {
			const api = getVsCodeApiInstance()
			if (!api) {
				setLoading(false)
				return
			}
			api.postMessage({
				type: "wiki_command",
				command: "switchWeek",
				week,
			})
		}, DEBOUNCE_MS)
	}

	// ----- 步进（循环：18+1→1、1-1→18）-----
	const step = (delta: 1 | -1) => {
		const next = weekRef.current + delta
		const wrapped = next > MAX_WEEK ? MIN_WEEK : next < MIN_WEEK ? MAX_WEEK : next
		setWeek(wrapped)
		dispatchSwitchWeek(wrapped)
	}

	// ----- 悬停滚轮步进（原生监听：passive:false 才能 preventDefault 页面滚动）-----
	useEffect(() => {
		const el = rootRef.current
		if (!el) return
		const onWheel = (e: WheelEvent) => {
			e.preventDefault()
			// 编辑态忽略滚轮（避免与输入框数字打架）
			if (editingRef.current) return
			// 向下滚 = ▼（+1），向上滚 = ▲（-1）
			step(e.deltaY > 0 ? 1 : -1)
		}
		el.addEventListener("wheel", onWheel, { passive: false })
		return () => el.removeEventListener("wheel", onWheel)
		// step 仅依赖 ref，无过期闭包问题
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// ----- 编辑态自动聚焦 + 全选 -----
	useEffect(() => {
		if (editing) {
			inputRef.current?.focus()
			inputRef.current?.select()
		}
	}, [editing])

	/** 展示非法输入提示（2s 自动消失，重复触发时重置计时） */
	const showError = (text: string) => {
		setError(text)
		if (errorTimer.current) clearTimeout(errorTimer.current)
		errorTimer.current = setTimeout(() => setError(""), 2000)
	}

	/** 提交编辑（Enter / blur）：合法则切换周数，非法则保持 + 提示 */
	const commitEdit = () => {
		if (!editingRef.current) return // 已退出（Esc 或重复触发）
		const trimmed = draft.trim()
		const num = Number(trimmed)
		if (!/^\d+$/.test(trimmed) || num < MIN_WEEK || num > MAX_WEEK) {
			showError(`周数需在 ${MIN_WEEK}-${MAX_WEEK} 之间`)
		} else if (num !== weekRef.current) {
			setWeek(num)
			dispatchSwitchWeek(num)
		}
		exitEditing()
	}

	const onInputKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			e.preventDefault()
			commitEdit()
		} else if (e.key === "Escape") {
			e.preventDefault()
			exitEditing() // 还原，不派发
		}
	}

	return (
		<Tooltip>
			<TooltipContent side="bottom">学习进度（Wiki 资料周数）</TooltipContent>
			<TooltipTrigger asChild>
				<div
					// v2.9：滚轮步进挂在此根元素；双击进入编辑
					onDoubleClick={startEditing}
					ref={rootRef}
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 3,
						padding: "0 6px",
						height: 28,
						// v2.9.1：透明背景保持，加入主题前景色细边框（与图标同色系），
						// 让筛选器在 tab 栏中有可辨识的边界但不像原白底那样突兀
						background: "transparent",
						border: "1px solid var(--vscode-foreground)",
						opacity: 0.75, // 边框整体降透明度，视觉更柔和（含内部元素）
						borderRadius: 4,
						position: "relative",
						userSelect: "none",
					}}>
					<CalendarIcon size={14} />
					{editing ? (
						<input
							aria-label="输入学习周数"
							inputMode="numeric"
							onBlur={commitEdit}
							onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, "").slice(0, 2))}
							onKeyDown={onInputKeyDown}
							ref={inputRef}
							style={{
								width: "3.5ch",
								background: "var(--vscode-input-background)",
								color: "var(--vscode-input-foreground)",
								border: "1px solid var(--vscode-input-border)",
								borderRadius: 3,
								fontSize: 12,
								fontWeight: 600,
								outline: "none",
								textAlign: "center",
								padding: "1px 2px",
							}}
							type="text"
							value={draft}
						/>
					) : (
						<span
							style={{
								color: "var(--vscode-foreground)",
								fontSize: 12,
								fontWeight: 600,
								lineHeight: "18px",
								whiteSpace: "nowrap",
								// v2.9.1：loading 反馈移到文字（容器 opacity 已用于边框柔化）
								opacity: loading ? 0.55 : 1,
							}}>
							第 {currentWeek} 周
						</span>
					)}
					{/* 右侧上下箭头（步进） */}
					<span
						style={{
							display: "inline-flex",
							flexDirection: "column",
							justifyContent: "center",
							lineHeight: 1,
							gap: 0,
						}}>
						<button
							aria-label="上一周"
							className="hover:opacity-80"
							onClick={() => step(-1)}
							onDoubleClick={(e) => e.stopPropagation()} /* 防止连点箭头误入编辑态 */
							style={arrowBtnStyle}
							type="button">
							<ChevronUp size={11} />
						</button>
						<button
							aria-label="下一周"
							className="hover:opacity-80"
							onClick={() => step(1)}
							onDoubleClick={(e) => e.stopPropagation()}
							style={arrowBtnStyle}
							type="button">
							<ChevronDown size={11} />
						</button>
					</span>
					{/* 非法输入提示（容器下方内联红字，2s 自动消失） */}
					{error && (
						<span
							style={{
								position: "absolute",
								top: "100%",
								left: "50%",
								transform: "translateX(-50%)",
								marginTop: 4,
								whiteSpace: "nowrap",
								fontSize: 11,
								padding: "2px 8px",
								borderRadius: 3,
								background: "var(--vscode-editorWidget-background)",
								border: "1px solid var(--vscode-input-border)",
								color: "var(--vscode-errorForeground)",
								zIndex: 10,
								pointerEvents: "none",
							}}>
							{error}
						</span>
					)}
				</div>
			</TooltipTrigger>
		</Tooltip>
	)
}

/** 箭头小按钮样式：透明背景、继承主题前景色，hover 透明度变化由 className 提供 */
const arrowBtnStyle: React.CSSProperties = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	background: "transparent",
	border: "none",
	padding: 0,
	height: 13,
	width: 14,
	cursor: "pointer",
	color: "inherit",
}
