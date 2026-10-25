/**
 * 学生交互日志持久化服务
 * Student Interaction Log Persistence Service
 */

import fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import type { StudentInteractionLog } from "./types"

/**
 * 日志文件配置
 */
const LOG_DIR_NAME = ".cline-logs"
const LOG_FILE_NAME = "student_interactions.log"

/**
 * 持久化上下文（P1-1）：把模式与实验 id 盖到每条记录上，并据此决定是否落盘。
 *
 * 门控放在持久化器内部而不是各个调用点：调用点有 7 处以上（学生消息、助手回合、
 * 工具调用、运行痕迹、干预结构事件…），逐处判断必然漏掉一两个，而"自由模式仍在记日志"
 * 是需求明确禁止的。
 */
export interface LogPersistContext {
	mode: "free" | "experiment"
	experimentId?: string
}

/**
 * StudentLogPersister - 学生日志持久化服务
 */
export class StudentLogPersister {
	private readonly cwd: string
	/**
	 * 实际落盘根（Task3）。
	 *
	 * 实验模式下是 `experiments/<id>/`，自由模式/旧调用方缺省回退 cwd。
	 * 用可变字段而不是 readonly：同一个聊天任务里点「开始实验」后要能立刻切过去，
	 * 不必等下一个任务。
	 */
	private logRoot?: string
	private turnIndexMap: Map<string, number> = new Map()
	private enabled = true
	private context: LogPersistContext | null = null

	constructor(cwd: string, logRoot?: string) {
		this.cwd = cwd
		this.logRoot = logRoot?.trim() || undefined
	}

	/** 当前日志落盘根（实验目录或 cwd） */
	public getLogRoot(): string {
		return this.logRoot ?? this.cwd
	}

	/** 会话模式变化时切换落盘根（同一任务内开始/结束实验均会调用） */
	public setLogRoot(logRoot: string): void {
		this.logRoot = logRoot?.trim() || undefined
	}

	/** 是否落盘（自由模式为 false） */
	public setEnabled(enabled: boolean): void {
		this.enabled = enabled
	}

	public isEnabled(): boolean {
		return this.enabled
	}

	/** 设置模式上下文；为 null 表示不盖章（测试旧行为用） */
	public setContext(context: LogPersistContext | null): void {
		this.context = context
	}

	/** 把模式字段盖到记录上（不改动调用方传入的对象） */
	private decorate(log: StudentInteractionLog): StudentInteractionLog {
		if (!this.context) {
			return log
		}
		const stamped: StudentInteractionLog = { ...log, mode: this.context.mode }
		if (this.context.experimentId) {
			stamped.experimentId = this.context.experimentId
		}
		return stamped
	}

	/**
	 * 获取日志目录路径
	 */
	public getLogDir(): string {
		return path.join(this.getLogRoot(), LOG_DIR_NAME)
	}

	/**
	 * 获取日志文件路径
	 */
	public getLogPath(): string {
		return path.join(this.getLogDir(), LOG_FILE_NAME)
	}

	/**
	 * 获取并递增任务的轮次索引
	 */
	public getNextTurnIndex(taskId: string): number {
		const current = this.turnIndexMap.get(taskId) ?? 0
		this.turnIndexMap.set(taskId, current + 1)
		return current
	}

	/**
	 * 重置任务的轮次索引
	 */
	public resetTurnIndex(taskId: string): void {
		this.turnIndexMap.set(taskId, 0)
	}

	/**
	 * 确保日志目录存在
	 */
	private async ensureLogDirExists(): Promise<void> {
		await fs.mkdir(this.getLogDir(), { recursive: true })
	}

	/**
	 * 持久化单条日志
	 * @param log 学生交互日志对象
	 */
	public async persist(log: StudentInteractionLog): Promise<void> {
		if (!this.enabled) {
			return
		}
		try {
			await this.ensureLogDirExists()
			const logLine = JSON.stringify(this.decorate(log)) + "\n"
			await fs.appendFile(this.getLogPath(), logLine, "utf8")
		} catch (error) {
			Logger.error("Failed to persist student interaction log", error as Error)
		}
	}

	/**
	 * 批量持久化日志
	 * @param logs 日志数组
	 */
	public async persistBatch(logs: StudentInteractionLog[]): Promise<void> {
		if (logs.length === 0 || !this.enabled) {
			return
		}

		try {
			await this.ensureLogDirExists()
			const logLines = logs.map((log) => JSON.stringify(this.decorate(log))).join("\n") + "\n"
			await fs.appendFile(this.getLogPath(), logLines, "utf8")
		} catch (error) {
			Logger.error("Failed to persist student interaction logs batch", error as Error)
		}
	}

	/**
	 * 读取所有日志
	 * @returns 日志数组
	 */
	public async readAll(): Promise<StudentInteractionLog[]> {
		try {
			const content = await fs.readFile(this.getLogPath(), "utf8")
			const lines = content.trim().split("\n").filter(Boolean)
			return lines.map((line) => JSON.parse(line) as StudentInteractionLog)
		} catch (error) {
			// 文件不存在时返回空数组
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return []
			}
			Logger.error("Failed to read student interaction logs", error as Error)
			return []
		}
	}

	/**
	 * 检查日志文件是否存在
	 */
	public async exists(): Promise<boolean> {
		try {
			await fs.access(this.getLogPath())
			return true
		} catch {
			return false
		}
	}

	/**
	 * 获取日志文件统计信息
	 */
	public async getStats(): Promise<{ size: number; lineCount: number } | null> {
		try {
			const stat = await fs.stat(this.getLogPath())
			const content = await fs.readFile(this.getLogPath(), "utf8")
			const lineCount = content.trim().split("\n").filter(Boolean).length

			return {
				size: stat.size,
				lineCount,
			}
		} catch {
			return null
		}
	}
}
