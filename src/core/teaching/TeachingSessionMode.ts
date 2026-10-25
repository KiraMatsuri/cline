/**
 * 会话模式（P1-1）
 *
 * 两种模式（见设计文档 §4）：
 *   - `experiment`：从任务面板「开始实验」进入，工作目录是 `experiments/<assignmentId>/`；
 *     记录行为日志、启用干预、按 4 次阶梯才给伪代码。
 *   - `free`：普通对话（不在实验目录里）；**不记行为日志、不干预**，但仍可用教材检索，
 *     阶梯 3 次即可给完整实现（要求逐段中文注释）。
 *
 * 为什么需要单一判定点：日志、干预、指纹、阶梯阈值分散在四个模块里，
 * 每个模块各自判断"现在是什么模式"必然写出不一致的规则（历史上已经发生过一次
 * 「自由模式还在计依赖度」的错账），所以这里只暴露纯函数 + 一个上下文对象。
 */
import fs from "fs"
import * as path from "path"

import { isCompleteImplDemand } from "../task/student-analytics/demandDetect"
import { detectFullImplementation } from "../task/student-analytics/fullImplementationDetect"
import { type ExperimentSession, experimentLogRoot, readActiveExperiment } from "./ExperimentSession"

export type SessionMode = "free" | "experiment"

export interface SessionContext {
	mode: SessionMode
	/** 实验模式下的任务 id（目录名）；自由模式为 undefined */
	experimentId?: string
	/** 行为日志根目录（实验模式 = 实验目录；自由模式 = 工作区根，仅用于定位，不写入） */
	logRoot: string
	/** 索要完整实现的放行阶梯：free=3 / experiment=4 */
	ladderLimit: number
	/**
	 * 当前会话内「明确索要完整实现」的连续次数（P1-6）。
	 *
	 * 为什么允许缺省：SessionContext 被多处按字面量构造（历史测试/其他模块），
	 * 把新增字段设成必填会强迫所有调用点同步改；由 bumpDemandCounter 等函数按 `?? 0` 兜底。
	 */
	demandCount?: number
}

/** 实验目录的固定前缀（与 P1-3 的 `ensureExperimentWorkspace` 共用） */
export const EXPERIMENT_ROOT = "experiments"

/** 任务元数据文件（相对实验目录） */
export const EXPERIMENT_TASK_FILE = path.join(".teaching", "task.json")

/** 阶梯：第 N 次索要才放行（free 给完整实现，experiment 给伪代码） */
export const DEMAND_LADDER: Record<SessionMode, number> = {
	free: 3,
	experiment: 4,
}

export interface ExperimentTaskFile {
	assignmentId?: string
	mode?: string
	startedAt?: string
}

/**
 * 从绝对路径里识别「是否在 experiments/<id>/ 目录内」。
 *
 * 用路径而不是「当前打开的编辑器文件」判定：学生可能把编辑器切到别的文件（甚至别的目录），
 * 但任务的 cwd 是不变的；按打开文件判定会导致模式在会话中途跳变。
 */
export function detectExperimentId(cwd: string): string | null {
	if (!cwd) return null
	const segments = path
		.normalize(cwd)
		.split(/[\\/]+/)
		.filter(Boolean)
	const idx = segments.lastIndexOf(EXPERIMENT_ROOT)
	if (idx < 0 || idx + 1 >= segments.length) return null
	const id = segments[idx + 1]
	return id ? id : null
}

/**
 * 读取实验目录里的任务元数据。
 *
 * 边界：文件缺失 / JSON 损坏 / 字段缺失都返回 null（**不抛**）——一块损坏的元数据
 * 不该让整个任务起不来；此时按"目录像是实验目录"降级仍然可用（见 resolveSessionContext）。
 */
export function readExperimentTask(cwd: string): ExperimentTaskFile | null {
	if (!cwd) return null
	try {
		const file = path.join(cwd, EXPERIMENT_TASK_FILE)
		if (!fs.existsSync(file)) return null
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ExperimentTaskFile
		if (!parsed || typeof parsed !== "object") return null
		return parsed
	} catch {
		return null
	}
}

export interface ResolveSessionInput {
	/** 任务工作目录（Task.cwd） */
	cwd: string
	/** 工作区根（聊天任务 cwd 即根；缺省取 cwd） */
	workspaceRoot?: string
	/** 显式传入的实验 id（会话恢复时来自 initialState）；优先级最高 */
	experimentId?: string | null
	/** 显式模式（测试/迁移用） */
	mode?: SessionMode | null
	/** 注入的元数据读取器（测试用） */
	taskReader?: (cwd: string) => ExperimentTaskFile | null
	/** 注入的活动会话读取器（测试用；缺省读工作区会话文件） */
	sessionReader?: (workspaceRoot: string) => ExperimentSession | null
}

/** cwd 若在 `<root>/experiments/<id>/...` 内，返回该实验目录；否则 null */
function experimentDirContaining(cwd: string, id: string): string | null {
	if (!cwd || !id) return null
	let dir = path.resolve(cwd)
	for (;;) {
		const parent = path.dirname(dir)
		if (parent === dir) return null
		if (path.basename(dir) === id && path.basename(parent) === EXPERIMENT_ROOT) {
			return dir
		}
		dir = parent
	}
}

/**
 * 解析当前会话上下文。
 *
 * 判定顺序（高 → 低）：
 *   1. 显式 `mode`
 *   2. 显式 `experimentId`
 *   3. `cwd` 路径里有 `experiments/<id>/`
 *   4. `.teaching/task.json` 里写了 `assignmentId`
 *   5. `<workspaceRoot>/.cline-logs/active-experiment.json`（Task2：开始实验后的全局绑定）
 *   6. 都不满足 → `free`
 *
 * 为什么第 5 步必须存在：聊天任务 cwd 恒为工作区根（controller 用 getPrimaryRoot 建 Task），
 * 只靠路径/task.json 永远判不出实验模式，日志与运行痕迹会全部落空。
 */
export function resolveSessionContext(input: ResolveSessionInput): SessionContext {
	const taskReader = input.taskReader ?? readExperimentTask
	const sessionReader = input.sessionReader ?? readActiveExperiment
	const cwd = input.cwd ?? ""
	const workspaceRoot = (input.workspaceRoot ?? cwd).trim()
	const explicitId = (input.experimentId ?? "").trim()
	const byPath = detectExperimentId(cwd)
	const byTaskFile = taskReader(cwd)?.assignmentId?.trim()
	const readSession = (): ExperimentSession | null => {
		if (!workspaceRoot) return null
		try {
			return sessionReader(workspaceRoot)
		} catch {
			// 会话文件读挂（盘满/权限/实现抛错）→ 当作没有会话，降级 free，不阻断聊天
			return null
		}
	}

	if (input.mode === "experiment") {
		const id = explicitId || byPath || byTaskFile || readSession()?.assignmentId
		return buildContext("experiment", id || undefined, cwd, workspaceRoot)
	}
	if (input.mode === "free") {
		return buildContext("free", undefined, cwd, workspaceRoot)
	}

	if (explicitId) return buildContext("experiment", explicitId, cwd, workspaceRoot)
	if (byPath) return buildContext("experiment", byPath, cwd, workspaceRoot)
	if (byTaskFile) return buildContext("experiment", byTaskFile, cwd, workspaceRoot)

	const bySession = readSession()?.assignmentId
	if (bySession) return buildContext("experiment", bySession, cwd, workspaceRoot)

	return buildContext("free", undefined, cwd, workspaceRoot)
}

function buildContext(
	mode: SessionMode,
	experimentId: string | undefined,
	cwd: string,
	workspaceRoot: string,
): SessionContext {
	const root = workspaceRoot || cwd
	return {
		mode,
		experimentId,
		// 自由模式的 logRoot 只用于"定位"，不写日志（logPersistEnabled 已是 false）
		logRoot:
			mode === "experiment" && experimentId
				? experimentDirContaining(cwd, experimentId) ?? experimentLogRoot(root, experimentId)
				: cwd,
		ladderLimit: DEMAND_LADDER[mode],
	}
}

/** 行为日志是否落盘：**只有实验模式写**（自由模式明确不记录，见需求②） */
export function logPersistEnabled(ctx: SessionContext): boolean {
	return ctx.mode === "experiment"
}

/** 干预是否启用：只有实验模式（自由模式下不做任何打断） */
export function interventionEnabled(ctx: SessionContext): boolean {
	return ctx.mode === "experiment"
}

/** 教材检索是否启用：两种模式都为 true（自由模式也要按资料引导式回答） */
export function wikiEnabled(_ctx: SessionContext): boolean {
	return true
}

/** 索要完整实现的放行阶梯 */
export function ladderLimit(ctx: SessionContext): number {
	return ctx.ladderLimit
}

/** 面板/日志里显示用的一行说明 */
export function describeSessionMode(ctx: SessionContext): string {
	return ctx.mode === "experiment"
		? `实验任务模式（任务 ${ctx.experimentId ?? "未知"}，第 ${ctx.ladderLimit} 次索要起给伪代码）`
		: "自由问答模式（不记录行为日志、不干预，第 3 次索要可给完整实现）"
}

// ---------------------------------------------------------------------------
// P1-6：索要完整实现的行为阶梯
// ---------------------------------------------------------------------------

/** 计数上限：防止长会话把次数刷成"永远放行"，第 10 次后稳定在 10 */
export const DEMAND_COUNT_CAP = 10

/** 计数落盘文件名（相对任务目录；Task 侧用 ensureTaskDirectoryExists(taskId) 定位） */
export const DEMAND_COUNTER_FILE = "teaching-demand.json"

export interface PersistedDemandCounter {
	count: number
	mode: SessionMode
	updatedAt?: string
}

export type DemandBumpAction = "counted" | "reset" | "none"

export interface DemandBumpResult {
	/** counted=本消息被计为一次明确索要；reset=学生自己写出了完整实现（self_code）；none=普通消息 */
	action: DemandBumpAction
	/** 变更后的连续次数 */
	count: number
}

function clampDemandCount(count: number): number {
	if (!Number.isFinite(count)) return 0
	return Math.min(DEMAND_COUNT_CAP, Math.max(0, Math.floor(count)))
}

/**
 * 处理一条学生消息对索要计数的影响（P1-6）。
 *
 * 规则（为什么这样定）：
 * - 只有「明确索要完整实现」才计数：复用 demandDetect.isCompleteImplDemand，避免两套关键词表漂移；
 * - 一次消息里多次索要只 +1：否则学生复制三段「给我完整代码」就能秒过阶梯；
 * - 学生自己贴出/写出了完整实现（self_code 信号）→ 计数清零：他已经自己解决了，阶梯应重新开始；
 * - 非索要、非 self_code 的普通消息 → 计数不变（不重置，否则随便插一句「为什么」就清零）。
 */
export function bumpDemandCounter(ctx: SessionContext, message: string | null | undefined): DemandBumpResult {
	const text = (message ?? "").trim()
	const current = clampDemandCount(ctx.demandCount ?? 0)
	if (!text) {
		return { action: "none", count: current }
	}

	if (isCompleteImplDemand(text)) {
		const next = clampDemandCount(current + 1)
		ctx.demandCount = next
		return { action: "counted", count: next }
	}

	// 学生自己写出了/贴出了完整实现（self_code 信号）→ 重新开始计阶梯。
	if (detectFullImplementation(text).detected) {
		ctx.demandCount = 0
		return { action: "reset", count: 0 }
	}

	return { action: "none", count: current }
}

/** 是否到达自由模式放行阶梯（第 3 次明确索要）；实验模式永远 false（只放行伪代码） */
export function shouldReleaseFullCode(ctx: SessionContext): boolean {
	return ctx.mode === "free" && clampDemandCount(ctx.demandCount ?? 0) >= DEMAND_LADDER.free
}

/** 是否到达实验模式伪代码阶梯（第 4 次明确索要）；自由模式 false */
export function shouldOfferPseudo(ctx: SessionContext): boolean {
	return ctx.mode === "experiment" && clampDemandCount(ctx.demandCount ?? 0) >= DEMAND_LADDER.experiment
}

/**
 * 是否允许运行干预（打断/注入提示）。
 *
 * 与 interventionEnabled 同义，但语义更贴近调用点（"这次请求要不要走干预"）；
 * 集中在这里是为了让 Task 侧只有一处判定，模式规则变化时不用全文件搜。
 */
export function shouldRunIntervention(ctx: SessionContext): boolean {
	return interventionEnabled(ctx)
}

/** 重置索要计数（切模式 / 新任务 / 手动清理时调用） */
export function resetDemandCounter(ctx: SessionContext): void {
	ctx.demandCount = 0
}

/** 把持久化读到的次数贴到上下文（不改 mode/ladder） */
export function attachDemandCount(ctx: SessionContext, count: number): SessionContext {
	return { ...ctx, demandCount: clampDemandCount(count) }
}

/**
 * 切换模式并重置计数。
 *
 * 为什么切模式必须清零：free 的阶梯是 3、experiment 是 4，沿用旧计数会让实验任务
 * 一进来就接近伪代码放行线（错账）；而且两种模式的日志/干预策略完全不同，计数语义也不同。
 */
export function switchSessionMode(ctx: SessionContext, nextMode: SessionMode): SessionContext {
	const experimentId =
		nextMode === "experiment" ? ctx.experimentId || detectExperimentId(ctx.logRoot ?? "") || undefined : undefined
	return {
		mode: nextMode,
		experimentId,
		logRoot: ctx.logRoot,
		ladderLimit: DEMAND_LADDER[nextMode],
		demandCount: 0,
	}
}

/**
 * 读取任务目录下的索要计数。
 *
 * 边界（都不抛）：文件缺失 / JSON 损坏 / mode 不匹配 → 0。
 * mode 不匹配视为「切过模式」，必须清零（见 switchSessionMode 的理由）。
 */
export function loadDemandCounter(taskDir: string, mode: SessionMode): number {
	if (!taskDir) return 0
	try {
		const file = path.join(taskDir, DEMAND_COUNTER_FILE)
		if (!fs.existsSync(file)) return 0
		const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedDemandCounter
		if (!parsed || typeof parsed !== "object") return 0
		if (parsed.mode !== mode) return 0
		return clampDemandCount(parsed.count)
	} catch {
		return 0
	}
}

/**
 * 保存索要计数到任务目录（P1-6 持久化）。
 *
 * 为什么落在任务目录而不是 workspaceState：
 * - 需求要求「恢复会话不重置、新 taskId 清零」——按 taskId 分目录天然满足；
 * - workspaceState 的 key 注册表在 src/shared/storage/state-keys.ts（本任务写入作用域之外），
 *   新增 key 需要越界修改，因此用任务目录内的小 JSON 文件作为最小落盘方案。
 * 失败不抛：计数只是体验优化，磁盘问题不该让对话中断。
 */
export function saveDemandCounter(taskDir: string, mode: SessionMode, count: number): void {
	if (!taskDir) return
	try {
		fs.mkdirSync(taskDir, { recursive: true })
		const payload: PersistedDemandCounter = {
			count: clampDemandCount(count),
			mode,
			updatedAt: new Date().toISOString(),
		}
		fs.writeFileSync(path.join(taskDir, DEMAND_COUNTER_FILE), JSON.stringify(payload), "utf8")
	} catch {
		// 静默降级：内存里的计数仍然有效
	}
}
