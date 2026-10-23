/**
 * 实验子工作区（P1-3）
 *
 * 「开始实验」= 在工作区里给这个任务开一个**独立目录**，学生后面所有代码、日志、
 * 附件都在里面，而不是像旧版那样把 `${assignmentId}_experiment.py` 直接丢到工作区根：
 *
 *   experiments/<assignmentId>/
 *     ├─ <模板文件>            （main.py / Main.java，按 language 决定扩展名）
 *     ├─ GUIDE.md               （实验指导，由 P1-4 生成；这里只保证占位文件存在）
 *     ├─ attachments/           （下载的附件放这里）
 *     ├─ .cline-logs/student_interactions.log
 *     └─ .teaching/task.json    （assignmentId / mode / startedAt）
 *
 * 幂等规则（重要）：二次进入**绝不覆盖学生已改的模板**，只补缺失文件 —— 学生点两次
 * 「开始实验」不该把写了半小时的代码冲掉。
 */
import fs from "fs"
import * as path from "path"

export const EXPERIMENT_ROOT = "experiments"

export const EXPERIMENT_TASK_DIR = ".teaching"
export const EXPERIMENT_TASK_FILE = path.join(EXPERIMENT_TASK_DIR, "task.json")
export const EXPERIMENT_LOG_DIR = ".cline-logs"
export const EXPERIMENT_LOG_FILE = "student_interactions.log"
export const EXPERIMENT_GUIDE_FILE = "GUIDE.md"
export const EXPERIMENT_ATTACHMENT_DIR = "attachments"

/** 语言 → 模板文件名（未知语言回落 python） */
const TEMPLATE_NAME: Record<string, string> = {
	python: "main.py",
	java: "Main.java",
	cpp: "main.cpp",
	c: "main.c",
	javascript: "main.js",
	typescript: "main.ts",
}

/** 目录名清洗：只留字母数字与常见中文标点，去掉分隔符与 `..` */
export function sanitizeSegment(raw: string, fallback = "assignment"): string {
	const cleaned = (raw ?? "")
		.trim()
		.replace(/[\\/:*?"<>|]/g, "_")
		.replace(/\.{2,}/g, ".")
		.replace(/\s+/g, "_")
		.replace(/^[._]+|[._]+$/g, "")
	return cleaned || fallback
}

/** 任务的实验目录（绝对路径） */
export function experimentDirFor(workspaceRoot: string, assignmentId: string): string {
	return path.join(workspaceRoot, EXPERIMENT_ROOT, sanitizeSegment(assignmentId))
}

/** 校验 `child` 确实在 `parent` 之内（防 `../` 越界） */
export function isInside(parent: string, child: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child))
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

export interface TemplateSpec {
	language?: string
	/** 任务自带的模板代码（可能为空） */
	templateCode?: string
	/** 无模板时代码里的 TODO 说明 */
	assignmentTitle?: string
}

export function templateFileNameFor(language?: string): string {
	return TEMPLATE_NAME[(language ?? "python").toLowerCase()] ?? TEMPLATE_NAME.python
}

/** 模板内容：有模板用模板；没有就按语言生成带 TODO 的空骨架 */
export function buildTemplateContent(spec: TemplateSpec): string {
	const code = (spec.templateCode ?? "").trim()
	if (code) {
		return `${code}\n`
	}
	const title = spec.assignmentTitle ? `（${spec.assignmentTitle}）` : ""
	switch ((spec.language ?? "python").toLowerCase()) {
		case "java":
			return `// TODO ${title} 在此实现实验要求\npublic class Main {\n\tpublic static void main(String[] args) {\n\t\t// TODO\n\t}\n}\n`
		case "cpp":
			return `// TODO ${title} 在此实现实验要求\n#include <iostream>\nusing namespace std;\n\nint main() {\n\t// TODO\n\treturn 0;\n}\n`
		case "c":
			return `/* TODO ${title} 在此实现实验要求 */\n#include <stdio.h>\n\nint main(void) {\n\t/* TODO */\n\treturn 0;\n}\n`
		case "javascript":
			return `// TODO ${title} 在此实现实验要求\nfunction main() {\n\t// TODO\n}\n\nmain()\n`
		case "typescript":
			return `// TODO ${title} 在此实现实验要求\nfunction main(): void {\n\t// TODO\n}\n\nmain()\n`
		default:
			return `# TODO ${title} 在此实现实验要求\n\ndef main() -> None:\n\tpass\n\n\nif __name__ == "__main__":\n\tmain()\n`
	}
}

export interface EnsureExperimentInput {
	workspaceRoot: string
	assignmentId: string
	language?: string
	templateCode?: string
	assignmentTitle?: string
	/** 已生成的实验指导（P1-4）；缺省时写占位说明 */
	guideText?: string
}

export interface EnsureExperimentResult {
	ok: boolean
	dir: string
	created: boolean
	/** 本次新建/补齐的文件（绝对路径） */
	files: string[]
	/** 模板文件绝对路径 */
	templatePath: string
	error?: string
}

export const GUIDE_PLACEHOLDER = `# 实验指导\n\n> 本文件由系统生成。如果这里只有这段占位文字，说明实验指导尚未生成（可稍后重新开始实验，或直接在对话里向助手提问）。\n`

/** 实验附件读取上限（防止把大附件整个塞进 6000 字符预算） */
export const MAX_ATTACHMENT_FILES = 8
export const MAX_ATTACHMENT_CHARS_PER_FILE = 2000
/** 模板代码读取上限 */
export const MAX_TEMPLATE_CHARS = 6000

/**
 * 建/补实验目录（幂等）。
 *
 * 只 **mkdir + 补缺失文件**：已存在的文件一律跳过，学生改动不会被冲掉。
 */
export function ensureExperimentWorkspace(input: EnsureExperimentInput): EnsureExperimentResult {
	const dir = experimentDirFor(input.workspaceRoot, input.assignmentId)
	const templateName = templateFileNameFor(input.language)
	const templatePath = path.join(dir, templateName)
	const files: string[] = []
	let created = false

	try {
		if (!isInside(path.join(input.workspaceRoot, EXPERIMENT_ROOT), dir)) {
			return { ok: false, dir, created: false, files, templatePath, error: "任务目录越界，已拒绝创建" }
		}
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true })
			created = true
		} else {
			const stat = fs.statSync(dir)
			if (!stat.isDirectory()) {
				return { ok: false, dir, created: false, files, templatePath, error: "同名路径已存在且不是目录" }
			}
		}

		const writeIfMissing = (target: string, content: string) => {
			if (fs.existsSync(target)) {
				return
			}
			fs.mkdirSync(path.dirname(target), { recursive: true })
			fs.writeFileSync(target, content, "utf8")
			files.push(target)
		}

		writeIfMissing(templatePath, buildTemplateContent(input))
		writeIfMissing(path.join(dir, EXPERIMENT_GUIDE_FILE), input.guideText?.trim() || GUIDE_PLACEHOLDER)
		fs.mkdirSync(path.join(dir, EXPERIMENT_ATTACHMENT_DIR), { recursive: true })
		fs.mkdirSync(path.join(dir, EXPERIMENT_LOG_DIR), { recursive: true })
		writeIfMissing(path.join(dir, EXPERIMENT_LOG_DIR, EXPERIMENT_LOG_FILE), "")
		writeIfMissing(
			path.join(dir, EXPERIMENT_TASK_FILE),
			`${JSON.stringify(
				{
					assignmentId: input.assignmentId,
					mode: "experiment",
					startedAt: new Date().toISOString(),
					language: (input.language ?? "python").toLowerCase(),
					template: templateName,
				},
				null,
				2,
			)}\n`,
		)

		return { ok: true, dir, created, files, templatePath }
	} catch (e) {
		return {
			ok: false,
			dir,
			created,
			files,
			templatePath,
			error: e instanceof Error ? e.message : String(e),
		}
	}
}

/**
 * 读取实验指导正文（GUIDE.md）。
 *
 * 为什么占位文件要返回 null：P1-4 生成失败或尚未生成时 GUIDE.md 里只有占位说明，
 * 把它当指导注入会浪费上下文、还会误导模型（"这里只有这段占位文字"）。
 */
export function readExperimentGuide(dir: string): string | null {
	if (!dir) return null
	try {
		const file = path.join(dir, EXPERIMENT_GUIDE_FILE)
		if (!fs.existsSync(file)) return null
		const text = fs.readFileSync(file, "utf8").trim()
		if (!text) return null
		if (text === GUIDE_PLACEHOLDER.trim() || text.includes("实验指导尚未生成")) {
			return null
		}
		return text
	} catch {
		return null
	}
}

/**
 * 读取当前实验的模板/起始代码。
 *
 * 优先 task.json 里记录的模板文件名；缺失时按语言模板名逐个探测（兼容手工建的目录）。
 * 学生可能已修改模板——这里只读，不判断"是否改过"。
 */
export function readExperimentTemplate(dir: string): string | null {
	if (!dir) return null
	try {
		const taskFile = readExperimentTaskFile(dir)
		const candidates: string[] = []
		if (taskFile?.template) {
			candidates.push(taskFile.template)
		}
		for (const name of Object.values(TEMPLATE_NAME)) {
			if (!candidates.includes(name)) candidates.push(name)
		}
		for (const name of candidates) {
			const file = path.join(dir, name)
			if (!fs.existsSync(file)) continue
			const text = fs.readFileSync(file, "utf8")
			return Array.from(text).slice(0, MAX_TEMPLATE_CHARS).join("")
		}
		return null
	} catch {
		return null
	}
}

export interface ExperimentAttachmentText {
	/** 相对 attachments/ 的文件名 */
	file: string
	text: string
}

function looksBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
	return sample.includes(0)
}

/**
 * 读取实验附件文本（attachments/ 下的文本文件）。
 *
 * 只读、不上传二进制；单文件截断到 MAX_ATTACHMENT_CHARS_PER_FILE，最多 MAX_ATTACHMENT_FILES 个。
 * 由调用方再拼成字符串交给 assembleTeachingContext 统一按 1500 字配额截断。
 */
export function readExperimentAttachments(dir: string): ExperimentAttachmentText[] {
	if (!dir) return []
	const attachmentDir = path.join(dir, EXPERIMENT_ATTACHMENT_DIR)
	try {
		if (!fs.existsSync(attachmentDir)) return []
		const names = fs
			.readdirSync(attachmentDir, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b))
		const result: ExperimentAttachmentText[] = []
		for (const name of names) {
			if (result.length >= MAX_ATTACHMENT_FILES) break
			const file = path.join(attachmentDir, name)
			try {
				const buffer = fs.readFileSync(file)
				if (looksBinary(buffer)) continue
				const text = Array.from(buffer.toString("utf8").trim()).slice(0, MAX_ATTACHMENT_CHARS_PER_FILE).join("")
				if (!text) continue
				result.push({ file: name, text })
			} catch {
				// 单个附件读失败不影响其他附件
			}
		}
		return result
	} catch {
		return []
	}
}

/** 读回任务元数据（面板用它判断「已开始」） */
export function readExperimentTaskFile(dir: string): { assignmentId?: string; startedAt?: string; template?: string } | null {
	try {
		const file = path.join(dir, EXPERIMENT_TASK_FILE)
		if (!fs.existsSync(file)) {
			return null
		}
		return JSON.parse(fs.readFileSync(file, "utf8")) as { assignmentId?: string; startedAt?: string; template?: string }
	} catch {
		return null
	}
}
