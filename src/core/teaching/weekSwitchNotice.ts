/**
 * 【F7】周数切换通知：状态转移的纯函数，便于单测（index.ts 侧只负责调用与拼接）。
 *
 * 为什么要注入这条通知：切换周数后模型会延续自己此前基于旧进度的拒答（"对话历史自我锚定"，
 * 见 spec §8.3）。显式告知"周次已变更"是对抗它的最低成本手段。
 */
export interface WeekSwitchResult {
	/** 需要追加到本轮 userContent 的文本；无需通知时为 null */
	notice: string | null
	/** 记回 Task 的 lastInjectedWeek */
	lastWeek: number
}

export function nextWeekSwitch(lastWeek: number | undefined, currentWeek: number): WeekSwitchResult {
	// 首次（lastWeek undefined）只记录不通知：否则每个新任务都会平白多一条通知
	if (lastWeek === undefined || lastWeek === currentWeek) {
		return { notice: null, lastWeek: currentWeek }
	}
	return {
		notice: `⚠️ 教学周已由第 ${lastWeek} 周切换为第 ${currentWeek} 周；此前基于旧进度的回答请以新进度为准。`,
		lastWeek: currentWeek,
	}
}
