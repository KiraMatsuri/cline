# 📐 设计文档：Web 教师端 Wiki 管理 × VS Code 插件 LLM-Wiki RAG 全栈联动方案

> **版本**：v1.0  
> **日期**：2026-07-30  
> **作者**：架构组  
> **状态**：⏳ 待审核

---

## 一、背景与目标

在已有的"实验任务 + 学情画像"教学辅助链路之上，新增**知识库 Wiki 资料管理**模块，实现：

1. **教师端**：上传 Markdown 教学资料，按"教学周数 (1~18)"打标签入库。
2. **学生端 (Cline 插件)**：根据当前学习周数，**渐进式累加**拉取所有 ≤ 当前周的教学资料。
3. **LLM 集成**：将上述资料合成为**强约束 System Prompt**，防止 AI 使用超出当前学习进度的"超纲语法"答疑。

> ⚠️ **与现有模块的关系**：本方案是"实验任务 (assignments)" 体系的**平行增强**，新增 `wiki_chunks` 表和 `/api/v1/wiki` 路由，**不改动**现有 assignments / submissions 表结构。

---

## 二、可行性分析 & 关键优化点

### 2.1 ✅ 可行性结论

| 维度 | 评估 | 说明 |
|------|------|------|
| 数据流 | ✅ 可行 | Web ↔ 后端 (Express + SQLite) ↔ 插件，已有 assignments 表同模式可复用 |
| IPC 链路 | ✅ 可行 | 现有 `handleWebviewMessage` 已支持 `assignment_command` 分发，可扩展 `wiki_command` |
| RAG 简化版 | ✅ 可行 | 不引入向量库，直接全量上下文塞入 System Prompt，适合 18 周内的小规模教学资料 |
| 配置注入 | ✅ 可行 | 已有 `teaching.apiBase` 模板，新增 `clineTeaching.serverUrl` 仅是同模式 |
| 周数渐进 | ✅ 可行 | 后端 `WHERE applicable_week <= ?` 单字段查询，无需复杂索引 |

### 2.2 ⚠️ 优化点（已纳入方案）

| 风险点 | 优化措施 |
|--------|----------|
| 端口冲突：用户要求 `serverUrl` 默认 `http://localhost:3000`，但现有 teaching-server 占 **4001** | 方案同时给出：① 后端绑定 3000；② 或保留 4001 + 默认值改为 4001。**默认采用方案①**（题目原文明确要求 3000），若需调整请在审核中注明 |
| 全量塞入 System Prompt 可能触发 token 上限 | 限制单 chunk ≤ 4000 字；超长自动截断并打 `[已截断]` 标记；总上下文 ≤ 16k 字 |
| 学生切换周数时 RAG 资料不更新 | 在 `fetchWikiForWeek` 后立刻失效 `buildSystemPrompt` 的内部缓存 |
| 教师删除资料时插件仍持有旧缓存 | 提供 `invalidateCache(week?)` 方法，删除时广播通知 |
| Web 端 Markdown 内容含恶意 `<script>` | 渲染侧仅展示原始 Markdown，预览走 `react-markdown` + `rehype-sanitize` |
| SQLite `content` 字段无大小限制 | 写入前校验 ≤ 50KB（避免前端误传整本书） |
| VS Code 配置 `serverUrl` 与 `teaching.apiBase` 命名不一致 | 严格按需求文档使用 `clineTeaching.serverUrl`，并在内部统一加 alias 兼容旧字段 |

### 2.3 🎯 架构总览

```
┌──────────────────────────────────────────────────────────────────────┐
│  Web 教师端 (D:\web-dashboard\frontend)                               │
│  ┌──────────────────────────────┐                                    │
│  │  WikiManagement.tsx          │                                    │
│  │  - 上传表单 (Card)            │                                    │
│  │  - 资料表格 (Table + Tag)     │                                    │
│  └──────────────┬───────────────┘                                    │
└─────────────────┼────────────────────────────────────────────────────┘
                  │ axios: POST/GET/DELETE /api/v1/teacher/wiki
                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  后端 (D:\web-dashboard\teaching-server)                              │
│  ┌──────────────────────────────────────────────┐                    │
│  │  server.ts  (Express + SQLite + cors)         │                    │
│  │  + 新增表 wiki_chunks                          │                    │
│  │  + 新增路由:                                   │                    │
│  │    POST   /api/v1/teacher/wiki                │                    │
│  │    GET    /api/v1/teacher/wiki/list           │                    │
│  │    DELETE /api/v1/teacher/wiki/:id            │                    │
│  │    GET    /api/v1/wiki?max_week=N             │                    │
│  └──────────────┬─────────────────────────────────┘                    │
└─────────────────┼────────────────────────────────────────────────────┘
                  │ GET /api/v1/wiki?max_week={currentWeek}
                  ▼
┌──────────────────────────────────────────────────────────────────────┐
│  VS Code 插件 (D:\cline)                                              │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  AssignmentHeader.tsx (Webview)                               │    │
│  │  - 获取任务 / 周数 Select / 服务器 Modal                      │    │
│  │  - postMessage('switchWeek') / ('updateServerUrl')            │    │
│  └──────────────┬───────────────────────────────────────────────┘    │
│                 │ IPC (handleWebviewMessage)                         │
│  ┌──────────────▼───────────────────────────────────────────────┐    │
│  │  extension.ts (主进程)                                        │    │
│  │  - case 'switchWeek'    → llmWiki.fetchWikiForWeek(w)        │    │
│  │  - case 'updateServerUrl'→ vscode.workspace.getConfiguration │    │
│  └──────────────┬───────────────────────────────────────────────┘    │
│  ┌──────────────▼───────────────────────────────────────────────┐    │
│  │  LLMWikiService.ts (单例)                                     │    │
│  │  - fetchWikiForWeek(w) → in-memory wikiChunks cache          │    │
│  │  - buildSystemPrompt(q)   → 强约束 prompt                     │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 三、接口契约（API Contract）

### 3.1 后端 REST API（Express + SQLite）

| 方法 | 路径 | 请求 | 响应 | 说明 |
|------|------|------|------|------|
| POST | `/api/v1/teacher/wiki` | `{id,title,applicable_week,content}` | `{ok,data: WikiChunk}` | 教师上传资料（upsert by id） |
| GET | `/api/v1/teacher/wiki/list` | `?week=N`（可选筛选） | `{ok,count,data: WikiChunk[]}` | 教师查看已分发资料 |
| DELETE | `/api/v1/teacher/wiki/:id` | — | `{ok,message}` | 教师删除资料 |
| GET | `/api/v1/wiki` | `?max_week=N` (必填 1~18) | `{ok,count,data: WikiChunk[]}` | **学生端拉取（核心）** |

**`WikiChunk` 字段**：

```ts
{
  id: string                 // "chunk_week3_loops"
  title: string              // "Python for循环与列表迭代"
  applicable_week: number    // 3
  content: string            // Markdown 内容
  created_at: string         // ISO8601
}
```

**SQLite 表结构**：

```sql
CREATE TABLE IF NOT EXISTS wiki_chunks (
  id              TEXT PRIMARY KEY,            -- 资料唯一 ID
  title           TEXT NOT NULL,               -- 标题
  content         TEXT NOT NULL,               -- Markdown 正文
  applicable_week INTEGER NOT NULL,            -- 教学周数 1~18
  created_at      DATETIME DEFAULT (datetime('now', 'localtime')),
  updated_at      DATETIME DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_wiki_week ON wiki_chunks(applicable_week);
```

### 3.2 IPC 消息协议（Webview ↔ Extension）

| 方向 | type | payload | 说明 |
|------|------|---------|------|
| W→E | `wiki_command` | `{command: "fetchWiki", week: number}` | 学生点击"获取任务" |
| W→E | `wiki_command` | `{command: "switchWeek", week: number}` | 周数下拉框变更 |
| W→E | `wiki_command` | `{command: "updateServerUrl", url: string}` | Modal 保存服务器地址 |
| E→W | `wiki_response` | `{command, success, data?, error?}` | 响应（沿用 AssignmentResponse 结构） |

### 3.3 VS Code 配置项

```jsonc
{
  "clineTeaching.serverUrl": {
    "type": "string",
    "default": "http://localhost:3000",     // ⚠️ 见可行性分析
    "description": "教学辅助后端 API 地址（Wiki 资料库与实验任务）",
    "scope": "machine",
    "pattern": "^https?://.*:\\d+$",
    "patternErrorMessage": "必须是形如 http(s)://host:port 的 URL"
  },
  "clineTeaching.currentWeek": {
    "type": "number",
    "default": 1,
    "minimum": 1,
    "maximum": 18,
    "description": "学生当前学习周数（影响 Wiki 资料可见范围与 LLM 认知边界）"
  }
}
```

> **向后兼容**：在 `LLMWikiService` 内部，若 `clineTeaching.serverUrl` 读取为空，则 fallback 到旧的 `teaching.apiBase`，避免破坏已部署用户。

---

## 四、模块清单与产出物（v1.3）

| # | 模块 | 路径 | 语言/框架 | 状态 |
|---|------|------|-----------|------|
| 1 | `package.json` 配置片段 | `d:\cline\package.json` | JSON | 增量修改 |
| 2 | `WikiManagement.tsx` | `D:\web-dashboard\frontend\src\components\WikiManagement.tsx` | React + AntD | 新增 |
| 3 | `LLMSettingsView.tsx` ⭐v1.3 | `d:\cline\webview-ui\src\components\teaching\LLMSettingsView.tsx` | React (Webview) | 新增 |
| 4 | `LLMSettingsViewProvider.ts` ⭐v1.3 | `d:\cline\src\hosts\vscode\LLMSettingsViewProvider.ts` | TypeScript | 新增 |
| 5 | `AssignmentHeader.tsx` | `d:\cline\webview-ui\src\components\teaching\AssignmentHeader.tsx` | React (Webview) | 新增 |
| 6 | `LLMWikiService.ts` | `d:\cline\src\core\teaching\LLMWikiService.ts` | TypeScript | 新增 |
| 7 | `extension.ts` IPC 逻辑 | `d:\cline\src\extension.ts` + `d:\cline\src\hosts\vscode\VscodeWebviewProvider.ts` | TypeScript | 增量修改 |
| 8 | `server.ts` Wiki 路由 + 解析 + LLM 清洗 | `D:\web-dashboard\teaching-server\src\server.ts` | TypeScript + Express | 增量追加 |
| 9 | `llmHelper.ts` ⭐v1.3 | `D:\web-dashboard\teaching-server\src\llmHelper.ts` | TypeScript | 新增 |

---

## 五、关键代码骨架预览（非完整实现）

### 5.1 `LLMWikiService.ts` 单例骨架

```ts
export class LLMWikiService {
  private static _instance: LLMWikiService | null = null
  public static getInstance(): LLMWikiService { /* 单例 */ }

  private wikiCache: WikiChunk[] = []         // 内存缓存
  private currentWeek: number = 1
  private serverUrl: string                   // 动态读取

  private refreshConfig(): void               // 从 VS Code Config 同步
  public async fetchWikiForWeek(week: number): Promise<WikiChunk[]>
  public buildSystemPrompt(userQuery: string): string
  public invalidateCache(): void
}
```

**System Prompt 模板**（节选）：

```
# 角色
你是一名严格的 Python 编程教师，正在为第 {X} 周的学生答疑。

# 认知边界约束（不可违反）
1. 你只能引用第 1 ~ 第 {X} 周已被教师发布的资料作为答疑依据。
2. 严禁使用超出当前周数的高级语法、设计模式或高级库函数（如装饰器、async/await、推导式嵌套等需在更高周数才引入）。
3. 若学生提问涉及超纲内容，必须明确告知"该知识点将在第 Y 周讲解"，并提供入门指引。

# 优先参考知识（Primary Context）
{wikiChunks 内容拼接}

# 学生提问
{userQuery}
```

### 5.2 `extension.ts` IPC 处理片段

```ts
case "wiki_command": {
  const msg = message as WikiMessage
  switch (msg.command) {
    case "switchWeek": {
      const chunks = await LLMWikiService.getInstance().fetchWikiForWeek(msg.week)
      vscode.window.showInformationMessage(
        `已成功载入第 ${msg.week} 周及之前的教学资料（共 ${chunks.length} 条）！`
      )
      break
    }
    case "updateServerUrl": {
      await vscode.workspace.getConfiguration("clineTeaching")
        .update("serverUrl", msg.url, vscode.ConfigurationTarget.Global)
      LLMWikiService.getInstance().invalidateCache()
      vscode.window.showInformationMessage(`服务器地址已更新为 ${msg.url}`)
      break
    }
    case "fetchWiki": { /* 同 switchWeek，但下拉框不变 */ break }
  }
  break
}
```

---

## 六、实施步骤（v1.3 审核通过后执行）

> v1.3 共 **13 步**，相比 v1.2 增量：
> - 后端新增 `llmHelper.ts` + 2 个 `/api/v1/internal/llm-*` 路由
> - 插件新增 `LLMSettingsView.tsx` + `LLMSettingsViewProvider.ts`（v1.3 第 8 步）

| Step | 任务 | 涉及文件 | 依赖 |
|------|------|----------|------|
| 1 | 后端 `server.ts` 增加 `wiki_chunks` / `wiki_attachments` 表 + 4 个 wiki 路由 | `teaching-server/src/server.ts` | 无 |
| 2 | 后端 `extractMarkdown()` + 解析依赖（mammoth/pdf-parse/pptx-parser） | `teaching-server/src/server.ts` + `package.json` | 1 |
| 3 | 后端 `llmHelper.ts`（热加载 .env + LLM 调用封装） | `teaching-server/src/llmHelper.ts` | 无 |
| 4 | 后端 `cleanWithLLM()` 集成到 `POST /api/v1/teacher/wiki` | `teaching-server/src/server.ts` | 2, 3 |
| 5 | 后端 `POST /api/v1/internal/llm-env` + `POST /api/v1/internal/llm-test` | `teaching-server/src/server.ts` | 3 |
| 6 | Web `WikiManagement.tsx` 新增 + `App.jsx` 注册 NavBar 第三 tab | `frontend/src/components/WikiManagement.tsx` + `App.jsx` | 1 |
| 7 | 插件 `package.json` 增加 `clineTeaching.serverUrl/currentWeek/llmEnableTools/llmPresetModel` | `cline/package.json` | 无 |
| 8 | **v1.3 增量**：插件 `LLMSettingsView.tsx` + `LLMSettingsViewProvider.ts`（设置页） | `cline/webview-ui/src/components/teaching/LLMSettingsView.tsx` + `cline/src/hosts/vscode/LLMSettingsViewProvider.ts` | 7 |
| 9 | 插件 `LLMWikiService.ts` 新增（buildSystemPrompt + answerWithTools） | `cline/src/core/teaching/LLMWikiService.ts` | 7 |
| 10 | 插件 `AssignmentHeader.tsx` 新增 | `cline/webview-ui/src/components/teaching/AssignmentHeader.tsx` | 9 |
| 11 | 插件 `VscodeWebviewProvider.ts` 增加 `wiki_command` 分发（saveLLMSettings/testLLMConnection/switchWeek/...） | `cline/src/hosts/vscode/VscodeWebviewProvider.ts` | 8, 9 |
| 12 | 插件 `extension.ts` 注册 `LLMSettingsView` 与 `AssignmentHeader` 两个 WebviewView | `cline/src/extension.ts` | 8, 10, 11 |
| 13 | 端到端联调：设置页填 Key → 上传 docx → LLM 清洗 → 切换周数 → buildSystemPrompt → 工具调用答疑 | 全部 | 1~12 |

---

## 七、待用户确认的关键决策点

请在审核时**明确回复**以下选项：

1. **后端端口**：
   - Ⓐ 严格按需求文档默认 `http://localhost:3000`（需 teaching-server 改端口）
   - Ⓑ 保留 4001，Web 默认值改为 `http://localhost:4001`（最小侵入）
   - Ⓒ 其他：____________

2. **Wiki 模块的入口位置**（Web 教师端）：
   - Ⓐ 在 `App.jsx` 顶部 NavBar 新增第三个 tab "📚 教学资料管理"
   - Ⓑ 作为 `AssignmentPublish.tsx` 的同级组件，由教师手动切换
   - Ⓒ 嵌入 `AssignmentPublish` 同页面（折叠面板）

3. **`AssignmentHeader` 在插件侧边栏的呈现方式**：
   - Ⓐ 替换/合并现有 `AssignmentTab.tsx` 顶部 Header
   - Ⓑ 作为独立 WebviewView（与实验任务并列）
   - Ⓒ 内嵌为 `AssignmentTab` 的固定 header 区

4. **System Prompt 注入点**：
   - Ⓐ 仅暴露 `buildSystemPrompt(q)` 方法给业务方调用（推荐，本设计默认）
   - Ⓑ 自动注入到所有 Cline 主对话 system prompt（侵入性强）

5. **是否需要登录/鉴权**：
   - Ⓐ 无（教学内网，方案最简，本设计默认）
   - Ⓑ 增加 `X-Student-Id` 简易 Header 校验

6. **是否同时实现 `chunk_week3_loops` 这类 ID 的格式校验**：
   - Ⓐ 仅做"非空"校验（灵活）
   - Ⓑ 强制正则 `/^chunk_week(\d{1,2})_[a-z0-9_]+$/i`（严格）

---

## 八、教师上传文件格式策略（doc/docx/pdf/pptx 等 Office 格式 + LLM 二次清洗 + 工具调用答疑）

> 该问题在用户交互中提出，作为对本设计文档的补充章节。
>
> **v1.3 修订要点**（用户拍板）：
> 1. 确认采用**路径 B**（后端解析为 md）
> 2. 在路径 B 基础上增加 **LLM 二次清洗**（借鉴 karpathy "LLM 维护 Wiki" 思路）
> 3. 在插件端增加 **karpathy 式工具调用答疑**（复杂问题让 LLM 自助 grep_wiki）
> 4. **新增 5 项架构决策**：
>    - **8.A** LLM API Key 走"插件设置页 → 后端 .env"链路（与 Cline 主对话模型解耦）
>    - **8.B** LLM 清洗失败 **不阻塞**（降级写入原始文本）
>    - **8.C** 工具调用答疑 **在设置页提供开关**（默认关闭）
>    - **8.D** chunk 拆分 **由 LLM 决定**
>    - **8.E** 同一 wikiId 拆出 chunk 总数 **默认上限 5**
> 5. 不再保留路径 A/C 独立小节（决策已定）

### 8.0 修订后的完整数据流（v1.3）

```
┌──────────────────────────────────────────────────────────────────────┐
│  Cline 插件侧边栏"LLM 设置"WebviewView                                │
│  学生填写：                                                           │
│    - 模型选择（GPT-4o / Claude / DeepSeek / Qwen / 自定义）          │
│    - 自动填充 baseUrl                                                  │
│    - 手动填写 API Key                                                  │
│    - 工具调用答疑开关                                                  │
│  点击保存 → postMessage({command:'saveLLMSettings', ...})           │
└──────────────────────────────────────────────────────────────────────┘
                                         │ IPC
                                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  插件主进程                                                            │
│  ① 接收 saveLLMSettings → 写本地 ~/.cline/teaching-llm.env          │
│  ② 调用 teaching-server /api/v1/internal/llm-env (push .env 内容)   │
└──────────────────────────────────────────────────────────────────────┘
                                         │ HTTP
                                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  后端 teaching-server（端口 4001）                                    │
│  ① 接收 /api/v1/internal/llm-env → 写 ./teaching-server/.env        │
│  ② multer 接收 docx/pdf/pptx → uploads/wiki/<id>.<ext>              │
│  ③ extractMarkdown() 提取原始文本                                    │
│       mammoth  → docx → md                                           │
│       pdf-parse → pdf → text                                         │
│       pptx-parser → pptx → 每页文本                                  │
│  ④ 【LLM 二次清洗】读 .env → callLLM() → 结构化 md                   │
│  ⑤ wiki_chunks 写入（content = 清洗后 md / 或降级为原始文本）        │
└──────────────────────────────────────────────────────────────────────┘
                                         │ GET /api/v1/wiki?max_week=N
                                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  插件 LLMWikiService                                                 │
│  ① fetchWikiForWeek(w) → 缓存 wikiChunks                            │
│  ② buildSystemPrompt(q) → 强约束 Prompt                              │
│  ③ 【开关开启时】answerWithTools(q) → karpathy 式工具调用              │
└──────────────────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────────────────┐
│  教师端（Web）                                                       │
│  教师上传 docx/pdf/pptx ──────────────┐                              │
│  （无需手写 .md，无需按 Prompt 格式） │                              │
└────────────────────────────────────────┼─────────────────────────────┘
                                         │ multipart/form-data
                                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  后端 teaching-server                                                │
│                                                                      │
│  ① multer 接收 → uploads/wiki/<id>.<ext>                            │
│  ② extractMarkdown() 提取原始文本                                    │
│       mammoth  → docx → md                                           │
│       pdf-parse → pdf → text                                         │
│       pptx-parser → pptx → 每页文本                                  │
│  ③ 【新增】LLM 二次清洗（chunk-and-summarize）                       │
│       - 按教学语义切 chunk（每个 chunk ≤4000 字）                     │
│       - 生成前置知识 / 学习目标 / 示例代码 元数据                     │
│       - 输出结构化 Markdown（含 frontmatter）                        │
│  ④ 写入 wiki_chunks（content = 清洗后的 md）                          │
│  ⑤ wiki_attachments 子表记录原文件                                   │
└──────────────────────────────────────────────────────────────────────┘
                                         │ GET /api/v1/wiki?max_week=N
                                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  插件 LLMWikiService                                                 │
│                                                                      │
│  ① fetchWikiForWeek(w) → 缓存 wikiChunks                            │
│  ② buildSystemPrompt(q) → 强约束 Prompt（含清洗后的 md 内容）        │
│  ③ 【新增】answerWithTools(q) → karpathy 式工具调用                   │
│       - 注册 grep_wiki / read_chunk / list_weeks 三个工具             │
│       - LLM 自主决定调用哪些 chunk                                    │
│       - 适用于"对比第 3 周 vs 第 7 周"等跨周复杂问题                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.1 阶段①：教师上传策略（支持 Office 格式）

| 维度 | 结论 |
|------|------|
| 上传阶段 | ✅ 允许 `.md / .txt / .doc / .docx / .pdf / .pptx / .ppt`，由后端 multer `fileFilter` 校验 |
| 存储阶段 | ✅ 原文件落 `uploads/wiki/`，记录 `wiki_attachments` 子表 |
| 教师工作量 | ⚠️ **无需手动写 md，无需按 Prompt 格式编写**；上传任意格式即可 |

### 8.2 阶段②：LLM 二次清洗管线（借鉴 karpathy）

> 教师上传 docx/pdf/pptx 后，**先由后端解析为原始文本，再调用 LLM 二次清洗为教学友好的结构化 Markdown**。

#### 8.2.1 为什么需要二次清洗？

| 仅做原始解析（路径 B 基础版）的问题 | LLM 二次清洗的解决方案 |
|-----------------------------------|---------------------|
| mammoth 直接转换的 md 含样式噪声 | LLM 去除冗余样式，保留教学语义 |
| 原始 PDF 文本是连续段落，无章节 | LLM 自动识别"定义 / 示例 / 练习"等教学结构 |
| pptx 每页文本是孤立的 | LLM 串联为"教学单元"，补充上下文 |
| 教师资料无 frontmatter | LLM 自动生成前置知识、学习目标、示例代码
#### 8.2.2 LLM 清洗 Prompt 模板（后端调用）

```text
# 角色
你是一名 Python 教学资料编辑，负责把教师上传的原始资料改写为
结构化 Markdown，供学生端 RAG 答疑使用。

# 输入
原始文本（可能含样式噪声、无章节、孤立的 PPT 文本块）：
{rawText}

所属周数：第 {week} 周
所属课程主题：{title}

# 输出要求（严格遵守）
1. 必须输出合法 Markdown
2. 顶部必须含 YAML frontmatter：
   ---
   id: {wikiId}
   title: {title}
   applicable_week: {week}
   prerequisites: [第 {week-1} 周 / 第 {week-2} 周 ...]
   learning_objectives: [目标 1, 目标 2, ...]
   ---
3. 正文必须包含至少 3 个二级章节：定义 / 示例代码 / 常见错误
4. 单 chunk 不超过 4000 字；超长则拆为多 chunk
5. 只使用当前周可用的语法（不引入未来周数的高级特性）
6. 不输出任何超出 frontmatter 与正文以外的内容
```

#### 8.2.3 LLM 清洗管线（异步任务，可降级为同步）

```ts
// server.ts 新增
async function cleanWithLLM(rawText: string, wikiId: string, week: number, title: string): Promise<string> {
  // 1) 读 LLM 配置
  const cfg = loadLLMConfig()  // 来自 .env 或教学后端配置中心
  if (!cfg.apiKey) {
    // 【降级】未配置 LLM 时，直接用原始解析结果（保留路径 B 基础能力）
    Logger.warn(`[wiki-clean] 未配置 LLM API Key，跳过二次清洗，使用原始文本`)
    return rawText
  }

  // 2) 调用 LLM（带 30s 超时）
  const prompt = buildCleanPrompt({ rawText, wikiId, week, title })
  const cleaned = await Promise.race([
    callLLM(cfg, prompt),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("LLM clean timeout")), 30_000)
    ),
  ])

  // 3) token 计数 + 截断
  const truncated = truncateByTokens(cleaned, 4000)
  return truncated
}
```

#### 8.2.4 降级策略（重要）

| 触发条件 | 降级行为 |
|---------|---------|
| 未配置 `LLM_API_KEY` | 跳过 LLM 清洗，直接用原始解析文本 |
| LLM 调用超时（30s） | 写入 `wiki_chunks.content` 原始文本 + `cleaned_by_llm=false` 标记 |
| LLM 返回非 Markdown | 同上 |
| LLM 不可达（网络故障） | 同上 |

> 即使 LLM 服务不可用，本方案仍可工作 —— 这是**借鉴 karpathy 但不依赖其基础设施**的关键差异点。

#### 8.2.5 SQLite 表调整（增加 LLM 清洗状态字段）

```sql
ALTER TABLE wiki_chunks ADD COLUMN cleaned_by_llm INTEGER DEFAULT 0;
ALTER TABLE wiki_chunks ADD COLUMN llm_clean_error TEXT;  -- 清洗失败时的错误信息
ALTER TABLE wiki_chunks ADD COLUMN chunk_index INTEGER DEFAULT 0;  -- 同一 wikiId 拆为多 chunk 时的序号
ALTER TABLE wiki_chunks ADD COLUMN chunk_total INTEGER DEFAULT 1;
```

### 8.3 阶段③：karpathy 式工具调用答疑

> 学生提问时，**部分问题可由 buildSystemPrompt 一次性回答**；但"对比第 3 周和第 7 周的概念"等跨周问题需要 LLM 自主检索。

#### 8.3.1 注册的三个工具

| 工具名 | 输入 | 输出 | 用途 |
|--------|------|------|------|
| `grep_wiki` | `pattern: string, max_week: number` | `[{chunkId, title, snippet}]` | 关键词搜索 Wiki |
| `read_chunk` | `chunkId: string` | `{id, title, content, applicable_week}` | 读取单个 chunk 全文 |
| `list_weeks` | — | `[{week, count}]` | 列出已载入的周数与 chunk 数 |

#### 8.3.2 工具调用协议（LLM ↔ Plugin）

```
LLM 决定调用 grep_wiki(pattern="装饰器", max_week=7)
   ↓
Plugin 返回 [{chunkId: "chunk_week5_decorators", title: "...", snippet: "..."}]
   ↓
LLM 决定调用 read_chunk(chunkId="chunk_week5_decorators")
   ↓
Plugin 返回完整 content
   ↓
LLM 综合生成最终答案
```

#### 8.3.3 与 buildSystemPrompt 的分工

| 问题类型 | 处理路径 |
|---------|---------|
| 当前周基础概念 | `buildSystemPrompt(q)` 一次性回答（已注入上下文） |
| 跨周对比 / 引用前几周 | LLM 调用 `read_chunk` |
| 模糊检索 / 关键词匹配 | LLM 调用 `grep_wiki` |
| 全局周数统计 | LLM 调用 `list_weeks` |

#### 8.3.4 `LLMWikiService.answerWithTools` 接口设计

```ts
/**
 * karpathy 式工具调用答疑入口。
 * 调用方传入用户问题；本方法协调 LLM 与工具调用协议。
 */
public async answerWithTools(
  userQuery: string,
  llmCaller: (msgs: ChatMsg[], tools: ToolDef[]) => Promise<LLMResp>
): Promise<string>
```

> `llmCaller` 由业务方（Cline 主对话循环）注入，本服务**不绑定具体 LLM SDK**，仅依赖 OpenAI 兼容的 ChatCompletion 接口。

### 8.4 新增依赖（v1.2 增量）

| 依赖 | 体积 | 用途 | 安装位置 |
|------|------|------|----------|
| `mammoth` | ~3MB | docx → md | teaching-server |
| `pdf-parse` | ~6MB | pdf → text | teaching-server |
| `pptx-parser` | ~2MB | pptx → 文本 | teaching-server |
| `tiktoken` | ~5MB | token 计数（清洗后是否超长） | teaching-server |
| `openai` | ~10MB | LLM 清洗 + 答疑 | teaching-server |
| **合计** | **~26MB** | — | — |

> 📝 不引入 `bullmq / sharp / tesseract`，避免过度工程。

### 8.5 接口契约调整（v1.2 增量）

| 方法 | 路径 | 请求 | 响应变化 |
|------|------|------|---------|
| POST | `/api/v1/teacher/wiki` | multipart + attachments | 响应新增 `cleaned_by_llm: boolean`、`llm_clean_error?: string` |
| GET | `/api/v1/wiki?max_week=N` | — | 响应 chunk 含 `cleaned_by_llm`、`chunk_index`、`chunk_total` |

### 8.6 LLM 配置架构（v1.3 重大调整）

> **v1.3 决策**：LLM API Key **不在** VS Code 配置中（避免与 Cline 主对话模型耦合），
> 改为通过**插件设置页**填写 → 写入后端 `.env` → 后端统一管理。

#### 8.6.1 为什么这样设计？

| 设计目标 | 实现方式 |
|---------|---------|
| **与 Cline 主对话模型解耦** | LLM 配置独立存放在后端 `.env`，不污染 `clineTeaching.*` VS Code 配置 |
| **不同数据选用不同模型** | 学生在设置页可选 GPT-4o-mini（清洗）/ Claude-3.5（答疑）等场景化模型 |
| **API Key 不落 Git / 不同步** | 写入后端 `.gitignore` + 插件本地 `~/.cline/teaching-llm.env` |
| **教学服务器自主运维** | 后端管理员也可直接编辑 `.env`，与运维流程一致 |

#### 8.6.2 新增模块：`LLMSettingsView.tsx`（插件设置页 WebviewView）

**位置**：注册为 VS Code 侧边栏独立 WebviewView，命令 ID `cline.openLLMSettingsView`。

**UI 布局**（从上到下）：

```
┌──────────────────────────────────────────────────┐
│  📚 教学 LLM 设置                                  │
├──────────────────────────────────────────────────┤
│  模型选择 [Select]                                │
│    ○ GPT-4o (OpenAI)        → baseUrl 自动填入    │
│    ○ GPT-4o-mini (OpenAI)   → baseUrl 自动填入    │
│    ○ Claude 3.5 Sonnet      → baseUrl 自动填入    │
│    ○ DeepSeek Chat          → baseUrl 自动填入    │
│    ○ 通义千问 Qwen-Long     → baseUrl 自动填入    │
│    ○ 自定义（手动填 baseUrl）                     │
│                                                   │
│  Base URL [Input]  ← 选择非"自定义"时自动填充   │
│    https://api.openai.com/v1                      │
│                                                   │
│  API Key [Input.Password]                          │
│    ●●●●●●●●●●●●●●●●                              │
│                                                   │
│  [测试连接]  状态: ✅ 连接成功 / ❌ 401 Unauthorized│
│                                                   │
│  ─────────────────────────────────────────────    │
│  ⚙ 高级选项                                       │
│                                                   │
│  [☐] 启用 karpathy 式工具调用答疑                 │
│      说明: 开启后，跨周复杂问题将由 LLM           │
│      自主调用 grep_wiki / read_chunk 工具。       │
│      关闭时所有问题均通过 buildSystemPrompt        │
│      一次性回答（更省 token）。                   │
│                                                   │
│  [保存]  [恢复默认]                                │
└──────────────────────────────────────────────────┘
```

#### 8.6.3 IPC 协议（新增）

| 方向 | type | payload | 说明 |
|------|------|---------|------|
| W→E | `wiki_command` | `{command: "saveLLMSettings", provider, baseUrl, apiKey, enableTools}` | 学生点保存 |
| W→E | `wiki_command` | `{command: "testLLMConnection", baseUrl, apiKey, model}` | 学生测试连接 |
| W→E | `wiki_command` | `{command: "loadLLMSettings"}` | 打开设置页时回填 |
| E→W | `wiki_response` | `{command, success, data?, error?}` | 响应 |

#### 8.6.4 预置模型表（前端常量）

```ts
// LLMSettingsView.tsx 常量
const PRESET_MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o-mini (OpenAI)', baseUrl: 'https://api.openai.com/v1' },
  { id: 'gpt-4o',       label: 'GPT-4o (OpenAI)',     baseUrl: 'https://api.openai.com/v1' },
  { id: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Anthropic)', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'deepseek-chat', label: 'DeepSeek Chat',       baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'qwen-long',     label: '通义千问 Qwen-Long',   baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'custom',        label: '自定义（手动填 baseUrl）', baseUrl: '' },
]
```

#### 8.6.5 .env 写入流程（双层链路）

```
┌──────────────────────────────────────────────────────────┐
│  步骤 1：插件本地缓存（学生随时查看）                       │
│  ~/.cline/teaching-llm.env                                │
│    TEACHING_LLM_PROVIDER=openai                           │
│    TEACHING_LLM_BASE_URL=https://api.openai.com/v1        │
│    TEACHING_LLM_API_KEY=sk-xxx                            │
│    TEACHING_LLM_MODEL=gpt-4o-mini                         │
│    TEACHING_LLM_ENABLE_TOOLS=false                        │
│                                                          │
│  步骤 2：HTTP 推送到后端                                  │
│  POST /api/v1/internal/llm-env                           │
│    {provider, baseUrl, apiKey, model, enableTools}        │
│       ↓                                                  │
│  后端写入 ./teaching-server/.env (需 gitignore)           │
└──────────────────────────────────────────────────────────┘
```

#### 8.6.6 后端新增路由

```ts
// server.ts 新增
app.post("/api/v1/internal/llm-env", (req, res) => {
  const { provider, baseUrl, apiKey, model, enableTools } = req.body

  // 1) 写 .env
  const envContent = [
    `TEACHING_LLM_PROVIDER=${provider}`,
    `TEACHING_LLM_BASE_URL=${baseUrl}`,
    `TEACHING_LLM_API_KEY=${apiKey}`,
    `TEACHING_LLM_MODEL=${model}`,
    `TEACHING_LLM_ENABLE_TOOLS=${enableTools}`,
    ``
  ].join('\n')
  fs.writeFileSync(path.resolve(__dirname, '..', '.env'), envContent)

  // 2) 立即热加载（不重启 server）
  loadLLMConfig()  // 重新读 .env 到内存

  res.json({ ok: true })
})

app.post("/api/v1/internal/llm-test", async (req, res) => {
  // 测活：用 baseUrl + apiKey + model 发一次最小请求
  const { baseUrl, apiKey, model } = req.body
  try {
    await callLLM(baseUrl, apiKey, model, [{ role: 'user', content: 'ping' }], 5_000)
    res.json({ ok: true, message: '连接成功' })
  } catch (e) {
    res.status(502).json({ ok: false, message: e.message })
  }
})
```

#### 8.6.7 VS Code 配置项（**仅保留非敏感项**）

```jsonc
{
  "clineTeaching.llmEnableTools": {
    "type": "boolean",
    "default": false,
    "description": "是否启用 karpathy 式工具调用答疑（在设置页可改）",
    "scope": "window"
  },
  "clineTeaching.llmPresetModel": {
    "type": "string",
    "default": "gpt-4o-mini",
    "enum": ["gpt-4o-mini", "gpt-4o", "claude-3-5-sonnet-20241022", "deepseek-chat", "qwen-long", "custom"],
    "description": "设置页默认选中的预设模型"
  }
}
```

> ⚠️ **不再在 VS Code 配置中保存 apiKey / baseUrl**——这些敏感信息走 `.env` 链路。

---

### 8.7 关键设计决策（v1.3 用户拍板）

| # | 决策点 | 决策 | 实现 |
|---|--------|------|------|
| 8.A | LLM API Key 配置位置 | **插件设置页 → 后端 .env** | `LLMSettingsView.tsx` + `POST /api/v1/internal/llm-env` |
| 8.B | LLM 清洗失败时是否阻塞上传 | **不阻塞，降级写入原始文本** | `cleaned_by_llm=false` 标记 |
| 8.C | 工具调用答疑开关 | **默认关闭，设置页提供开启选项 + 说明文案** | `TEACHING_LLM_ENABLE_TOOLS=false` + 设置页 Switch |
| 8.D | chunk 拆分粒度 | **由 LLM 决定** | 清洗 Prompt 中明确"按教学语义切分，不强切" |
| 8.E | chunk 总数上限 | **推荐方案：≤5 个** | 清洗 Prompt 中明确约束；超限时 LLM 自行合并 |

#### 8.7.1 8.B 降级策略详解

```
LLM 清洗调用
   │
   ├── 成功 ──▶ 写入清洗后的 md，cleaned_by_llm=true
   │
   ├── 超时 (30s) ─┐
   ├── API Key 无效│──▶ 写入原始文本 + llm_clean_error 字段
   ├── 网络错误   ─┘    cleaned_by_llm=false
   │
   └── 响应非 Markdown ──▶ 同上
```

前端 `WikiManagement.tsx` 在上传完成后展示：
- ✅ `已清洗`（绿色 Tag）
- ⚠️ `原始文本`（黄色 Tag，hover 显示原因）

#### 8.7.2 8.C 工具调用答疑开启后的提示

设置页 Switch 开启时弹窗提示：

```
⚠️ 启用工具调用答疑后：

• 跨周复杂问题将由 LLM 自主检索 Wiki
• 平均 token 消耗增加 30%~80%
• 答疑延迟可能 +2~5 秒
• 建议在"对比"、"综合"类提问时启用

是否确认开启？ [取消] [确认开启]
```

---

### 8.8 受影响的原 6 项决策

| # | 原始决策 | v1.3 调整 |
|---|----------|-----------|
| 1 | 端口保留 4001 | 不变 |
| 2 | NavBar 第三 tab | 不变（WikiManagement 是 Web 端，与 LLM 设置页互不依赖） |
| 3 | 独立 WebviewView | **新增 1 个** `LLMSettingsView`（共 2 个独立 WebviewView） |
| 4 | 仅暴露 buildSystemPrompt | **扩展为 `buildSystemPrompt` + `answerWithTools`** 双方法（开关控制） |
| 5 | 无鉴权但预留扩展 | 不变 |
| 6 | ID 仅做非空校验 | 不变 |

---

### 8.9 v1.3 新增模块清单

| # | 模块 | 路径 | 类型 | 说明 |
|---|------|------|------|------|
| 1 | `LLMSettingsView.tsx` | `cline/webview-ui/src/components/teaching/LLMSettingsView.tsx` | 新增 | 插件设置页 WebviewView |
| 2 | `LLMSettingsViewProvider.ts` | `cline/src/hosts/vscode/LLMSettingsViewProvider.ts` | 新增 | WebviewView 容器 |
| 3 | `package.json contributes.viewsContainers` | `cline/package.json` | 修改 | 注册 `clineLLMSettings` 视图容器 |
| 4 | `package.json contributes.views` | `cline/package.json` | 修改 | 注册 `LLMSettingsView` |
| 5 | `extension.ts` activate | `cline/src/extension.ts` | 修改 | 注册 `LLMSettingsViewProvider` |
| 6 | `server.ts /api/v1/internal/llm-env` | `teaching-server/src/server.ts` | 新增 | 接收并写 .env |
| 7 | `server.ts /api/v1/internal/llm-test` | `teaching-server/src/server.ts` | 新增 | 测试 LLM 连通性 |
| 8 | `server.ts llmHelper.ts` | `teaching-server/src/llmHelper.ts` | 新增 | LLM 调用封装 + 热加载 .env |

---

## 九、风险评估与回退方案

| 风险 | 触发条件 | 回退方案 |
|------|----------|----------|
| 端口冲突导致后端启动失败 | 3000/4001 被占用 | 用环境变量 `PORT` 覆盖，启动日志输出实际端口 |
| System Prompt 超 token 上限 | Wiki 内容 > 16k 字 | 自动按周数从低到高拼接 + 超长截断 + 提示学生精简提问 |
| 旧用户缓存了旧 serverUrl | 升级后连接失败 | `refreshConfig()` 自动 fallback `teaching.apiBase` |
| SQLite 写入并发冲突 | 教师频繁编辑 | 已启用 WAL 模式；写入走 `INSERT OR REPLACE` |
| React Markdown XSS | 教师粘贴恶意脚本 | 仅用纯文本预览，详情用 `<pre>` + 转义（暂不引入 react-markdown） |
| Office 文件恶意宏 / PDF 漏洞 | 教师上传带毒文件 | 仅作"下载文件"让学生本机打开；服务端不解析、不执行；下载文件名重命名 + 强校验 `fileFilter` |
| 单 wiki 携带超大 Office 文件 | 教师误传 500MB 视频 | `multer.limits.fileSize = 50MB` + `files = 5`；超限返回 413 |
| Office 解析阻塞 HTTP 请求 | 50MB docx 解析 > 30s | `Promise.race` 30s 超时；失败返回 422；二期拆 BullMQ 队列 |
| PDF 扫描版解析为空 | 教师上传纯图 PDF | 检测 `pdfParse.text.length === 0` → 返回 warning，不入 RAG |
| docx 公式/复杂表格 | LaTeX 公式、嵌套表格 | `mammoth` 尽力而为；二期可加 `mathjax-node` 后处理 |
| Office 解析依赖被供应链投毒 | `npm install` 安装到恶意包 | 锁定具体版本范围（如 `mammoth@^1.8.0`）+ `pnpm-lock.yaml` 严格模式 |
| **v1.3** LLM API Key 写入 .env 后被误提交 Git | 开发者手动 `git add .env` | `.gitignore` 已加 `*.env` + 后端 CI 加 `gitleaks` 扫描 |
| **v1.3** 后端 .env 与插件本地 .env 不一致 | 学生改了插件端但未推送后端 | 后端接收时校验 `TEACHING_LLM_API_KEY` 是否更新；显示"⚠️ 后端未同步" |
| **v1.3** 工具调用答疑导致 token 超限 | LLM 自主调用 10+ 个 chunk | 在 `LLMWikiService.answerWithTools` 内做硬上限：单次最多 5 次工具调用 |
| **v1.3** 工具调用答疑时延过高 | 5 次串行调用 5~10s | 改为并行 `Promise.all` 调用 |
| **v1.3** chunk 拆分过多 | LLM 失控拆出 20+ chunk | 清洗 Prompt 明确约束 ≤5；服务端再校验，超出则合并 |
| **v1.3** API Key 在 Webview 内存泄漏 | React 组件未清理 state | `useEffect` cleanup 中 `setApiKey('')`；保存后立即从 state 清除 |

---

## ⏳ 等待您的审核（v1.3）

**请回复确认或修改意见，重点确认第八章 5 项 v1.3 决策（8.A~8.E）。** 一旦审核通过，将按第六节步骤顺序生成完整的 **11 个代码文件**（v1.3 增量 2 个），每个均含详尽中文注释，符合本仓库既有风格。

---

## ✅ 审核意见（已确认，2026-07-30）

### 原 6 项决策

| # | 决策点 | 审核结论 |
|---|--------|----------|
| 1 | 后端端口 | **保留 4001**（最小侵入，不破坏现有 teaching-server 部署） |
| 2 | Wiki 入口位置 | 在 `App.jsx` 顶部 NavBar 新增第三个 tab **"📚 教学资料管理"** |
| 3 | `AssignmentHeader` 呈现方式 | 作为**独立 WebviewView**（与实验任务并列） |
| 4 | System Prompt 注入点 | 仅暴露 `buildSystemPrompt(q)` 方法给业务方调用 |
| 5 | 鉴权 | 当前**无**鉴权，但需预留后续拓展开发的空间（中间件抽象、配置开关） |
| 6 | ID 格式校验 | 仅做**"非空"**校验（灵活） |

### 第八章 v1.3 新增 5 项决策（用户拍板）

| # | 决策点 | 审核结论 |
|---|--------|----------|
| 8.A | LLM API Key 配置位置 | **新增插件设置页 `LLMSettingsView`** → 写后端 `.env`；**与 Cline 主对话模型解耦**，可按场景选不同模型 |
| 8.B | LLM 清洗失败时阻塞？ | **不阻塞**，降级写入原始文本 + `cleaned_by_llm=false` 标记 |
| 8.C | 工具调用答疑开关 | **默认关闭**，设置页提供开启选项 + 详细说明文案（token/延迟影响） |
| 8.D | chunk 拆分粒度 | **由 LLM 决定**（按教学语义切分，不强切） |
| 8.E | chunk 总数上限 | **推荐方案：≤5 个**（清洗 Prompt 约束 + 服务端校验） |

> **执行前置**：本设计文档已 git commit 存档（仅本地，不推送），随后进入实现阶段。

---

## 十、v2.0 扩展：教材级 Wiki 支持（2026-08-01 用户拍板）

> v1.3 仅支持"单 chunk 资料上传"。v2.0 在此基础上拓展：
> **允许教师上传整本教材（pdf/docx），系统自动切分为章节，教师+AI 联合划定章节↔周数映射。**

### 10.1 v2.0 用户拍板的 8 项决策

| # | 决策点 | 选择 |
|---|--------|------|
| 1 | 教材解析位置 | **A** 后端异步（worker_threads + 进度轮询） |
| 2 | 章节切分方式 | **A** LLM 自动识别（降级正则） |
| 3 | 范围划定 UI | **A+B** AI 建议一键采纳 + 教师微调 |
| 4 | 教材文件格式 | **A** pdf + docx（最小集） |
| 5 | 章节与现有 wiki 关系 | **B** 独立表，按需 JOIN（清晰解耦） |
| 6 | 大文件上传限制 | **B** 500MB |
| 7 | OCR 范围 | **B** tesseract.js 处理扫描版（+80MB 依赖） |
| 8 | 教师端 UI 入口 | **B** WikiManagement 内嵌 tab 切换 |

### 10.2 数据模型（v2.0 新增 3 表）

```sql
-- 教材主表
CREATE TABLE IF NOT EXISTS textbooks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  total_chapters  INTEGER DEFAULT 0,
  processed       INTEGER DEFAULT 0,        -- 0/1：是否解析完成
  task_status     TEXT DEFAULT 'pending',  -- pending/processing/done/failed
  task_progress   INTEGER DEFAULT 0,       -- 0~100
  task_error      TEXT,
  original_name   TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  mime_type       TEXT NOT NULL,
  created_at      DATETIME DEFAULT (datetime('now'))
);

-- 教材章节表（解析产物）
CREATE TABLE IF NOT EXISTS textbook_chapters (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  textbook_id     TEXT NOT NULL,
  chapter_index   INTEGER NOT NULL,
  title           TEXT NOT NULL,
  content_md      TEXT NOT NULL,
  start_offset    INTEGER,
  end_offset      INTEGER,
  ocr_used        INTEGER DEFAULT 0,       -- 是否走 OCR
  ai_reviewed     INTEGER DEFAULT 0,
  FOREIGN KEY (textbook_id) REFERENCES textbooks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tc_textbook ON textbook_chapters(textbook_id);

-- 章节 ↔ 周数 映射（教师 + AI 联合编辑）
CREATE TABLE IF NOT EXISTS textbook_chapter_weeks (
  textbook_id     TEXT NOT NULL,
  chapter_index   INTEGER NOT NULL,
  applicable_week INTEGER NOT NULL,        -- 1~18
  source          TEXT DEFAULT 'manual',   -- 'manual' | 'ai-suggested' | 'ai-accepted'
  updated_at      DATETIME DEFAULT (datetime('now')),
  PRIMARY KEY (textbook_id, chapter_index),
  FOREIGN KEY (textbook_id) REFERENCES textbooks(id) ON DELETE CASCADE
);
```

### 10.3 异步任务管线（v2.0 核心）

```
教师上传教材 (multipart/form-data, file=<教材>)
   ↓
POST /api/v1/teacher/textbook
   ↓
multer 接收 → uploads/textbook/<id>.<ext>
   ↓
INSERT textbooks(task_status='processing', task_progress=0)
   ↓
返回 202 Accepted + { textbookId, status: 'processing' }
   ↓
【后台 worker_threads 异步执行】
   ① task_progress=10 → mammoth/pdf-parse 提取全文
   ② task_progress=40 → llmHelper.splitByChapter (LLM 切分)
   ③ 降级：若 LLM 不可用 → 正则匹配目录
   ④ task_progress=70 → tesseract.js OCR（仅在 PDF 文本为空时触发）
   ⑤ task_progress=90 → 写入 textbook_chapters
   ⑥ task_status='done' / task_progress=100
   ↓
教师前端轮询 GET /api/v1/teacher/textbook/:id/status
```

### 10.4 新增后端路由

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/teacher/textbook` | 上传教材（异步任务） |
| GET | `/api/v1/teacher/textbook/:id/status` | 轮询进度 |
| GET | `/api/v1/teacher/textbook/:id/chapters` | 获取章节列表（含 AI 建议） |
| POST | `/api/v1/teacher/textbook/:id/ai-review` | 触发 AI 辅助评判章节难度 |
| POST | `/api/v1/teacher/textbook/:id/chapter-week` | 教师手动设定章节↔周数 |
| POST | `/api/v1/teacher/textbook/:id/ai-accept` | 一键采纳 AI 建议 |

### 10.5 学生端拉取（保持协议兼容）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/wiki?max_week=N` | **现有接口**：返回 wiki_chunks + JOIN textbook_chapters |

**关键兼容**：后端 `GET /api/v1/wiki?max_week=N` 增加可选查询参数 `textbook_id`，未传时只返回普通 wiki_chunks；传了则 JOIN textbook_chapters + textbook_chapter_weeks。

### 10.6 AI 辅助评判 Prompt

```text
# 角色
你是 Python 教学专家，负责评估教材章节难度与适配周数。

# 输入
- 课程总周数: 18
- 章节标题: {chapterTitle}
- 章节内容（前 2000 字）: {chapterContent}
- 已分配章节列表: [{week: 3, title: "列表"}, {week: 4, title: "字典"}]

# 输出 JSON（严格遵守）
{
  "suggested_week": 5,
  "difficulty": "easy" | "medium" | "hard",
  "prerequisites": ["第 3 周", "第 4 周"],
  "reasoning": "本章引入装饰器，需先掌握函数基础与闭包",
  "teaching_focus": ["理解装饰器本质", "掌握 @staticmethod 用法"]
}
```

### 10.7 插件端改动

**VS Code 配置新增**：
```jsonc
"clineTeaching.currentTextbookId": {
  "type": "string",
  "default": "",
  "description": "当前生效的教材 ID（为空则不拉取教材）"
}
```

**LLMWikiService.ts 增量**：
- `setCurrentTextbook(id)` → 写 VS Code 配置
- `loadTextbookForWeek(week)` → GET `/api/v1/wiki?max_week=N&textbook_id=...`
- `buildSystemPrompt()` 内合并 textbook_chapters 内容到 Primary Context
- 每个章节内容截断 ≤ 2000 字（避免单章占用过大 token）

### 10.8 新增依赖

| 依赖 | 体积 | 用途 |
|------|------|------|
| `tesseract.js` | ~80MB | OCR 扫描版 PDF（仅在文本提取为空时触发） |
| `worker_threads` | 内置 | 异步解析 |
| `multer` 调优 | 已有 | fileSize 提到 500MB |

### 10.9 实施步骤（v2.0 共 8 步）

| Step | 任务 | 涉及文件 |
|------|------|----------|
| 1 | 后端新增 3 张表 + 6 个路由 + 异步 worker | `server.ts` |
| 2 | 后端 `textbookParser.ts`（LLM 切分 + 正则降级 + OCR 兜底） | 新增 |
| 3 | 后端 `textbookTaskQueue.ts`（worker_threads 异步任务队列） | 新增 |
| 4 | 后端 AI 辅助评判 Prompt + `/ai-review` 接口 | `llmHelper.ts` 增量 |
| 5 | Web `TextbookManagement.tsx`（上传 + 进度条 + 章节范围划定 + AI 建议面板） | 新增 |
| 6 | Web `WikiManagement.tsx` 增加 tab 切换（资料管理 / 教材管理） | `WikiManagement.tsx` 增量 |
| 7 | 插件 `LLMWikiService.ts` 增加 `loadTextbookForWeek` + buildSystemPrompt 合并 | `LLMWikiService.ts` 增量 |
| 8 | git commit v2.0 | 设计文档 + 代码 |

### 10.10 风险与兜底

| 风险 | 兜底 |
|------|------|
| 500MB PDF 解析 > 10min | 进度轮询；超 10min 标记 failed |
| 扫描版 PDF | 检测文本为空 → tesseract.js OCR（OCR 失败 → 提示教师提供文字版） |
| LLM 章节识别失败 | 降级为正则匹配目录 |
| 教师误传非教材 | 文件大小启发式（< 5MB 警告）+ 解析后章节数 < 3 警告 |
| 章节切分粒度过细 | 合并 < 500 字 的相邻章节 |
| 多本教材冲突 | VS Code 配置 `clineTeaching.currentTextbookId` 显式指定 |
| tesseract.js 80MB 拖累启动 | **动态 import**，仅在需要时加载 |