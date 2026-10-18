/**
 * 【P8/T3】路径键归一化（纯函数）。
 *
 * 为什么单独一层：`BehaviorMonitor` 需要把「本请求内 AI 写过哪些文件」与「学生编辑过哪些文件」
 * 做**集合差**，而日志里的 `filePath` 形态不统一（`a.py` / `./a.py` / `dir\\a.py` / `A.PY`）。
 * 这里只做"同源可比较"的最小归一，**不**做绝对/相对转换 —— monitor 侧两边的值都来自同一个日志字段，
 * 同源即可（绝对路径的归属判定另有 `FileContextTracker.canonicalPathKey`，职责不同）。
 */
export function normalizePathKey(filePath: string): string {
	return filePath
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/\/{2,}/g, "/")
		.replace(/\/+$/, "")
		.toLowerCase()
}
