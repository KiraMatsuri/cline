/**
 * =============================================================================
 *  ResponsiveModal — 自适应 VS Code 侧栏宽度的 Modal 通用组件 (v2.3 增量)
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【动机】
 * VS Code 侧边栏的宽度可被用户自由拖拽（300px ~ 600px+）。
 * 之前教学组件 (AssignmentHeader/LLMSettingsView) 中的 Modal 使用了硬编码
 * `minWidth: 360 / maxWidth: 480`，当侧栏较窄时 Modal 会撑出侧栏或被截断。
 *
 * 【方案】
 * 监听 window.resize 事件，根据 `window.innerWidth` 计算当前可用宽度：
 *
 *     modalWidth = Math.min(
 *       Math.max(window.innerWidth - 32, MIN_WIDTH),  // 留 16px 边距，下限 280px
 *       MAX_WIDTH                                      // 上限 480px（PC 体验）
 *     )
 *
 * 这样：
 * - 侧栏 < 312px 时 Modal 占满侧栏
 * - 侧栏 312~512px 时 Modal 自适应
 * - 侧栏 > 512px 时 Modal 保持 480px 居中
 *
 * 【决策点 2.A】
 * 选择 `window.innerWidth`（简单且响应 VS Code 拖拽），
 * 不使用 ResizeObserver（webview 兼容性需验证，本轮先验证此方案）。
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
 * 自适应宽度的 Modal。
 *
 * 用法：
 * ```tsx
 * <ResponsiveModal visible={open} onClose={() => setOpen(false)}>
 *   <h3>标题</h3>
 *   <p>内容...</p>
 * </ResponsiveModal>
 * ```
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
	// ----- 监听 window.innerWidth 变化 -----
	const [viewportWidth, setViewportWidth] = useState<number>(() => {
		if (typeof window === "undefined") return maxWidth
		return window.innerWidth
	})

	useEffect(() => {
		if (!visible) return
		const onResize = () => setViewportWidth(window.innerWidth)
		window.addEventListener("resize", onResize)
		// 进入可见时主动同步一次（处理"首次打开"时父级 layout 变化的情况）
		onResize()
		return () => window.removeEventListener("resize", onResize)
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
	const computedWidth = Math.min(
		Math.max(viewportWidth - horizontalPadding, minWidth),
		maxWidth,
	)

	const overlayStyle: React.CSSProperties = {
		position: "fixed",
		inset: 0,
		background: "rgba(0,0,0,0.4)",
		display: "flex",
		alignItems: "center",
		justifyContent: "center",
		zIndex: 9999,
	}

	const modalStyleMerged: React.CSSProperties = {
		background: "var(--vscode-editor-background)",
		border: "1px solid var(--vscode-panel-border)",
		padding: 20,
		borderRadius: 6,
		fontSize: 13,
		width: computedWidth,
		maxWidth: "calc(100vw - 32px)",
		boxSizing: "border-box",
		...modalStyle,
	}

	return (
		<div onClick={onClose} style={overlayStyle} role="dialog" aria-modal="true">
			<div onClick={(e) => e.stopPropagation()} style={modalStyleMerged}>
				{children}
			</div>
		</div>
	)
}

export default ResponsiveModal