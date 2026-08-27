import type { Boolean, EmptyRequest } from "@shared/proto/cline/common"
import { useEffect } from "react"
import AccountView from "./components/account/AccountView"
import ChatView from "./components/chat/ChatView"
import HistoryView from "./components/history/HistoryView"
import McpView from "./components/mcp/configuration/McpConfigurationView"
import OnboardingView from "./components/onboarding/OnboardingView"
import SettingsView from "./components/settings/SettingsView"
import { AssignmentErrorBoundary } from "./components/teaching/AssignmentErrorBoundary"
import AssignmentTab from "./components/teaching/AssignmentTab"
import LLMSettingsView from "./components/teaching/LLMSettingsView"
import WorktreesView from "./components/worktrees/WorktreesView"
import { useClineAuth } from "./context/ClineAuthContext"
import { useExtensionState } from "./context/ExtensionStateContext"
import { Providers } from "./Providers"
import { UiServiceClient } from "./services/grpc-client"

/**
 * 识别当前 webview 容器（v1.3 增量）
 * - LLMSettingsViewProvider 在 HTML 写入 `<div id="root" data-view="clineLLMSettings">`
 * - 主 SidebarProvider 不写 data-view
 * - 通过此 hook 在 LLMSettingsView webview 中跳过所有主逻辑，直接渲染设置页
 */
function useCurrentWebviewView(): string | undefined {
	if (typeof document === "undefined") return undefined
	const root = document.getElementById("root")
	return root?.getAttribute("data-view") ?? undefined
}

const AppContent = () => {
	const currentView = useCurrentWebviewView()

	// 【v1.3 增量】独立的 LLMSettingsView webview：跳过主侧边栏全部状态，直接渲染
	if (currentView === "clineLLMSettings") {
		return <LLMSettingsView />
	}

	const {
		didHydrateState,
		showWelcome,
		shouldShowAnnouncement,
		showMcp,
		mcpTab,
		showSettings,
		settingsTargetSection,
		showHistory,
		showAccount,
		showWorktrees,
		showAnnouncement,
		showTeaching,
		setShowTeaching,
		setShowAnnouncement,
		setShouldShowAnnouncement,
		closeMcpView,
		navigateToHistory,
		hideSettings,
		hideHistory,
		hideAccount,
		hideWorktrees,
		hideAnnouncement,
	} = useExtensionState()

	const { clineUser, organizations, activeOrganization } = useClineAuth()

	useEffect(() => {
		if (shouldShowAnnouncement) {
			setShowAnnouncement(true)

			// Use the gRPC client instead of direct WebviewMessage
			UiServiceClient.onDidShowAnnouncement({} as EmptyRequest)
				.then((response: Boolean) => {
					setShouldShowAnnouncement(response.value)
				})
				.catch((error) => {
					console.error("Failed to acknowledge announcement:", error)
				})
		}
	}, [shouldShowAnnouncement, setShouldShowAnnouncement, setShowAnnouncement])

	if (!didHydrateState) {
		return null
	}

	if (showWelcome) {
		// v1.0.3 教学版：Onboarding 不再依赖云端模型列表（去 Cline 账号路线，仅 BYOK 配置）
		return <OnboardingView />
	}

	return (
		<div className="flex h-screen w-full flex-col">
			{showSettings && <SettingsView onDone={hideSettings} targetSection={settingsTargetSection} />}
			{showHistory && <HistoryView onDone={hideHistory} />}
			{showMcp && <McpView initialTab={mcpTab} onDone={closeMcpView} />}
			{showAccount && (
				<AccountView
					activeOrganization={activeOrganization}
					clineUser={clineUser}
					onDone={hideAccount}
					organizations={organizations}
				/>
			)}
			{showWorktrees && <WorktreesView onDone={hideWorktrees} />}
			{showTeaching && (
				<AssignmentErrorBoundary>
					<AssignmentTab />
				</AssignmentErrorBoundary>
			)}
			{/* Do not conditionally load ChatView, it's expensive and there's state we don't want to lose (user input, disableInput, askResponse promise, etc.) */}
			<ChatView
				hideAnnouncement={hideAnnouncement}
				isHidden={showSettings || showHistory || showMcp || showAccount || showWorktrees || showTeaching}
				showAnnouncement={showAnnouncement}
				showHistoryView={navigateToHistory}
			/>
		</div>
	)
}

const App = () => {
	return (
		<Providers>
			<AppContent />
		</Providers>
	)
}

export default App
