/**
 * 【P6/T9】b+c 服从流程的两个纯函数判定。
 *
 * 为什么单独一个模块：与 `demandDetect` 同一角色 —— 判定必须可单测、可复盘。
 *
 * ⚠️ **判定口径**（【P6/T9 fix F3-①】登记，勿再声称"宁漏勿误"）：
 * `我不懂…` / `我看不懂…` 这类**理解性提问**同样命中（brief 的测试明文要求 `我看不懂这段 → true`）——
 * 学生会先看到一次"你是希望我直接给出完整实现吗？"的询问。这是**产品裁定**
 * （宁可多问一次：学生答"不是"即落 `denied` 回引导态，代价只是多一步确认；收益是不漏掉真正的"写不出来"），
 * 不是判定实现偏离。另一半仍偏保守：`我写一个…` / `请提供完整实现` 这类**索要**不算自述能力不足。
 */

/** 「我写不出来」类自述（只认第一人称的能力/理解自述） */
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
