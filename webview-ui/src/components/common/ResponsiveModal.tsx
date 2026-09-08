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
 * 【方案 v2.9.1 —— 可视视口锁定】
 * v2.3.2 的 `top:0; bottom:0` 让覆盖层铺满**整个文档**（而非可视区域），
 * flex 垂直居中的参考系是整篇文档：长页面（如 LLM 设置）滚动到底部
 * 打开弹窗时，弹窗出现在文档中部（视口上方），无法完整看到。
 * 修复：覆盖层锚定 `top = 当前滚动偏移`、`height = 可视高度`，
 * 监听 scroll 实时跟随 —— 弹窗始终在可视区域内居中，等效于全局顶层固定，
 * 且不回退到已知在 webview 中会错位的 `position: fixed`。
 * 另将 `alignItems: center` 改为 `flex-start` + Modal `margin: auto`：
 * 能放下时垂直居中，放不下时顶部对齐可滚动（避免 flex 居中溢出裁切）。
 *
 * =============================================================================
 */

import type { FC, ReactNode } from "react"
import { useEffect, useLayoutEffect, useState } from "react"

export interface ResponsiveModalProps {
	/** 是否显示 */
	visible: boolean
	/** 关闭回调（点击遮罩或 ESC 时触发） */
	onClose: () => void
	/** Modal 内容 */
	children: ReactNode
	/** 最小宽度（px），默认 0（不设下限，完全自适应容器） */
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
 * 【v2.9.1】测量 webview 可视视口：滚动偏移 + 可见高度。
 *
 * 与宽度同理：documentElement.clientHeight 是 webview 文档的可见高度；
 * 滚动偏移优先 window.scrollY（iframe 自身窗口的滚动位置）。
 */
function measureViewport(): { scrollTop: number; height: number } {
	if (typeof document === "undefined") return { scrollTop: 0, height: 600 }
	const root = document.documentElement
	const height = root?.clientHeight || 0
	const scrollTop = window.scrollY || window.pageYOffset || root?.scrollTop || 0
	return { scrollTop, height: height > 0 ? height : 600 }
}

/**
 * 自适应宽度的 Modal。
 */
const ResponsiveModal: FC<ResponsiveModalProps> = ({
	visible,
	onClose,
	children,
	minWidth = 0,
	maxWidth = 480,
	modalStyle,
	closeOnEsc = true,
}) => {
	// ----- 监听 webview 容器宽度变化 + 【v2.9.1】可视视口滚动/尺寸 -----
	const [containerWidth, setContainerWidth] = useState<number>(() => measureContainerWidth())
	const [viewport, setViewport] = useState<{ scrollTop: number; height: number }>(() => measureViewport())

	// useLayoutEffect：打开瞬间同步测量，避免首帧渲染在 top:0（闪一下）
	useLayoutEffect(() => {
		if (!visible) return

		const update = () => {
			setContainerWidth(measureContainerWidth())
			setViewport(measureViewport())
		}

		// 进入可见时立即同步（浏览器绘制前）
		update()

		// 方案 1：ResizeObserver（推荐，响应最精准）
		let observer: ResizeObserver | null = null
		if (typeof ResizeObserver !== "undefined" && document.documentElement) {
			observer = new ResizeObserver(() => update())
			observer.observe(document.documentElement)
		}

		// 方案 2：window.resize 兜底（部分 webview 配置下 ResizeObserver 不触发）
		window.addEventListener("resize", update)

		// 【v2.9.1】页面滚动跟随：覆盖层锁定可视视口，滚动时弹窗保持居中
		window.addEventListener("scroll", update, { passive: true })

		return () => {
			observer?.disconnect()
			window.removeEventListener("resize", update)
			window.removeEventListener("scroll", update)
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

	// 计算 Modal 宽度：留 16px 边距，下限 minWidth（默认 0），上限 maxWidth
	const horizontalPadding = 16 // 【v2.3.3】从 32 缩到 16，配合 padding:14 减少占用
	const computedWidth = Math.min(Math.max(containerWidth - horizontalPadding, minWidth), maxWidth)

	// 【v2.3.2】覆盖层 absolute 锚定 body（需 main.css 把 body 设为 position:relative）
	// 【v2.9.1】top = 当前滚动偏移、height = 可视高度 → 覆盖层锁定可视视口而非整个文档；
	// 滚动时由 scroll 监听实时更新，弹窗等效于全局顶层固定居中
	const overlayStyle: React.CSSProperties = {
		position: "absolute",
		top: viewport.scrollTop,
		left: 0,
		right: 0,
		height: viewport.height,
		background: "rgba(0,0,0,0.4)",
		display: "flex",
		// 配合 Modal margin:auto：能放下时垂直居中，放不下时顶部对齐可滚动（避免 flex 居中溢出裁切）
		alignItems: "flex-start",
		justifyContent: "center",
		zIndex: 9999,
		overflow: "auto",
		padding: "12px 0",
	}

	const modalStyleMerged: React.CSSProperties = {
		background: "var(--vscode-editor-background)",
		border: "1px solid var(--vscode-panel-border)",
		padding: 14, // 【v2.3.3】从 20 缩到 14，给小侧栏更多空间
		borderRadius: 6,
		fontSize: 13,
		width: computedWidth,
		// 兜底：不能超过容器宽度 - 16px
		maxWidth: `calc(${containerWidth}px - 16px)`,
		boxSizing: "border-box",
		// 【v2.9.1】margin:auto —— 配合覆盖层 flex-start：小于视口时垂直居中，超出时顶部对齐可滚动
		margin: "auto",
		// 【v2.3.3】防止内部元素（如 input/button 默认 min-content）撑出 Modal
		overflowWrap: "break-word",
		minWidth: 0,
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
