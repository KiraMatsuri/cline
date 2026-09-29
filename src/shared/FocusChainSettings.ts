export interface FocusChainSettings {
	// Enable/disable the focus chain feature
	enabled: boolean
	// Interval (in messages) to remind Cline about focus chain
	remindClineInterval: number
}

export const DEFAULT_FOCUS_CHAIN_SETTINGS: FocusChainSettings = {
	// 【教学 v2.13】学生端默认关闭。三个理由：
	//   1) 每轮会在用户消息里附带一段约 838 字符的 task_progress 提醒，白烧 token
	//      （实测一个 7 轮任务因此多烧约 5.9k 字符）；
	//   2) 它驱动模型在每次工具调用里都附带 task_progress 清单 —— 而实测模型泄漏工具调用标记时，
	//      多行参数值**只有首尾两行带标记**，中间那行会漏进学生聊天（见 assistantTextSanitizer）；
	//   3) 学生看到一个自动生成的 TODO 清单并不自然。
	//
	// ⚠️ 只改默认值**不够**：该值来自 VS Code 的 ExtensionContext.globalState，
	// 只要历史上被写过 `enabled: true`（例如老师点过设置页开关），默认值就不再生效。
	// 因此三个读取点（Task 初始化 / 系统提示词上下文 / Controller 下发给 webview）
	// 都就地强制 `enabled: false`，保证学生端"关得住"。代价：设置页那个开关会恒显为关。
	enabled: false,
	remindClineInterval: 6,
}
