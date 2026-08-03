/**
 * =============================================================================
 *  LLMWikiService — 进度感知 RAG 服务（v1.3 增量）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 1. 维护学生当前学习周数（currentWeek），根据周数渐进式拉取 Wiki 资料
 * 2. 提供 buildSystemPrompt(userQuery) — 拼装含认知边界约束的 System Prompt
 * 3. 提供 answerWithTools(userQuery, llmCaller) — karpathy 式工具调用答疑（可选开关）
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
 *   - 工具调用答疑开关在 VS Code 配置 clineTeaching.llmEnableTools
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

/** OpenAI 兼容 ChatCompletion 请求消息 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  /** tool_calls / tool_call_id 仅在 karpathy 式工具调用时使用 */
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  name?: string
}

/** LLM 调用方注入的回调（解耦 SDK） */
export type LLMCaller = (messages: ChatMessage[], tools?: ToolDef[]) => Promise<{
  content: string
  tool_calls?: ChatMessage["tool_calls"]
}>

/** OpenAI 风格工具定义 */
export interface ToolDef {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
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
//  常量
// ============================================================================

/** 单 chunk 截断字符数（约 1500 token） */
const CHUNK_TRUNCATE_CHARS = 4000

/** System Prompt 拼接后总长上限 */
const TOTAL_CONTEXT_CHARS = 16_000

/** 工具调用最大次数（v1.3 风险章节硬上限） */
const MAX_TOOL_ROUNDS = 5

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
   * 返回的章节缓存到 _textbookChapters，供 buildSystemPrompt 合并。
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

  /**
   * 拼装含认知边界约束的 System Prompt（v1.3 核心方法 8.1）。
   * 借鉴 karpathy "Markdown chunk 作 Primary Context" 思路。
   */
  public buildSystemPrompt(userQuery: string): string {
    const week = this._currentWeek
    const allChunks: WikiChunk[] = []
    for (const arr of this._wikiCache.values()) allChunks.push(...arr)

    // 过滤：仅 applicable_week <= week
    const visible = allChunks
      .filter((c) => c.applicable_week <= week)
      .sort((a, b) => a.applicable_week - b.applicable_week || a.id.localeCompare(b.id))

    // 拼装 wiki 上下文
    const ctx = this._buildWikiContext(visible)

    // 【v2.0】拼装教材章节上下文（追加到 Primary Context 之后）
    const tbCtx = this._buildTextbookContext()

    return [
      `# 角色`,
      `你是一名严格的 Python 编程教师，正在为第 ${week} 周的学生答疑。`,
      ``,
      `# 认知边界约束（不可违反）`,
      `1. 你只能引用第 1 ~ 第 ${week} 周已被教师发布的资料作为答疑依据。`,
      `2. 严禁使用超出当前周数的高级语法、设计模式或高级库函数（如装饰器、async/await、推导式嵌套等需在更高周数才引入）。`,
      `3. 若学生提问涉及超纲内容，必须明确告知"该知识点将在第 Y 周讲解"，并提供入门指引。`,
      ``,
      `# 优先参考知识（Primary Context）`,
      ctx || `（当前周数暂无 Wiki 资料，请基于通用 Python 知识答疑）`,
      tbCtx,
      ``,
      `# 学生提问`,
      userQuery,
    ].join("\n")
  }

  /**
   * 【v2.0】拼装教材章节上下文。
   * 单章节截断 2000 字（防单章占用过大 token），总字符上限复用 TOTAL_CONTEXT_CHARS。
   */
  private _buildTextbookContext(): string {
    if (this._textbookChapters.length === 0) return ""

    const blocks: string[] = []
    let totalChars = 0
    const CHAPTER_TRUNCATE = 2000

    for (const ch of this._textbookChapters) {
      const ocrNote = ch.ocr_used ? "\n\n> ⚠ 本章由 OCR 识别，可能含噪" : ""
      const block = `## [教材 第 ${ch.applicable_week} 周] ${ch.title} (${ch.chapter_index + 1}/${ch.total_chapters})\n\n${truncate(ch.content, CHAPTER_TRUNCATE)}${ocrNote}`
      if (totalChars + block.length > TOTAL_CONTEXT_CHARS) {
        blocks.push(`> （后续教材章节已省略，避免 token 超限）`)
        break
      }
      blocks.push(block)
      totalChars += block.length
    }

    return "\n\n---\n\n# 教材章节（v2.0）\n\n" + blocks.join("\n\n---\n\n")
  }

  /**
   * karpathy 式工具调用答疑（v1.3 决策 8.C：默认关闭，开关在 clineTeaching.llmEnableTools）
   * 工具集：grep_wiki / read_chunk / list_weeks
   */
  public async answerWithTools(userQuery: string, llmCaller: LLMCaller): Promise<string> {
    const enableTools = this._isToolsEnabled()
    if (!enableTools) {
      // 开关关闭 → 退化为单轮 buildSystemPrompt
      Logger.log("[LLMWikiService] 工具调用开关关闭，使用 buildSystemPrompt")
      return this.buildSystemPrompt(userQuery)
    }

    Logger.log("[LLMWikiService] 工具调用模式启动")
    const tools = this._registerTools()
    const messages: ChatMessage[] = [
      { role: "system", content: this._buildToolsSystemPrompt() },
      { role: "user", content: userQuery },
    ]

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await llmCaller(messages, tools)
      if (!resp.tool_calls || resp.tool_calls.length === 0) {
        // LLM 已收敛
        return resp.content
      }

      // 把 assistant 消息压回
      messages.push({ role: "assistant", content: resp.content, tool_calls: resp.tool_calls })

      // 并行执行所有工具调用（v1.3 风险：时延优化）
      const toolResults = await Promise.all(
        resp.tool_calls.map(async (tc) => {
          const result = await this._executeToolCall(tc.function.name, tc.function.arguments)
          return {
            tool_call_id: tc.id,
            content: result,
          }
        }),
      )
      // 把工具结果追加
      for (const r of toolResults) {
        messages.push({ role: "tool" as const, content: r.content, tool_call_id: r.tool_call_id })
      }
    }

    // 超过 MAX_TOOL_ROUNDS：兜底直接给 prompt
    Logger.warn(`[LLMWikiService] 工具调用超过 ${MAX_TOOL_ROUNDS} 轮，强制收敛`)
    return this.buildSystemPrompt(userQuery)
  }

  // ============================================================================
  //  内部：wiki 上下文拼装
  // ============================================================================

  private _buildWikiContext(chunks: WikiChunk[]): string {
    if (chunks.length === 0) return ""

    const blocks: string[] = []
    let totalChars = 0

    for (const c of chunks) {
      const block = `## [第 ${c.applicable_week} 周] ${c.title}\n\n${truncate(c.content, CHUNK_TRUNCATE_CHARS)}`
      if (totalChars + block.length > TOTAL_CONTEXT_CHARS) {
        blocks.push(`> （后续 chunk 已省略，避免 token 超限）`)
        break
      }
      blocks.push(block)
      totalChars += block.length
    }

    return blocks.join("\n\n---\n\n")
  }

  // ============================================================================
  //  内部：工具调用协议
  // ============================================================================

  private _isToolsEnabled(): boolean {
    return Boolean(
      vscode.workspace.getConfiguration("clineTeaching").get<boolean>("llmEnableTools"),
    )
  }

  private _buildToolsSystemPrompt(): string {
    const week = this._currentWeek
    return [
      `# 角色`,
      `你是一名严格的 Python 编程教师，正在为第 ${week} 周的学生答疑。`,
      ``,
      `# 工具使用规则`,
      `1. 你可以调用三个工具：grep_wiki / read_chunk / list_weeks`,
      `2. 简单问题直接回答；复杂/跨周/对比问题才调用工具`,
      `3. 单次最多调用 ${MAX_TOOL_ROUNDS} 轮工具，请尽快收敛`,
      `4. 严禁使用超出第 ${week} 周的高级语法（认知边界）`,
    ].join("\n")
  }

  private _registerTools(): ToolDef[] {
    return [
      {
        type: "function",
        function: {
          name: "grep_wiki",
          description: "在 Wiki 资料中按关键词搜索匹配的 chunk 片段",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "搜索关键词" },
              max_week: { type: "number", description: "搜索的最大周数（默认当前周）" },
            },
            required: ["pattern"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "read_chunk",
          description: "读取指定 chunk 的完整 Markdown 内容",
          parameters: {
            type: "object",
            properties: { chunkId: { type: "string", description: "chunk 的 ID" } },
            required: ["chunkId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "list_weeks",
          description: "列出当前已加载的所有周数与 chunk 数",
          parameters: { type: "object", properties: {} },
        },
      },
    ]
  }

  private async _executeToolCall(name: string, argsJson: string): Promise<string> {
    try {
      const args = JSON.parse(argsJson) as Record<string, unknown>

      if (name === "grep_wiki") {
        const pattern = String(args["pattern"] ?? "")
        const maxWeek = Number(args["max_week"] ?? this._currentWeek)
        const matches: Array<{ id: string; title: string; snippet: string; week: number }> = []
        for (const [baseId, chunks] of this._wikiCache.entries()) {
          for (const c of chunks) {
            if (c.applicable_week > maxWeek) continue
            if (c.content.includes(pattern) || c.title.includes(pattern)) {
              matches.push({
                id: c.id,
                title: c.title,
                snippet: c.content.slice(0, 200),
                week: c.applicable_week,
              })
            }
          }
        }
        return JSON.stringify({ count: matches.length, matches: matches.slice(0, 10) })
      }

      if (name === "read_chunk") {
        const chunkId = String(args["chunkId"] ?? "")
        for (const chunks of this._wikiCache.values()) {
          const hit = chunks.find((c) => c.id === chunkId || c.id.includes(`__chunk`) === false)
          if (hit) {
            return JSON.stringify({
              id: hit.id,
              title: hit.title,
              content: hit.content,
              applicable_week: hit.applicable_week,
            })
          }
        }
        return JSON.stringify({ error: `chunk ${chunkId} not found` })
      }

      if (name === "list_weeks") {
        const summary = new Map<number, number>()
        for (const chunks of this._wikiCache.values()) {
          for (const c of chunks) {
            summary.set(c.applicable_week, (summary.get(c.applicable_week) ?? 0) + 1)
          }
        }
        const list = Array.from(summary.entries()).map(([week, count]) => ({ week, count }))
        return JSON.stringify({ weeks: list })
      }

      return JSON.stringify({ error: `unknown tool: ${name}` })
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
    }
  }
}

// ============================================================================
//  工具函数
// ============================================================================

function clampWeek(w: number): number {
  if (Number.isNaN(w) || w < 1) return 1
  if (w > 18) return 18
  return Math.floor(w)
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + "\n\n> ...[已截断]"
}