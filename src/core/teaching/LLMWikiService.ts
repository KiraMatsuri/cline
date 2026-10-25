/**
 * =============================================================================
 *  LLMWikiService — 课程资料索引与检索可用性服务（v3：去周数）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 1. 拉取**全部已发布**资料与教材章节（不再有「当前学习周」）
 * 2. 提供 buildIndexTitles() / isWikiMcpAvailable() — 生成资料索引与检索可用性
 *
 * 【v3 变更（2026-10）】教学周概念整体移除：
 *   - 删除「当前教学周」状态及其读写方法、周状态文件读写；
 *   - `fetchWiki()` 不再传 `max_week`，索引即「资料库全貌」；
 *   - 检索范围不再随周放宽 —— 一开始就是全部（由 `mcp-wiki-server` 转发、后端按相关度召回）。
 *
 * 【v2.13 变更】不再拼接资料全文注入 system prompt；正文改由本地 stdio MCP server
 *   （search_wiki / read_wiki_chunk / list_wiki_weeks）供模型按需检索。
 *
 * 【IPC 联动】
 *   - Webview → Extension: fetchWiki / saveLLMSettings ...
 *   - Extension → 后端:    GET ${serverUrl}/api/v1/wiki
 *
 * 【配置兼容】
 *   优先读 clineTeaching.serverUrl（旧版 fallback teaching.apiBase）
 * =============================================================================
 */

import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { normalizeServerUrl } from "./serverUrl"
import { buildRecallContext } from "./wikiPrompt"

// ============================================================================
//  类型定义
// ============================================================================

/** Wiki 资料块（与后端 wiki_chunks 表字段对齐） */
export interface WikiChunk {
	id: string
	title: string
	/** Markdown 正文（可能为 LLM 清洗后或原始文本） */
	content: string
	applicable_week: number
	cleaned_by_llm: number // SQLite 0/1
	llm_clean_error?: string | null
	chunk_index: number
	chunk_total: number
	created_at: string
	updated_at: string
	/** 关联附件（含下载链接），前端可展示"📎" */
	attachments?: Array<{
		id: number
		original_name: string
		file_size: number
		mime_type: string
		downloadUrl?: string
	}>
}

/** GET /api/v1/wiki 响应 */
interface WikiListResponse {
	ok: boolean
	count: number
	max_week?: number | null
	data: WikiChunk[]
	/** v3：旧客户端仍可能带 max_week，后端回此标记说明已被忽略 */
	meta?: { week_ignored?: boolean }
}

/**
 * 教材章节（v2.0 增量）
 * 由后端 GET /api/v1/wiki?textbook_id=... 返回
 */
export interface TextbookChapter {
	id: string
	title: string
	content: string
	applicable_week: number
	chapter_index: number
	total_chapters: number
	ocr_used: number
}

// ============================================================================
//  LLMWikiService 单例
// ============================================================================

export class LLMWikiService {
	private static _instance: LLMWikiService | null = null

	public static getInstance(): LLMWikiService {
		if (!LLMWikiService._instance) {
			LLMWikiService._instance = new LLMWikiService()
		}
		return LLMWikiService._instance
	}

	// --------------------------------------------------------------------------
	//  内部状态
	// --------------------------------------------------------------------------

	/** Wiki 资料缓存（按 baseId 分组） */
	private _wikiCache: Map<string, WikiChunk[]> = new Map()

	/** 【v2.0 增量】教材章节缓存 */
	private _textbookChapters: TextbookChapter[] = []

	/** 【v2.0 增量】当前生效教材 ID（来自 clineTeaching.currentTextbookId） */
	private _currentTextbookId: string = ""

	/** 当前生效的 serverUrl（缓存避免每请求读配置） */
	private _serverUrl: string = ""

	/** 【v2.13】wiki MCP server 是否已连接（供注入“检索不可用”状态用） */
	private _wikiMcpAvailable = false

	/** 监听 VS Code 配置变更的 disposable */
	private _configWatcher: vscode.Disposable | null = null

	// ============================================================================
	//  配置同步
	// ============================================================================

	/** 启动配置监听（应在插件 activate 阶段调用） */
	public listenConfigChanges(): void {
		if (this._configWatcher) return
		void this._refreshConfig()
		this._configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
			if (
				e.affectsConfiguration("clineTeaching.serverUrl") ||
				e.affectsConfiguration("clineTeaching.llmEnableTools") ||
				e.affectsConfiguration("clineTeaching.currentTextbookId") ||
				e.affectsConfiguration("teaching.apiBase")
			) {
				void this._refreshConfig()
				Logger.log(`[LLMWikiService] 配置变更已同步: serverUrl=${this._serverUrl}`)
			}
		})
	}

	/** 从 VS Code 配置同步 serverUrl / llmEnableTools */
	private async _refreshConfig(): Promise<void> {
		const ct = vscode.workspace.getConfiguration("clineTeaching")
		const legacy = vscode.workspace.getConfiguration("teaching")

		// serverUrl 优先级：clineTeaching.serverUrl → teaching.apiBase → "http://localhost:4001"
		const newUrl = normalizeServerUrl(ct.get<string>("serverUrl")?.trim() || legacy.get<string>("apiBase")?.trim() || "")

		// 【v2.0】同步 currentTextbookId
		const newTextbookId = ct.get<string>("currentTextbookId")?.trim() ?? ""
		if (newTextbookId !== this._currentTextbookId) {
			this._currentTextbookId = newTextbookId
			this._textbookChapters = [] // 教材切换 → 清章节缓存
		}

		if (newUrl !== this._serverUrl) {
			this._serverUrl = newUrl
			this.invalidateCache() // serverUrl 变更 → 清缓存
		}
	}

	/** 释放订阅 */
	public dispose(): void {
		this._configWatcher?.dispose()
		this._configWatcher = null
		LLMWikiService._instance = null
	}

	// ============================================================================
	//  公共 API
	// ============================================================================

	/** 获取当前生效的 serverUrl */
	public getServerUrl(): string {
		return this._serverUrl
	}

	/** 失效全部缓存（教师删除资料 / 修改 serverUrl 时调用） */
	public invalidateCache(): void {
		this._wikiCache.clear()
		this._textbookChapters = []
	}

	/** 获取当前 wikiCache 中已缓存的总 chunk 数（公开 API 给主对话流程用） */
	public getWikiCacheSize(): number {
		let n = 0
		for (const arr of this._wikiCache.values()) n += arr.length
		return n
	}

	/**
	 * 【v3】生成资料索引（标题列表，去重后按周升序、周内保持服务端顺序），供注入 system prompt 使用。
	 * **只取元数据，不含正文** —— 正文由 MCP 工具按需检索。
	 *
	 * 为什么保留 week 排序而不是打散：索引的用途是让模型知道「资料库里大概有哪些主题」，
	 * 按教材/周的原始组织顺序排列最利于模型判断"这个提问属于哪一块知识"。
	 */
	public buildIndexTitles(): string[] {
		const seen = new Set<string>()
		const entries: Array<{ week: number; title: string }> = []
		const push = (week: number, rawTitle: string): void => {
			const title = normalizeIndexTitle(rawTitle)
			if (!title || seen.has(title)) return
			seen.add(title)
			entries.push({ week, title })
		}

		for (const chunks of this._wikiCache.values()) {
			for (const c of chunks) push(c.applicable_week, c.title)
		}

		// 【v2.13】教材章节并入索引：正文由 MCP 检索 `wiki_chunks`，
		// 若教师尚未 publish-as-wiki，其正文根本不在 `wiki_chunks` 里 ——
		// 此时"索引里连章节目录都没有"会让教材内容对模型完全隐形。只加标题，不注入正文。
		for (const ch of this._textbookChapters) push(ch.applicable_week, ch.title)

		// 稳定排序：按原周次升序（相同时保持来源顺序），让索引呈现教材的组织顺序而不是 Map 的插入顺序
		return entries
			.map((e, i) => ({ ...e, i }))
			.sort((a, b) => a.week - b.week || a.i - b.i)
			.map((e) => e.title)
	}

	/**
	 * 【v2.13】wiki MCP 是否可用（由连接状态决定）。
	 * 不可用时注入“检索不可用”状态声明，而**不**退回全文注入（见 spec §D5）。
	 */
	public isWikiMcpAvailable(): boolean {
		return this._wikiMcpAvailable
	}

	/** 由 WikiMcpRegistrar / McpHub 在探测到连接状态后回写 */
	public setWikiMcpAvailable(available: boolean): void {
		this._wikiMcpAvailable = available
	}

	// ============================================================================
	//  v2.0 增量：教材加载与切换
	// ============================================================================

	/** 获取当前生效教材 ID（空字符串表示未设置） */
	public getCurrentTextbookId(): string {
		return this._currentTextbookId
	}

	/**
	 * 切换教材（写 VS Code 全局配置 + 失效缓存）。
	 * 下次 fetchWiki / loadTextbook 会用新 ID。
	 */
	public async setCurrentTextbook(textbookId: string): Promise<void> {
		const id = textbookId.trim()
		await vscode.workspace.getConfiguration("clineTeaching").update("currentTextbookId", id, vscode.ConfigurationTarget.Global)
		this._currentTextbookId = id
		this.invalidateCache()
	}

	/** 拼 `GET /api/v1/wiki` 的 query（v3：不再有 max_week） */
	private wikiUrl(): string {
		const tbParam = this._currentTextbookId ? `?textbook_id=${encodeURIComponent(this._currentTextbookId)}` : ""
		return `${this._serverUrl}/api/v1/wiki${tbParam}`
	}

	/**
	 * 拉取教材章节（v2.0 / v3 去周数）。
	 * 若 currentTextbookId 为空则跳过；否则请求 GET /api/v1/wiki?textbook_id=...。
	 */
	public async loadTextbook(): Promise<TextbookChapter[]> {
		if (!this._currentTextbookId) return []
		try {
			const resp = await fetch(this.wikiUrl())
			if (!resp.ok) {
				Logger.warn(`[LLMWikiService] 拉取教材章节失败: ${resp.status}`)
				return this._textbookChapters
			}
			const json = (await resp.json()) as { data: WikiChunk[]; textbook_chapters: TextbookChapter[] }
			this._textbookChapters = json.textbook_chapters ?? []
			Logger.log(`[LLMWikiService] 教材章节: ${this._textbookChapters.length} 章 (textbookId=${this._currentTextbookId})`)
			return this._textbookChapters
		} catch (e) {
			Logger.error(`[LLMWikiService] 拉取教材异常:`, e)
			return this._textbookChapters
		}
	}

	/**
	 * 拉取**全部**已发布 Wiki 资料（v3：不再按周渐进）。
	 * 缓存策略：baseId 维度去重，相同 baseId 不重复请求。
	 * 返回全部 chunk（调用方不再需要按周二次过滤）。
	 */
	public async fetchWiki(): Promise<WikiChunk[]> {
		const cached: WikiChunk[] = []
		for (const arr of this._wikiCache.values()) cached.push(...arr)

		try {
			const resp = await fetch(this.wikiUrl())
			if (!resp.ok) {
				Logger.warn(`[LLMWikiService] 拉取 Wiki 失败: ${resp.status}`)
				return cached
			}
			const json = (await resp.json()) as WikiListResponse & { textbook_chapters?: TextbookChapter[] }

			// 【v2.0】更新教材章节缓存
			if (Array.isArray(json.textbook_chapters)) {
				this._textbookChapters = json.textbook_chapters
			}
			const allChunks = json.data ?? []

			// 按 baseId 聚合
			const grouped = new Map<string, WikiChunk[]>()
			for (const c of allChunks) {
				const baseId = c.id.includes("__chunk") ? c.id.split("__chunk")[0] : c.id
				if (!grouped.has(baseId)) grouped.set(baseId, [])
				grouped.get(baseId)!.push(c)
			}

			// 仅替换对应 baseId 的缓存（保留其他 baseId 不动）
			for (const [baseId, chunks] of grouped.entries()) {
				this._wikiCache.set(baseId, chunks)
			}

			Logger.log(
				`[LLMWikiService] 拉取成功: chunks=${allChunks.length}, baseIds=${grouped.size}, textbookChapters=${this._textbookChapters.length}`,
			)
			return allChunks
		} catch (e) {
			Logger.error(`[LLMWikiService] 拉取异常:`, e)
			return cached
		}
	}

	/**
	 * 【v3 · P0-3】按**提问内容**预召回资料片段。
	 *
	 * 为什么需要它（而不是只靠模型自己调 search_wiki）：
	 *   - 学生端默认模型经常"不调工具就先答"，实测多数轮次里检索根本没发生；
	 *   - 周数移除后，"能查到哪些资料"不再由进度决定，**只由问题内容决定**，
	 *     于是这件事可以且应该在扩展侧确定性地做掉。
	 *
	 * 失败/无命中返回 null —— 调用方保持"只注入索引"的原有行为。
	 *
	 * @param userText 最近一条学生提问（内部截断到 300 字，避免长贴代码把 query 撑爆）
	 * @param opts.limit 取前 N 条（默认 3）；`opts.hint` 可拼任务标题提升命中
	 */
	public async recallForQuestion(userText: string, opts: { limit?: number; hint?: string } = {}): Promise<string | null> {
		const serverUrl = this._serverUrl?.trim()
		const text = (userText ?? "").replace(/\s+/g, " ").trim()
		if (!serverUrl || text.length < 2) return null

		const limit = Math.max(1, Math.min(opts.limit ?? 8, 10))
		const query = `${opts.hint ? `${opts.hint} ` : ""}${text}`.slice(0, 300)
		const url = `${serverUrl}/api/v1/wiki/search?q=${encodeURIComponent(query)}&limit=${limit}`

		try {
			const ctrl = new AbortController()
			const timer = setTimeout(() => ctrl.abort(), 3000)
			const resp = await fetch(url, { signal: ctrl.signal })
			clearTimeout(timer)
			if (!resp.ok) {
				Logger.warn(`[LLMWikiService] 预召回失败: ${resp.status}`)
				return null
			}
			const json = (await resp.json()) as {
				data?: Array<{ id?: string; title?: string; content?: string; snippet?: string }>
			}
			// 检索接口回的是 `snippet`（前 200 字摘要），不是 `content` —— 两者都要认，
			// 否则会出现「后端命中 2 条、前端拿到 0 条」的静默失败（预召回直接失效）。
			const items = (json.data ?? [])
				.map((c) => ({
					chunkId: c?.id ?? "",
					title: c?.title ?? "",
					content: (c?.content ?? c?.snippet ?? "").trim(),
				}))
				.filter((c) => c.content.length > 0)
			const block = buildRecallContext(items)
			Logger.log(
				`[LLMWikiService] 预召回: query=${query.slice(0, 40)}… hits=${items.length} injected=${block ? block.length : 0}`,
			)
			return block
		} catch (e) {
			Logger.warn(`[LLMWikiService] 预召回异常:`, e instanceof Error ? e.message : e)
			return null
		}
	}
}

// ============================================================================
//  工具函数
// ============================================================================

/** 索引条目的标题长度上限（部分"标题"其实是整句摘要，不截断会吃光索引预算） */
const MAX_INDEX_TITLE_CHARS = 60

/**
 * 【v2.13】把 chunk 标题规范成"索引项"。
 *
 * 实测必要性（真实数据）：
 *   - 标题来自教材解析，多为**整句话摘要**，直接拼进索引会立刻吃光预算；
 *   - 同一章节被拆成多个 chunk 时，标题只在结尾差一个 ` (1/3)` / ` (2/3)` 后缀，
 *     于是**按原样去重完全失效**，索引里塞满重复项；
 *   - 标题**可能含换行/制表符**，直接拼进索引会把排版冲垮（出现两行粘连）。
 */
function normalizeIndexTitle(raw: string): string {
	const oneLine = raw.replace(/\s+/g, " ").trim()
	const noChunkSuffix = oneLine.replace(/\s*\(\d+\/\d+\)$/, "")
	return noChunkSuffix.length > MAX_INDEX_TITLE_CHARS ? `${noChunkSuffix.slice(0, MAX_INDEX_TITLE_CHARS)}…` : noChunkSuffix
}
