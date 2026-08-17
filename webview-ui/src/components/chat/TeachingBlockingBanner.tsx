import { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"

/**
 * =============================================================================
 *  TeachingBlockingBanner — 阻隔式干预实时倒计时横幅（教学辅助）
 * =============================================================================
 *
 * 【功能】
 * 当行为监测触发"阻隔式干预"（默认 180s 冷却）后，Cline 顶部 tab 栏下方
 * 会实时显示剩余冷却时间倒计时，让学生直观看到自己当前被"锁定"的状态，
 * 无需再通过发送消息后回复框里的提示来感知剩余时间。
 *
 * 【数据流】
 *   Extension (TeachingInterventionManager → controller.getStateToPostToWebview)
 *     → ExtensionState.teachingBlocking = { active: true, endsAt }
 *     → 本组件读取 teachingBlocking，本地 setInterval 每秒刷新剩余秒数
 *
 * 【说明】
 *   endsAt 为冷却结束时间戳(ms)，组件在本地做倒计时，不依赖扩展端每秒推送。
 *   倒计时归零后自动隐藏；下一次阻断触发时扩展端会推送新的 endsAt。
 */

const BLOCKING_STYLE: React.CSSProperties = {
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
	gap: "8px",
	padding: "6px 12px",
	width: "100%",
	boxSizing: "border-box",
	backgroundColor: "color-mix(in srgb, var(--vscode-inputValidation-errorBackground) 25%, transparent)",
	color: "var(--vscode-inputValidation-errorForeground)",
	borderBottom: "1px solid color-mix(in srgb, var(--vscode-inputValidation-errorBorder) 60%, transparent)",
	fontSize: "12px",
	fontWeight: 600,
	lineHeight: 1.5,
	textAlign: "center" as const,
	flexShrink: 0,
	zIndex: 10,
}

/** 格式化 mm:ss */
function formatRemaining(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

export const TeachingBlockingBanner: React.FC = () => {
	const { teachingBlocking } = useExtensionState()
	const [now, setNow] = useState<number>(() => Date.now())

	// 阻断激活期间每秒刷新一次本地时间，驱动倒计时
	useEffect(() => {
		if (!teachingBlocking?.active) {
			return
		}
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [teachingBlocking?.active, teachingBlocking?.endsAt])

	// 未激活或数据缺失时不渲染
	if (!teachingBlocking?.active || typeof teachingBlocking.endsAt !== "number") {
		return null
	}

	const remaining = Math.max(0, Math.ceil((teachingBlocking.endsAt - now) / 1000))

	// 倒计时归零后隐藏（扩展端下一次推送状态时也会清除）
	if (remaining <= 0) {
		return null
	}

	return (
		<div aria-live="polite" role="status" style={BLOCKING_STYLE}>
			<span aria-hidden>⏳</span>
			<span>教学干预中：代码生成与工具执行已暂停</span>
			<span style={{ fontVariantNumeric: "tabular-nums", letterSpacing: "1px" }}>剩余 {formatRemaining(remaining)}</span>
		</div>
	)
}

export default TeachingBlockingBanner
