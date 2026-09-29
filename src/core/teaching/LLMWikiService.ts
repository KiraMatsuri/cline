/**
 * =============================================================================
 *  LLMWikiService — 进度感知 RAG 服务（v1.3 增量）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 1. 维护学生当前学习周数（currentWeek），根据周数渐进式拉取 Wiki 资料
 * 2. 提供 buildIndexGroups() / isWikiMcpAvailable() — 生成“周 → 标题”资料索引与检索可用性
 *
 * 【v2.13 变更】不再拼接资料全文注入 system prompt；正文改由本地 stdio MCP server
 *   （search_wiki / read_wiki_chunk / list_wiki_weeks）供模型按需检索。
 *
 * 【IPC 联动】
 *   - Webview → Extension: switchWeek / fetchWiki / saveLLMSettings ...
 *   - Extension → 后端:    GET ${serverUrl}/api/v1/wiki?max_week=N
 *
 * 【配置兼容】
 *   优先读 clineTeaching.serverUrl（旧版 fallback teaching.apiBase）
 *
 * 【v1.3 决策】
 *   - 借鉴 karpathy llm-wiki 的"Markdown chunk 作 Primary Context"思路
 *   - chunk 拆分由 LLM 决定（8.D），上限 ≤5（8.E）
 *   - 资料检索开关在 VS Code 配置 clineTeaching.llmEnableTools
 *
 * =============================================================================
 */

import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

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

/** GET /api/v1/wiki?max_week=N 响应 */
interface WikiListResponse {
  ok: boolean
  count: number
  max_week?: number
  data: WikiChunk[]
}

/**
 * 教材章节（v2.0 增量）
 * 由后端 GET /api/v1/wiki?max_week=N&textbook_id=... 返回
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

  /** 当前周数（从 VS Code 配置同步） */
  private _currentWeek: number = 1

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
    this._refreshConfig()
    this._configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration("clineTeaching.serverUrl") ||
        e.affectsConfiguration("clineTeaching.currentWeek") ||
        e.affectsConfiguration("clineTeaching.llmEnableTools") ||
        e.affectsConfiguration("clineTeaching.currentTextbookId") ||
        e.affectsConfiguration("teaching.apiBase")
      ) {
        this._refreshConfig()
        Logger.log(`[LLMWikiService] 配置变更已同步: week=${this._currentWeek}, serverUrl=${this._serverUrl}`)
      }
    })
  }

  /** 从 VS Code 配置同步 serverUrl / currentWeek / llmEnableTools */
  private _refreshConfig(): void {
    const ct = vscode.workspace.getConfiguration("clineTeaching")
    const legacy = vscode.workspace.getConfiguration("teaching")

    // serverUrl 优先级：clineTeaching.serverUrl → teaching.apiBase → "http://localhost:4001"
    const newUrl =
      ct.get<string>("serverUrl")?.trim() ||
      legacy.get<string>("apiBase")?.trim() ||
      "http://localhost:4001"

    const newWeek = ct.get<number>("currentWeek") ?? 1
    this._currentWeek = clampWeek(newWeek)

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

  /** 获取当前周数（供外部显示） */
  public getCurrentWeek(): number {
    return this._currentWeek
  }

  /** 设置当前周数（同时写 VS Code 配置全局） */
  public async setCurrentWeek(week: number): Promise<void> {
    const w = clampWeek(week)
    await vscode.workspace
      .getConfiguration("clineTeaching")
      .update("currentWeek", w, vscode.ConfigurationTarget.Global)
    this._currentWeek = w
    this.invalidateCache() // 周数变化 → 重新拉取
  }

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
   * 【v2.13】生成资料索引（周 → 标题列表），供注入 system prompt 使用。
   * **只取元数据，不含正文** —— 正文改由 MCP 工具按需检索（见 spec §D6）。
   */
  public buildIndexGroups(): Array<{ week: number; titles: string[] }> {
    const byWeek = new Map<number, string[]>()
    for (const chunks of this._wikiCache.values()) {
      for (const c of chunks) {
        if (c.applicable_week > this._currentWeek) {
          continue
        }
        const title = normalizeIndexTitle(c.title)
        if (!title) {
          continue
        }
        if (!byWeek.has(c.applicable_week)) {
          byWeek.set(c.applicable_week, [])
        }
        const arr = byWeek.get(c.applicable_week)!
        if (!arr.includes(title)) {
          arr.push(title)
        }
      }
    }
    return Array.from(byWeek.entries())
      .map(([week, titles]) => ({ week, titles }))
      .sort((a, b) => a.week - b.week)
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
   * 下次 fetchWikiForWeek / loadTextbookForWeek 会用新 ID。
   */
  public async setCurrentTextbook(textbookId: string): Promise<void> {
    const id = textbookId.trim()
    await vscode.workspace
      .getConfiguration("clineTeaching")
      .update("currentTextbookId", id, vscode.ConfigurationTarget.Global)
    this._currentTextbookId = id
    this.invalidateCache()
  }

  /**
   * 拉取教材章节（v2.0）。
   * 若 currentTextbookId 为空则跳过；否则请求 GET /api/v1/wiki?max_week=N&textbook_id=...。
   * 返回的章节缓存到 _textbookChapters（供教材切换与后续索引/展示使用）。
   */
  public async loadTextbookForWeek(week: number): Promise<TextbookChapter[]> {
    if (!this._currentTextbookId) return []
    const targetWeek = clampWeek(week)
    const url = `${this._serverUrl}/api/v1/wiki?max_week=${targetWeek}&textbook_id=${encodeURIComponent(this._currentTextbookId)}`
    try {
      const resp = await fetch(url)
      if (!resp.ok) {
        Logger.warn(`[LLMWikiService] 拉取教材章节失败: ${resp.status}`)
        return this._textbookChapters
      }
      const json = (await resp.json()) as { data: WikiChunk[]; textbook_chapters: TextbookChapter[] }
      this._textbookChapters = json.textbook_chapters ?? []
      Logger.log(
        `[LLMWikiService] 教材章节: ${this._textbookChapters.length} 章 (textbookId=${this._currentTextbookId})`,
      )
      return this._textbookChapters
    } catch (e) {
      Logger.error(`[LLMWikiService] 拉取教材异常:`, e)
      return this._textbookChapters
    }
  }

  /**
   * 按周数渐进式拉取 Wiki 资料。
   * 缓存策略：baseId 维度去重，相同 baseId 不重复请求。
   *
   * 【v2.0 增量】同时拉取教材章节（若 currentTextbookId 已设置）。
   */
  public async fetchWikiForWeek(week: number): Promise<WikiChunk[]> {
    const targetWeek = clampWeek(week)
    this._currentWeek = targetWeek
    await vscode.workspace
      .getConfiguration("clineTeaching")
      .update("currentWeek", targetWeek, vscode.ConfigurationTarget.Global)

    // 内存缓存中已有的 baseId
    const cached: WikiChunk[] = []
    for (const arr of this._wikiCache.values()) cached.push(...arr)

    // 找出未缓存的 baseId（调用后端 max_week 接口一次拿全）
    // 这里简化：直接 GET /api/v1/wiki?max_week=N 全量拿，缓存里去重
    // 【v2.0】附加 textbook_id 参数（若已设置），后端会 JOIN 返回 textbook_chapters
    const tbParam = this._currentTextbookId
      ? `&textbook_id=${encodeURIComponent(this._currentTextbookId)}`
      : ""
    const url = `${this._serverUrl}/api/v1/wiki?max_week=${targetWeek}${tbParam}`
    try {
      const resp = await fetch(url)
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

      // 返回本周数可见的所有 chunk
      const visible = allChunks.filter((c) => c.applicable_week <= targetWeek)
      Logger.log(
        `[LLMWikiService] 拉取成功: max_week=${targetWeek}, chunks=${visible.length}, baseIds=${grouped.size}`,
      )
      return visible
    } catch (e) {
      Logger.error(`[LLMWikiService] 拉取异常:`, e)
      return cached
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
 * 实测必要性（week=18 真实数据）：
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

function clampWeek(w: number): number {
  if (Number.isNaN(w) || w < 1) return 1
  if (w > 18) return 18
  return Math.floor(w)
}