/**
 * 【P6/T9】b+c 服从流程的两个纯函数判定。
 *
 * 为什么单独一个模块：与 `demandDetect` 同一角色 —— 判定必须可单测、可复盘，
 * 且刻意**保守**（宁漏勿误）：误判会把"只是要代码"当成"能力不足"，
 * 从而在错误的时机给出完整实现；漏判只会让学生再问一次。
 */

/** 「我写不出来」类自述（刻意收窄：只认第一人称的能力自述） */
const INABILITY_PATTERNS: readonly RegExp[] = [
	/我(?:真的|确实|实在|完全)?(?:不会|不懂|写不出来|写不出|想不出来|想不到|没思路|没有思路)/,
	/我(?:实在|真的)?(?:写|做|编|拼)不(?:出来|出)/,
	/(?:照|按)着(?:写|抄)也(?:写|做)不(?:出来|出)/,
	/我看不懂/,
	/(?:你)?(?:就)?别问了/,
]

/** 肯定答复（保守：只认整句肯定，避免"不是/先不要"被误判） */
const AFFIRMATION_PATTERNS: readonly RegExp[] = [
	/^(?:是|是的|对|对的|好|好的|行|可以|要|嗯|就这样|给我|请给|直接给)[。！!，,～~、\s]{0,4}$/,
	/^(?:可以|好的|行)[，,].{0,8}$/,
]

export function isInabilityStatement(text: string | undefined): boolean {
	const t = (text ?? "").trim()
	if (!t) {
		return false
	}
	return INABILITY_PATTERNS.some((re) => re.test(t))
}

export function isAffirmation(text: string | undefined): boolean {
	const t = (text ?? "").trim()
	if (!t) {
		return false
	}
	return AFFIRMATION_PATTERNS.some((re) => re.test(t))
}
