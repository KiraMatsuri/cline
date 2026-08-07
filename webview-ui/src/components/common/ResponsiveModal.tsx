/**
 * =============================================================================
 *  ResponsiveModal — 自适应 VS Code webview 容器宽度的 Modal 通用组件 (v2.3 增量)
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【动机】
 * VS Code 侧边栏的宽度可被用户自由拖拽（300px ~ 600px+）。
 * 之前教学组件 (AssignmentHeader/LLMSettingsView) 中的 Modal 使用了硬编码
 * `minWidth: 360 / maxWidth: 480`，当侧栏较窄时 Modal 会撑出侧栏或被截断。
 *
 * 【关键洞察 v2.3.2】
 * 阶段 2 + v2.3.1 修复后 Modal 仍然超出侧栏边缘（用户多次反馈）。
 * 真正的根因是 `position: fixed`：在 VS Code webview 中，
 * fixed 定位的参考系是宿主浏览器视口（数百~上千 px），
 * 而不是 webview iframe 容器本身。即使宽度算对了，
 * Modal 仍然会在视口上"居中"，看起来像是左侧被遮挡。
 *
 * 【方案 v2.3.2】
 * 1. 覆盖层改用 `position: absolute`，并把 <body> 设为 `position: relative`
 *    让 Modal 锚定到 webview 容器（参见 main.css 的 `body { position: relative; }`）
 * 2. Modal 内容用 `margin: 0 auto` 居中，避免依赖 flex/grid 居中（更兼容）
 * 3. 宽度测量保持 v2.3.1 的 ResizeObserver + clientWidth 方案
 *
 * 这样：
 * - Modal 永远锚定在 webview 容器内部
 * - 拖拽侧栏时 ResizeObserver 触发重渲染
 * - Modal 不会"飞出"webview 边界
 *
 * =============================================================================
 */

import type { FC, ReactNode } from "react"
import { useEffect, useState } from "react"

export interface ResponsiveModalProps {
	/** 是否显示 */
	visible: boolean
	/** 关闭回调（点击遮罩或 ESC 时触发） */
	onClose: () => void
	/** Modal 内容 */
	children: ReactNode
	/** 最小宽度（px），默认 280 */
	minWidth?: number
	/** 最大宽度（px），默认 480 */
	maxWidth?: number
	/** Modal 容器额外样式 */
	modalStyle?: React.CSSProperties
	/** ESC 键关闭，默认 true */
	closeOnEsc?: boolean
}

/**
 * 测量 webview 容器的真实宽度。
 *
 * 关键：webview 是 iframe，window.innerWidth 是宿主窗口宽度（不正确）。
 * document.documentElement.clientWidth 才是 webview 容器的可见宽度。
 */
function measureContainerWidth(): number {
	if (typeof document === "undefined") return 480
	const root = document.documentElement
	const width = root?.clientWidth || document.body?.clientWidth || 0
	return width > 0 ? width : 480
}

/**
 * 自适应宽度的 Modal。
 */
const ResponsiveModal: FC<ResponsiveModalProps> = ({
	visible,
	onClose,
	children,
	minWidth = 280,
	maxWidth = 480,
	modalStyle,
	closeOnEsc = true,
}) => {
	// ----- 监听 webview 容器宽度变化 -----
	const [containerWidth, setContainerWidth] = useState<number>(() => measureContainerWidth())

	useEffect(() => {
		if (!visible) return

		const update = () => setContainerWidth(measureContainerWidth())

		// 进入可见时立即同步
		update()

		// 方案 1：ResizeObserver（推荐，响应最精准）
		let observer: ResizeObserver | null = null
		if (typeof ResizeObserver !== "undefined" && document.documentElement) {
			observer = new ResizeObserver(() => update())
			observer.observe(document.documentElement)
		}

		// 方案 2：window.resize 兜底（部分 webview 配置下 ResizeObserver 不触发）
		window.addEventListener("resize", update)

		return () => {
			observer?.disconnect()
			window.removeEventListener("resize", update)
		}
	}, [visible])

	// ----- ESC 关闭 -----
	useEffect(() => {
		if (!visible || !closeOnEsc) return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation()
				onClose()
			}
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [visible, closeOnEsc, onClose])

	if (!visible) return null

	// 计算 Modal 宽度：留 16px 边距，下限 minWidth，上限 maxWidth
	const horizontalPadding = 32
	const computedWidth = Math.min(Math.max(containerWidth - horizontalPadding, minWidth), maxWidth)

	// 【v2.3.2】覆盖层改用 absolute 锚定到 body（需 main.css 把 body 设为 position:relative）
	// 不能再用 fixed：fixed 在 webview 内会相对宿主视口定位，导致 Modal 飞出 iframe 边界
	const overlayStyle: React.CSSProperties = {
		position: "absolute",
		top: 0,
		left: 0,
		right: 0,
		bottom: 0,
		background: "rgba(0,0,0,0.4)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 9999,
		overflow: "auto",
	}

	const modalStyleMerged: React.CSSProperties = {
		background: "var(--vscode-editor-background)",
		border: "1px solid var(--vscode-panel-border)",
		padding: 20,
		borderRadius: 6,
		fontSize: 13,
		width: computedWidth,
		// 双重保护：即使 maxWidth 算错，也不能超过 webview 容器宽度 - 32px 边距
		maxWidth: `calc(${containerWidth}px - 32px)`,
		boxSizing: "border-box",
		margin: "16px auto", // 上下留 16px，左右 auto 居中（不依赖 flex）
		...modalStyle,
	}

	return (
		<div aria-modal="true" onClick={onClose} role="dialog" style={overlayStyle}>
			<div onClick={(e) => e.stopPropagation()} style={modalStyleMerged}>
				{children}
			</div>
		</div>
	)
}

export default ResponsiveModal
