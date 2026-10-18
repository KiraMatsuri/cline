/**
 * 【P7/T2】「助手给出了可直接运行的完整实现」的判定（纯函数，可单测、可离线复算）。
 *
 * 为什么要单独一个模块：裁定 2 让这个判定从**仅用于日志可见化**变成**会计数、且会触发阻断**的信号。
 * 一个会阻断学生的判定不能只有"看起来差不多"，必须能用一张正/负例表复核。
 *
 * 与 `detectConceptModeViolation` 的关系：后者保留导出（既有单测与离线复算在用），
 * 但**改为委托本模块** —— 否则"日志说违规、计数器却没动"这种双口径迟早出现。
 *
 * 判据（四条**同时**成立）：
 *   1. 存在 fenced 代码块，且有效行数 ≥ 6；
 *   2. 块内含结构关键字（`def` / `class` / `for` / `while` / `function` / 变量声明）；
 *   3. 块内**不含占位符 / 未完成标记**（`___`、`TODO`、`…`、"自己写"…）；
 *   4. 块在剥离注释与字符串字面量后**不含中文字符**（中文伪代码因此被排除）。
 *
 * 第 3、4 条是 2026-10-18 实测逼出来的：当时的"填空模板"有 7 个有效行、含 `for`，
 * 只按行数 + 循环判定会被当成"完整实现" ⇒ 助手连给 3 次填空模板就被阻断，
 * 与「AI 代写 3 次才阻断」的产品语义正好相反。
 */
import { parseFencedCodeBlocks } from "@/shared/markdown/codeBlocks"

export interface FullImplementationVerdict {
	detected: boolean
	reason?: string
	/** 命中的代码块有效行数（日志定位用） */
	blockLines?: number
	/** 命中的代码块语言标签（可能为空） */
	blockLang?: string
}

/** 判为"像完整实现"的最小有效行数（保守：低于此视为片段） */
export const MIN_COMPLETE_IMPL_LINES = 6

/** 结构关键字：完整实现至少要有其中一种构造 */
const STRUCTURE_PATTERN = /(?:^|\n)[ \t]*(?:def |class |for |while |function |export |public |private |const |let |var )/

/** 占位符 / 未完成标记：出现任一即**不算**完整实现 */
const PLACEHOLDER_PATTERN = /(?:_{3,}|<\s*填|待补|补全|TODO|FIXME|\.\.\.|…|省略|自行填写|自己写|自行完成)/i

const CJK_PATTERN = /[\u4e00-\u9fff]/

/**
 * 剥离注释与字符串字面量，只留下"代码本身"。
 * 目的：中文注释 / 中文提示字符串是合法的（`print("你好")`），不能因此判成伪代码；
 * 而中文**关键字**（`如果 a[j] > a[j+1]`）会留下来被 CJK 检测抓到。
 */
function stripCommentsAndStrings(code: string): string {
	return code
		.replace(/"""[\s\S]*?"""/g, '""') // Python 三引号
		.replace(/'''[\s\S]*?'''/g, "''")
		.replace(/(?<![:"'])#[^\n]*/g, "") // 行注释（避开 # 位于字符串内/颜色值等场景）
		.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
		.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
}

export function detectFullImplementation(text: string): FullImplementationVerdict {
	for (const block of parseFencedCodeBlocks(text)) {
		if (block.lineCount < MIN_COMPLETE_IMPL_LINES) {
			continue
		}
		if (!STRUCTURE_PATTERN.test(block.inner)) {
			continue
		}
		if (PLACEHOLDER_PATTERN.test(block.inner)) {
			continue
		}
		if (CJK_PATTERN.test(stripCommentsAndStrings(block.inner))) {
			continue
		}
		return {
			detected: true,
			reason: `fenced 代码块含结构关键字、有效行数 ${block.lineCount} ≥ ${MIN_COMPLETE_IMPL_LINES}，且无占位符与中文伪代码`,
			blockLines: block.lineCount,
			blockLang: block.lang || undefined,
		}
	}
	return { detected: false }
}
