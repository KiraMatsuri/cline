import { Component, type ErrorInfo, type ReactNode } from "react"

/**
 * 简易 ErrorBoundary，用于捕获 AssignmentTab 内的渲染错误，
 * 让 Webview 不会整页白屏，而是显示具体错误堆栈，
 * 便于调试 IPC 与 React 集成问题。
 */
export class AssignmentErrorBoundary extends Component<
	{ children: ReactNode },
	{ error: Error | null }
> {
	constructor(props: { children: ReactNode }) {
		super(props)
		this.state = { error: null }
	}

	static getDerivedStateFromError(error: Error): { error: Error } {
		return { error }
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		// 记录到控制台，方便开发时查看
		console.error("[AssignmentErrorBoundary] Caught error:", error, info)
	}

	render(): ReactNode {
		if (this.state.error) {
			return (
				<div
					style={{
						padding: "16px",
						margin: "16px",
						border: "1px solid #b91c1c",
						borderRadius: "8px",
						background: "#fef2f2",
						color: "#7f1d1d",
						fontFamily: "monospace",
						fontSize: "12px",
						whiteSpace: "pre-wrap",
						overflow: "auto",
					}}>
					<strong>❌ 实验任务视图渲染出错</strong>
					<br />
					<br />
					{this.state.error.message}
					<br />
					<br />
					{this.state.error.stack}
				</div>
			)
		}
		return this.props.children
	}
}