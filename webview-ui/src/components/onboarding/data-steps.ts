/**
 * Onboarding 流程配置（v1.0.3 教学版重写）
 *
 * 【改动】去除 Cline 品牌与官方账号登录（FREE/POWER 路线全部移除），
 * 仅保留 BYOK（自带 API Key）配置路线，供学生填写课程提供的 AI 服务。
 *
 * 流程：step 0 欢迎页 → step 1 API 配置 → 完成
 */

export enum NEW_USER_TYPE {
	BYOK = "byok",
}

export const STEP_CONFIG = {
	0: {
		title: "欢迎使用学生端编程教学助手",
		description: "配置课程提供的 AI 服务后即可开始使用，全程数据保留在本地与课程服务器。",
		buttons: [{ text: "开始配置", action: "next", variant: "default" }],
	},
	[NEW_USER_TYPE.BYOK]: {
		title: "配置 AI 服务",
		description: "填写课程提供的 API 地址与密钥（OpenAI Compatible）。完成配置后即可开始实验。",
		buttons: [
			{ text: "完成配置", action: "done", variant: "default" },
			{ text: "返回", action: "back", variant: "secondary" },
		],
	},
} as const
