/**
 * OnboardingView — 首次使用引导（v1.0.3 教学版重写）
 *
 * 【改动】去除 Cline 品牌（Logo/文案）与官方账号登录（FREE/POWER 路线、
 * cline.bot OAuth、遥测上报全部移除）。仅保留 BYOK 配置路线：
 *   step 0 欢迎页 → step 1 API 配置（ApiConfigurationSection）→ 完成
 *
 * 【设计说明】
 * - ApiConfigurationSection 为共享组件（设置页同用），不在本次范围
 * - 遥测（captureOnboardingProgress → cline.bot）按设计文档删除，学生端零外联
 */

import { AlertCircleIcon } from "lucide-react"
import { useCallback, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import ApiConfigurationSection from "../settings/sections/ApiConfigurationSection"
import { NEW_USER_TYPE, STEP_CONFIG } from "./data-steps"

type FooterAction = "next" | "back" | "done"

const OnboardingView = () => {
	const { hideSettings, hideAccount, setShowWelcome } = useExtensionState()
	const [stepNumber, setStepNumber] = useState(0)

	const finishOnboarding = useCallback(async () => {
		hideAccount()
		hideSettings()
	}, [hideAccount, hideSettings])

	const handleFooterAction = useCallback(
		async (action: FooterAction) => {
			switch (action) {
				case "next":
					setStepNumber(stepNumber + 1)
					break
				case "back":
					setStepNumber(stepNumber - 1)
					break
				case "done":
					// 【v1.0.3 修复】必须先持久化 welcomeViewCompleted=true（扩展端全局状态），
					// 否则每次状态刷新（如打开设置）都会重新弹出 onboarding
					await StateServiceClient.setWelcomeViewCompleted({ value: true }).catch(() => {})
					setShowWelcome(false)
					await finishOnboarding()
					break
			}
		},
		[stepNumber, finishOnboarding, setShowWelcome],
	)

	const stepDisplayInfo = STEP_CONFIG[stepNumber === 0 ? 0 : NEW_USER_TYPE.BYOK]

	return (
		<div className="fixed inset-0 p-0 flex flex-col w-full">
			<div className="h-full px-5 xs:mx-10 overflow-auto flex flex-col gap-4 items-center justify-center">
				{/* 品牌标识：与市场图标风格呼应的 </> 字符标识（替代原 Cline Logo） */}
				<div
					className="flex items-center justify-center rounded-2xl bg-button-background text-button-foreground font-bold flex-shrink-0"
					style={{ width: 56, height: 56, fontSize: 22 }}>
					{"</>"}
				</div>
				<h2 className="text-lg font-semibold p-0 flex-shrink-0">{stepDisplayInfo.title}</h2>
				{stepDisplayInfo.description && (
					<p className="text-foreground text-sm text-center m-0 p-0 flex-shrink-0">{stepDisplayInfo.description}</p>
				)}

				<div className="flex-1 w-full flex max-w-lg overflow-y-auto min-h-0">
					{stepNumber === 0 ? null : <ApiConfigurationSection />}
				</div>

				<footer className="flex w-full max-w-lg flex-col gap-3 my-2 px-2 overflow-hidden flex-shrink-0">
					{stepDisplayInfo.buttons.map((btn) => (
						<Button
							className="w-full rounded-xs"
							key={btn.text}
							onClick={() => handleFooterAction(btn.action)}
							variant={btn.variant}>
							{btn.text}
						</Button>
					))}

					<div className="items-center justify-center flex text-sm text-foreground gap-2 mb-3 text-pretty">
						<AlertCircleIcon className="shrink-0 size-2" /> 可随时在「设置」中修改配置
					</div>
				</footer>
			</div>
		</div>
	)
}

export default OnboardingView
