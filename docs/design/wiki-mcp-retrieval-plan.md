# Wiki 检索 MCP 化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把学生端的课程资料获取方式从「预注入全文」改为「LLM 经 MCP 自主检索」，消除 16k 截断问题，同时让教学进度边界不可被模型绕过。

**Architecture:** 插件侧新增一个本地 stdio MCP server（薄适配层：把 VS Code 配置的 `currentWeek` 注入请求并转发给教学后端）；后端新增三个带 SQL 级周数约束的检索端点；插件激活时自注册 MCP 配置（禁用可控、删除无效）；注入点从「全文」改为「认知边界约束 + 资料索引」。

**Tech Stack:** TypeScript / Express 5 + SQLite（teaching-server）/ `@modelcontextprotocol/sdk`（stdio server）/ esbuild（打包）/ mocha + chai（cline 单测）

**Spec:** `docs/design/wiki-mcp-retrieval-design.md`（648 行，本计划逐条对应其 §D1~§D7 与 §9 阶段）

---

## Global Constraints

以下约束来自 spec，**每个任务都隐含包含**：

- **教学周数**：`currentWeek ∈ [1, 18]`，越界一律 clamp 到 1（最保守，不泄露后续周内容）
- **资料 id 可能含斜杠**（如 `book_xxx/0`）→ **HTTP 端点必须用 query 参数传 id**，绝不放路径段（Express 的 `:id` 只匹配单个 segment，会 404）
- **MCP 工具 schema 不得包含任何周数参数**（L1 边界防线）
- **stdio MCP server 是独立进程**：用不了 `vscode` API，`currentWeek` / `serverUrl` 只能由插件通过启动参数注入
- **不做全量注入兜底**：MCP 不可用时走「失败可见」，绝不退回注入 16k 全文
- **禁用 = 尊重、删除 = 重建、篡改 command/args = 覆盖**
- **三个 MCP 工具全部只读**（`search_wiki` / `read_wiki_chunk` / `list_wiki_weeks`），无写入型工具
- **认知边界约束段必须保留**在注入内容中（不可随全文一起去掉）
- **默认端口**：teaching-server = `4001`

## 测试基础设施说明（重要）

| 仓库 | 现状 | 本计划的测试方式 |
|---|---|---|
| `d:\web-dashboard`（teaching-server） | **无测试框架**（package.json 无 test script、无 vitest/jest/mocha） | **脚本化验证** `teaching-server/scripts/verify-*.mjs`：内含断言，通过输出 `✅ n/n passed`，失败时 `process.exit(1)`。**不引入新测试框架**（遵循项目既有实践） |
| `d:\cline` | ✅ mocha + chai（`npm run test:unit`） | 纯逻辑用 mocha 单测（`src/core/teaching/__tests__/*.test.ts`）；跨进程/跨仓库的集成验证用脚本 |

**为什么 teaching-server 不引入 vitest**：该仓库从建立至今没有测试依赖，引入框架会带来 `pnpm-lock` 变更与 CI 配置改动，超出本改造范围。既有的"双向 E2E 脚本"实践已能覆盖本设计的所有验收点（边界、幂等、越界）。

## 文件结构

**`d:\web-dashboard`（teaching-server）**

| 文件 | 职责 |
|---|---|
| `src/server.ts`（改） | 新增 `GET /api/v1/wiki/search`、`/api/v1/wiki/chunk`、`/api/v1/wiki/weeks` |
| `src/wikiSearch.ts`（新） | 检索逻辑独立成模块：SQL 构造 + 关键词匹配 + 排序。**独立文件便于单测与复用** |
| `scripts/verify-wiki-search.mjs`（新） | 检索端点的脚本化验证（含边界与越界用例） |

**`d:\cline`**

| 文件 | 职责 |
|---|---|
| `src/core/teaching/mcp-wiki-server.ts`（新） | stdio MCP server 入口：参数解析 + 三个工具 + 后端调用。**独立进程，不依赖 vscode** |
| `src/core/teaching/mcp/wikiBackend.ts`（新） | 后端 REST 调用封装（纯函数，可 mocha 单测） |
| `src/core/teaching/mcp/args.ts`（新） | 启动参数解析（纯函数） |
| `src/core/teaching/WikiMcpRegistrar.ts`（新） | 配置自注册 + 周数重写 + 删除重建 + 禁用提示 |
| `src/core/teaching/wikiPrompt.ts`（新） | 生成「认知边界约束 + 资料索引 + 检索状态」文本（纯函数，可单测） |
| `src/core/task/index.ts`（改） | 注入点：MCP 可用时注入 `wikiPrompt` 而非全文 |
| `src/core/teaching/LLMWikiService.ts`（改） | 移除 `answerWithTools` / `_executeToolCall` / 全文拼接路径 |
| `esbuild.mjs`（改） | 新增 `mcp-wiki-server` 入口 |
| `src/extension.ts`（改） | 激活时调用 `ensureWikiMcpServer` + 注册禁用监听 |
| `package.json`（改） | `clineTeaching.llmEnableTools` 描述文案更新 |

**任务依赖顺序**：Task 0（spike，决定方案可行性）→ Task 1-2（后端）→ Task 3-4（MCP server）→ Task 5-6（注册与提示）→ Task 7-8（注入点与清理）→ Task 9（端到端）。

---

## Task 0: 技术可行性验证（Spike）— 决定方案是否成立

> **这是唯一的"可能推翻方案"的任务。** spec §10 列出 4 项待验证事项，其中第 1 项若不通过，整个方案需退回"远程 streamableHttp"路线（并回到设计阶段）。

**Files:**
- Create: `d:\cline\scripts\spike-mcp-stdio.mjs`（临时探针，Task 0 结束前删除）
- Create: `d:\cline\scripts\spike-read-mcp-settings.mjs`（临时探针）

**Interfaces:**
- Produces: 一份**验证结论**（写入本任务末尾的"验证记录"），供后续任务引用；若失败则**停止执行本计划**

- [x] **Step 1: 写最小 stdio MCP server 探针**

创建 `d:\cline\scripts\spike-mcp-stdio.mjs`：

```js
// 最小 MCP stdio server：只暴露一个 ping 工具，用于验证 spawn 链路
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "spike", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ping",
      description: "returns pong",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: `pong:${req.params.name}` }],
}));

await server.connect(new StdioServerTransport());
```

- [x] **Step 2: 验证该探针能独立启动并完成握手**

Run:
```powershell
cd d:\cline
$msg = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
$msg | node --input-type=module -e "import('./scripts/spike-mcp-stdio.mjs')" 2>&1 | Select-Object -First 5
```
Expected: 输出中包含 `"protocolVersion"` 与 `"serverInfo"` 的 JSON-RPC 响应（说明 server 能起来并响应 initialize）。

> 若此步失败，说明 `@modelcontextprotocol/sdk` 的 server 端路径或版本不兼容 —— 先修正 import 路径再继续。

- [x] **Step 3: 在真实 VS Code 里验证 Cline 能用 `process.execPath` spawn 该 server**

手工在 `cline_mcp_settings.json` 中追加（路径按实际 `globalStorage` 填写）：

```json
{
  "mcpServers": {
    "spike": {
      "type": "stdio",
      "command": "<process.execPath 的实际值>",
      "args": ["d:/cline/scripts/spike-mcp-stdio.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" },
      "autoApprove": ["ping"],
      "timeout": 30
    }
  }
}
```

获取 `process.execPath` 的办法：在 VS Code 的扩展宿主控制台执行 `process.execPath`（或用命令面板 → `Developer: Open Process Explorer` 查看进程路径）。

Expected: VS Code 的 MCP 面板中 `spike` 显示为 **Connected**，且 `ping` 工具出现在工具列表中。

> ⚠️ 若显示 Failed / 无法连接 → **停止本计划**，回到 spec §8 首行的缓解措施（改用远程 streamableHttp + 把 week 放进配置 URL）。

- [x] **Step 4: 验证写入 MCP 配置后 McpHub 是否自动重载**

在 VS Code 已打开的情况下，用脚本向 `cline_mcp_settings.json` 写入一个新的 server 条目。

创建 `d:\cline\scripts\spike-read-mcp-settings.mjs`：

```js
// 打印 MCP 配置文件路径与内容，用于确认写入位置
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const candidates = [
  path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
  path.join(os.homedir(), "AppData", "Roaming", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "cline_mcp_settings.json"),
];

for (const p of candidates) {
  console.log(fs.existsSync(p) ? `FOUND ${p}` : `MISS  ${p}`);
  if (fs.existsSync(p)) console.log(fs.readFileSync(p, "utf8").slice(0, 600));
}
```

Run: `node d:\cline\scripts\spike-read-mcp-settings.mjs`

Expected: 输出实际路径（`FOUND ...`）。**记录该路径**，Task 5 需要用它校准 `getMcpSettingsFilePath(settingsDirectoryPath)` 的入参。

- [x] **Step 5: 在文件已被 VS Code 打开时，用外部写入触发重载**

用 PowerShell 向该 JSON 追加一个新条目（保持其它内容不变），然后观察 VS Code MCP 面板。

Expected（两种情况都要记录）：
- **A**：面板自动出现新 server → 无需手动重载
- **B**：面板无变化 → Task 5 必须在写入后显式触发重载（`McpHub` 的相关方法）

- [x] **Step 6: 记录验证结论并清理探针**

### Task 0 验证记录（2026-09-29 实测）

- **探针能独立握手：是** ✅
  - 用 `node.exe` 与 `Code.exe` 两种运行时各跑一遍完整握手，均返回：
    `initialize` → `{"protocolVersion":"2024-11-05","serverInfo":{"name":"spike","version":"0.0.1"}}`
    `tools/list` → 列出 `ping`
    `tools/call` → `{"content":[{"type":"text","text":"pong:ping"}]}`
- **Cline 能用 process.execPath spawn：是** ✅
  - `process.execPath` 实际值：`C:\Users\Kirara\AppData\Local\Programs\Microsoft VS Code\Code.exe`
  - 用 `child_process.spawn(execPath, [script], { env: { ELECTRON_RUN_AS_NODE: "1" } })`（与 `StdioClientTransport` 同路径）验证：子进程成功启动，`process.execPath` 回读即为 `Code.exe`，握手全通。
  - **子运行时能力**：Node `24.20.0` / Electron `43.6.0` / Chrome `150.0.7871.250`；`typeof fetch === "function"` ✅；`typeof AbortSignal.timeout === "function"` ✅；`node:fs` 可用 ✅。
    → 结论：**MCP server 可以直接用全局 `fetch` 调教学后端，无需引入 axios/undici**。
- **McpHub 写入后自动重载：是（源码级确认 + 需注意两点）**
  - `McpHub.watchMcpSettingsFile()` 用 `chokidar` 监听配置文件，参数 `ignoreInitial: true`、`awaitWriteFinish.stabilityThreshold = 100ms`、`atomic: true`；`on("change")` → `updateServerConnections()`。
  - **注意 1**：`isUpdatingClineSettings` / `isUpdatingFromRemoteConfig` 为真时会被跳过。这两个标志**只在 Cline 自己改 autoApprove / timeout / disabled 时**被置位（`McpHub.ts` L1205 / L1258 / L1403）。
    → Task 5 的自注册**只写文件、不调 McpHub API**，就不会命中跳过分支，重载由 watcher 自动完成。
  - **注意 2**：`configsRequireRestart()` 的比较**排除** `autoApprove` 与 `timeout`，其余（含 `args` / `command` / `env` / `disabled`）变化都会触发「删连接 + 重新 spawn」。
    → 切换周数（改 `args`）等同于一次完整重启，重启窗口内该 server 不可用；Task 6/9 必须按「失败可见」处理，不得回退全文注入。
- **MCP 配置文件实际路径**：
  `C:\Users\Kirara\AppData\Roaming\Code\User\globalStorage\shiinamatsuri.student-teaching-assistant-edu\settings\cline_mcp_settings.json`
  - **关键修正**：目录名是**发布后的扩展 ID**（`shiinamatsuri.student-teaching-assistant-edu`），不是上游的 `saoudrizwan.claude-dev`。
  - `getMcpSettingsFilePath(settingsDirectoryPath)` 的入参必须传 `context.globalStorageUri.fsPath`（即上面的扩展 globalStorage 根），函数内部会拼 `settings/` 子目录。**不可硬编码 `saoudrizwan.claude-dev`。**
- **结论：继续本计划（不退回远程 streamableHttp）** ✅

**遗留说明**：本次验证时该扩展未安装在当前 VS Code profile（`~/.vscode/extensions` 下无 `shiinamatsuri.*`），因此无法在真实 Cline 面板里观察 spawn；改用「同一条 spawn 代码路径 + 自验证探针（子进程写标记文件与请求日志）」完成等价验证。

Run: `Remove-Item d:\cline\scripts\spike-*.mjs`（已执行，另含 `spike-run.ps1` / `spike-runtime.mjs`）

- [x] **Step 7: Commit**

```bash
cd d:\cline
git add docs/design/wiki-mcp-retrieval-plan.md
git commit -m "docs(plan): add MCP retrieval implementation plan with spike results"
```

---

## Task 1: teaching-server — 检索逻辑模块与 search 端点

**Files:**
- Create: `d:\web-dashboard\teaching-server\src\wikiSearch.ts`
- Modify: `d:\web-dashboard\teaching-server\src\server.ts`（在 `GET /api/v1/teacher/wiki/list` 之后插入新端点）
- Test: `d:\web-dashboard\teaching-server\scripts\verify-wiki-search.mjs`

**Interfaces:**
- Consumes: `Database`（sqlite 包的 `open()` 返回类型）、`wiki_chunks` 表
- Produces:
  - `clampWeek(n: unknown): number` → 1~18 的整数，非法值返回 1
  - `searchWiki(db: Database, opts: { week: number; q: string; limit: number }): Promise<WikiSearchHit[]>`
  - `WikiSearchHit = { id: string; title: string; applicable_week: number; chunk_index: number; snippet: string }`

- [x] **Step 1: 写验证脚本（先失败）**

创建 `d:\web-dashboard\teaching-server\scripts\verify-wiki-search.mjs`：

```js
/**
 * 检索端点验证脚本（脚本化断言，不引入测试框架）
 * 用法：DB_PATH=... BASE_URL=http://localhost:4001 node scripts/verify-wiki-search.mjs
 */
const BASE = process.env.BASE_URL || "http://localhost:4001";
let pass = 0;
let fail = 0;

function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* 非 JSON（如 Express 默认 404 HTML） */
  }
  return { status: r.status, body };
}

console.log(`\n=== verify-wiki-search @ ${BASE} ===\n`);

// ---- 1) 参数校验：week 越界一律 400，且不查库 ----
{
  const cases = [0, 19, -1, "abc"];
  for (const w of cases) {
    const { status } = await get(`/api/v1/wiki/search?week=${encodeURIComponent(String(w))}&q=test`);
    check(`week=${w} → 400`, status === 400, `实际 ${status}`);
  }
}

// ---- 2) 正常检索 ----
{
  const { status, body } = await get(`/api/v1/wiki/search?week=5&q=print&limit=5`);
  check("week=5 检索 → 200", status === 200, `实际 ${status}`);
  check("返回 ok:true", body?.ok === true);
  check("返回数组 data", Array.isArray(body?.data));
  check(
    "每条命中都带 applicable_week",
    Array.isArray(body?.data) && body.data.every((d) => typeof d.applicable_week === "number"),
  );
}

// ---- 3) ★ 边界：week=3 时不得出现第 4 周及以后的资料 ----
{
  const { body } = await get(`/api/v1/wiki/search?week=3&q=`);
  check("空 q 仍可列出（作为浏览）", Array.isArray(body?.data));
}

// ---- 4) ★ 边界：限定 week 后结果不越界 ----
{
  const { body } = await get(`/api/v1/wiki/search?week=3&q=print&limit=10`);
  const over = (body?.data ?? []).filter((d) => d.applicable_week > 3);
  check("week=3 的结果无越过第 3 周的条目", over.length === 0, `越界 ${over.length} 条`);
}

// ---- 5) limit clamp 到 [1,10] ----
{
  const { body } = await get(`/api/v1/wiki/search?week=18&q=a&limit=999`);
  check("limit=999 被 clamp（结果 ≤ 10）", (body?.data ?? []).length <= 10);
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
```

- [x] **Step 2: 跑脚本确认失败**

Run:
```powershell
cd d:\web-dashboard\teaching-server
$env:BASE_URL="http://127.0.0.1:4001"; node scripts\verify-wiki-search.mjs
```
Expected: 多项 `❌`（端点尚不存在，返回 404），最后 `exit code 1`。
实测：`2 passed, 9 failed`（9 项均为 404；2 项"通过"是因为响应体为 null 时空数组断言恒真 —— 属预期的空跑通过）。

- [x] **Step 3: 实现检索模块**

创建 `d:\web-dashboard\teaching-server\src\wikiSearch.ts`：

```ts
/**
 * Wiki 检索逻辑（v2.13）
 *
 * 设计要点（见 docs/design/wiki-mcp-retrieval-design.md §D4）：
 *   - 候选集由 applicable_week 硬约束（教学边界，SQL 层强制）
 *   - 无向量化：关键词匹配 + 结构化排序
 *   - 排序：标题命中优先 → 更近周优先 → chunk 序
 */
import type { Database } from "sqlite";

/** 周数收紧到 [1,18]；非法值一律回退 1（最保守，不泄露后续周内容） */
export function clampWeek(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 1;
  const i = Math.floor(v);
  if (i < 1) return 1;
  if (i > 18) return 18;
  return i;
}

/** limit 收紧到 [1,10]，默认 5 */
export function clampLimit(n: unknown): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 5;
  const i = Math.floor(v);
  if (i < 1) return 1;
  if (i > 10) return 10;
  return i;
}

export interface WikiSearchHit {
  id: string;
  title: string;
  applicable_week: number;
  chunk_index: number;
  snippet: string;
}

const SNIPPET_CHARS = 200;

/**
 * 检索 wiki 资料。
 * @param week 当前教学周（1~18），结果严格限制在 <= week
 * @param q    关键词；为空时退化为"浏览"（按周数倒序取该周之前的资料）
 */
export async function searchWiki(
  db: Database,
  opts: { week: number; q: string; limit: number },
): Promise<WikiSearchHit[]> {
  const { week, limit } = opts;
  const q = opts.q.trim();

  if (q.length === 0) {
    // 空关键词：浏览模式
    return db.all<WikiSearchHit[]>(
      `SELECT id, title, applicable_week, chunk_index, substr(content, 1, ${SNIPPET_CHARS}) AS snippet
         FROM wiki_chunks
        WHERE applicable_week <= ?
        ORDER BY applicable_week DESC, chunk_index ASC
        LIMIT ?`,
      week,
      limit,
    );
  }

  const like = `%${q}%`;
  return db.all<WikiSearchHit[]>(
    `SELECT id, title, applicable_week, chunk_index, substr(content, 1, ${SNIPPET_CHARS}) AS snippet
       FROM wiki_chunks
      WHERE applicable_week <= ?
        AND (title LIKE ? OR content LIKE ?)
      ORDER BY (title LIKE ?) DESC,
               applicable_week DESC,
               chunk_index ASC
      LIMIT ?`,
    week,
    like,
    like,
    like,
    limit,
  );
}
```

- [x] **Step 4: 在 server.ts 注册 search 端点**

在 `d:\web-dashboard\teaching-server\src\server.ts` 中，找到 `app.get("/api/v1/wiki", ...)`（学生端拉取资料）**之前**插入：

```ts
  /**
   * GET /api/v1/wiki/search?week=N&q=关键词&limit=5
   * 【v2.13】供学生端 MCP blog 检索使用（见 docs/design/wiki-mcp-retrieval-design.md §5.2）
   *
   * 教学边界说明：
   *   week 由调用方（本地 MCP server）从 VS Code 配置注入，**不接受模型指定**。
   *   服务端将 week 直接用于 SQL 的 applicable_week <= ? —— 这是 L3 边界防线。
   */
  app.get("/api/v1/wiki/search", async (req: Request, res: Response): Promise<void> => {
    try {
      const rawWeek = req.query.week;
      const weekNum = Number(rawWeek);
      // 严格校验：越界/非法一律 400（不查库、不 clamp —— 与模型无关，只防调用方传错）
      if (!Number.isFinite(weekNum) || weekNum < 1 || weekNum > 18) {
        res.status(400).json({ ok: false, message: "week 必须是 1~18 的整数" });
        return;
      }
      const week = clampWeek(weekNum);
      const q = String(req.query.q ?? "").slice(0, 200);
      const limit = clampLimit(req.query.limit);

      const data = await searchWiki(db, { week, q, limit });
      res.json({ ok: true, week, count: data.length, data });
    } catch (error) {
      console.error("❌ wiki 检索失败:", error);
      res.status(500).json({ ok: false, message: "服务器内部错误" });
    }
  });
```

并在文件顶部 import 区加入：

```ts
import { clampLimit, clampWeek, searchWiki } from "./wikiSearch";
```

> ⚠️ teaching-server 的 import 未带 `.js` 扩展名（项目既有写法，`tsx` 运行时容忍）。**保持与既有 import 一致的风格**。

- [x] **Step 5: 跑验证脚本确认通过**

Run:
```powershell
cd d:\web-dashboard\teaching-server
npx tsc --noEmit --pretty false 2>&1 | Select-Object -Last 5
# 启动服务（另开终端）：npm run dev
$env:BASE_URL="http://127.0.0.1:4001"; node scripts\verify-wiki-search.mjs
```
Expected: `✅ 全部通过`，`=== N passed, 0 failed ===`，exit code 0。

- [x] **Step 6: Commit**

```bash
cd d:\web-dashboard
git add teaching-server/src/wikiSearch.ts teaching-server/src/server.ts teaching-server/scripts/verify-wiki-search.mjs
git commit -m "feat(wiki): add search endpoint with SQL-enforced week boundary"
```

### Task 1 验证记录（2026-09-29 实测）

- **红灯→绿灯**：实现前 `2 passed, 9 failed`（均为 404）→ 实现后 `11 passed, 0 failed`，exit 0。
- **边界非空跑证明**（这是本任务最关键的一点）：
  | 请求 | 返回条数 | 实际 `applicable_week` |
  |---|---|---|
  | `week=1&q=` | 5 | 均 1 |
  | `week=2&q=` | 10 | {2,1} |
  | `week=4&q=` | 10 | {4,2} |
  | `week=3&q=Git` | **2** | 均 2 |
  | `week=18&q=Git` | **10** | 18×9 + 15 |
  同一关键词在不同 week 下结果集不同，且严格满足 `applicable_week <= week` → SQL 级周数边界在真实数据（149 行）上生效。
- **⚠️ 必要偏差 1 —— 验证脚本不能用 `process.exit()`**：
  Node 24 + Windows 下，`fetch` 的 keep-alive socket 未收敛时调 `process.exit()` 会触发 libuv 断言崩溃
  （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`），
  退出码变成 `-1073740791`，使脚本无法作为 CI 信号。
  → 改用 `process.exitCode = fail === 0 ? 0 : 1`，让事件循环自然退出。**退出码语义不变**（失败仍为 1），已实测 exit 0。
- **⚠️ 必要偏差 2 —— `tsc --noEmit` 是既有红灯**：
  仓库基线就有 `officeParser.js` / `llmHelper.js` / `pdf-parse` / `pptx-parser` / `Mammoth` / 若干 implicit-any 错误。
  本次新增的 `import "./wikiSearch"` 会产生同类 TS2835（与既有 4 条 import 完全同型）。
  **不修复**：`deploy/Dockerfile.teaching-server` 的生产启动命令是 `npx tsx src/server.ts`（tsx 容忍无扩展名 import），
  `tsc` 不在构建链路里 → 无回归。`wikiSearch.ts` 自身 0 错误。
- **提交纪律**：发现工作区遗留了上一轮未提交的 v2.12 修复（同在 `server.ts`）。
  已将两者拆分为两个准确提交，未丢弃任何代码：
  - `0ab1581` `fix(wiki): v2.12 资料删除/重清洗改走 query 参数…`（260+/118-）
  - `94dfe9c` `feat(wiki): add search endpoint with SQL-enforced week boundary`（188+/0-）
  `CHANGELOG.md` / `deploy/*` / `frontend/*` / `cleanup-orphan-wiki.mjs` 仍保持未提交状态（留给用户处置）。

---

## Task 2: teaching-server — chunk 与 weeks 端点

**Files:**
- Modify: `d:\web-dashboard\teaching-server\src\wikiSearch.ts`（加 `getChunk`、`listWeeks`）
- Modify: `d:\web-dashboard\teaching-server\src\server.ts`
- Test: `d:\web-dashboard\teaching-server\scripts\verify-wiki-search.mjs`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `clampWeek`
- Produces:
  - `getChunk(db, { chunkId, week }): Promise<WikiChunkFull | null>` —— **越界返回 null**（视为不存在）
  - `listWeeks(db, { week }): Promise<Array<{ week: number; count: number }>>`

- [x] **Step 1: 追加验证用例（先失败）**

在 `verify-wiki-search.mjs` 的 `console.log(... passed ...)` 之前追加：

```js
// ---- 6) chunk 端点：含斜杠 id 必须可用（query 参数形式） ----
{
  // 先取一条真实 id 用于测试
  const list = await get(`/api/v1/wiki/search?week=18&q=&limit=1`);
  const sample = list.body?.data?.[0];

  if (!sample) {
    check("存在可用于测试的资料", false, "库中无资料，跳过 chunk 用例");
  } else {
    const enc = encodeURIComponent(sample.id);
    const { status, body } = await get(`/api/v1/wiki/chunk?chunk_id=${enc}&week=18`);
    check(`chunk 端点可取到 ${sample.id}`, status === 200 && body?.ok === true, `实际 ${status}`);

    // ★ 越界：用比该 chunk 更小的 week 请求，必须取不到
    if (sample.applicable_week > 1) {
      const lower = sample.applicable_week - 1;
      const r2 = await get(`/api/v1/wiki/chunk?chunk_id=${enc}&week=${lower}`);
      check(
        `week=${lower} 时取不到第 ${sample.applicable_week} 周的 chunk`,
        r2.status === 404,
        `实际 ${r2.status}`,
      );
    }
  }

  const bad = await get(`/api/v1/wiki/chunk?chunk_id=__not_exist__&week=5`);
  check("不存在的 chunk → 404", bad.status === 404, `实际 ${bad.status}`);
}

// ---- 7) weeks 端点 ----
{
  const { status, body } = await get(`/api/v1/wiki/weeks?week=5`);
  check("weeks 端点 → 200", status === 200, `实际 ${status}`);
  check("weeks 是数组", Array.isArray(body?.data));
  const over = (body?.data ?? []).filter((w) => w.week > 5);
  check("weeks 不返回超过当前周的周数", over.length === 0);
}
```

- [x] **Step 2: 跑脚本确认失败**

Run: `node scripts\verify-wiki-search.mjs`
Expected: chunk / weeks 用例报 `❌`（404），其余通过。
实测：`14 passed, 3 failed`（chunk 200、weeks 200、weeks 数组 三项 ❌）。
⚠️ 此时“week=17 取不到第 18 周 chunk”是**空跑通过**（404 因为端点不存在）—— 必须在 Step 5 后确认它变为“因边界而 404”。

- [x] **Step 3: 实现两个查询函数**

在 `wikiSearch.ts` 末尾追加：

```ts
export interface WikiChunkFull {
  id: string;
  title: string;
  content: string;
  applicable_week: number;
  chunk_index: number;
  chunk_total: number;
}

/**
 * 读取单个 chunk 全文。
 * 【边界】越界时返回 null（对外表现为 404）—— 不区分"不存在"与"越界"，
 * 避免通过错误信息泄露"某周存在哪些资料"。
 */
export async function getChunk(
  db: Database,
  opts: { chunkId: string; week: number },
): Promise<WikiChunkFull | null> {
  const row = await db.get<WikiChunkFull>(
    `SELECT id, title, content, applicable_week, chunk_index, chunk_total
       FROM wiki_chunks
      WHERE id = ? AND applicable_week <= ?`,
    opts.chunkId,
    opts.week,
  );
  return row ?? null;
}

/** 列出 <= week 的各周资料数（仅计数，不返回内容） */
export async function listWeeks(
  db: Database,
  opts: { week: number },
): Promise<Array<{ week: number; count: number }>> {
  return db.all<Array<{ week: number; count: number }>>(
    `SELECT applicable_week AS week, COUNT(*) AS count
       FROM wiki_chunks
      WHERE applicable_week <= ?
      GROUP BY applicable_week
      ORDER BY applicable_week ASC`,
    opts.week,
  );
}
```

- [x] **Step 4: 在 server.ts 注册两个端点**

在 Task 1 新增的 `/api/v1/wiki/search` 之后插入：

```ts
  /**
   * GET /api/v1/wiki/chunk?chunk_id=<id>&week=N
   * 【v2.13】读取单个 chunk 全文。
   * ⚠️ id 必须走 query：资料 id 可能含斜杠（如 book_xxx/0），
   *    放进路径段会被 Express 的 :id 当成多段而 404（同 DELETE /api/v1/teacher/wiki?id= 的处理）。
   */
  app.get("/api/v1/wiki/chunk", async (req: Request, res: Response): Promise<void> => {
    try {
      const weekNum = Number(req.query.week);
      if (!Number.isFinite(weekNum) || weekNum < 1 || weekNum > 18) {
        res.status(400).json({ ok: false, message: "week 必须是 1~18 的整数" });
        return;
      }
      const chunkId = String(req.query.chunk_id ?? "");
      if (!chunkId) {
        res.status(400).json({ ok: false, message: "缺少 chunk_id 参数" });
        return;
      }
      const data = await getChunk(db, { chunkId, week: clampWeek(weekNum) });
      if (!data) {
        res.status(404).json({ ok: false, reason: "not_found_or_out_of_scope", message: "资料不存在或尚未在当前教学进度内发布" });
        return;
      }
      res.json({ ok: true, data });
    } catch (error) {
      console.error("❌ 读取 chunk 失败:", error);
      res.status(500).json({ ok: false, message: "服务器内部错误" });
    }
  });

  /**
   * GET /api/v1/wiki/weeks?week=N
   * 【v2.13】列出当前可访问的教学周及资料数量（供 MCP list_wiki_weeks 工具使用）
   */
  app.get("/api/v1/wiki/weeks", async (req: Request, res: Response): Promise<void> => {
    try {
      const weekNum = Number(req.query.week);
      if (!Number.isFinite(weekNum) || weekNum < 1 || weekNum > 18) {
        res.status(400).json({ ok: false, message: "week 必须是 1~18 的整数" });
        return;
      }
      const data = await listWeeks(db, { week: clampWeek(weekNum) });
      res.json({ ok: true, week: clampWeek(weekNum), count: data.length, data });
    } catch (error) {
      console.error("❌ 列出周数失败:", error);
      res.status(500).json({ ok: false, message: "服务器内部错误" });
    }
  });
```

更新 import：

```ts
import { clampLimit, clampWeek, getChunk, listWeeks, searchWiki } from "./wikiSearch";
```

- [x] **Step 5: 跑完整验证确认通过**

Run:
```powershell
cd d:\web-dashboard\teaching-server
npx tsc --noEmit --pretty false 2>&1 | Select-Object -Last 5
$env:BASE_URL="http://127.0.0.1:4001"; node scripts\verify-wiki-search.mjs
```
Expected: 全部 `✅`，`0 failed`，exit code 0。

- [x] **Step 6: Commit**

```bash
cd d:\web-dashboard
git add teaching-server/src/wikiSearch.ts teaching-server/src/server.ts teaching-server/scripts/verify-wiki-search.mjs
git commit -m "feat(wiki): add chunk and weeks retrieval endpoints"
```

### Task 2 验证记录（2026-09-29 实测）

`17 passed, 0 failed`，exit 0（红灯阶段为 `14 passed, 3 failed`）。

**关键边界非空跑证明**（同一含斜杠 id，只改 week）：

| 请求 | status | ok | content 长度 |
|---|---|---|---|
| `chunk?chunk_id=textbook_python/27__chunk0&week=18` | 200 | true | 2706 |
| `chunk?chunk_id=textbook_python/27__chunk0&week=17` | 404 | false | — |

→ 证明两件事：(1) **含斜杠 id 走 query 参数可用**（这是 Task 1 踩过的 404 根因，此处重测确认）；
(2) 越界返回 404 是**真由 `applicable_week <= ?` 产生**，不是端点缺失造成的假通过。

**参数校验**：`week=0` / `week=abc` / 缺 `chunk_id` → 全 400。

**weeks 输出**（仅计数，无内容）：
- `week=1` → `[{week:1,count:5}]`
- `week=5` → `[{1,5},{2,7},{4,5},{5,3}]`
- `week=18` → 13 个周，最大为 18 → 从不返回超过当前周的条目

**类型检查**：`wikiSearch.ts` 自身 0 错误；新增 1 条与既有 3 条完全同型的 TS2835（仓库基线 10 → 11，均为历史遗留）。

**提交**：`8629037` `feat(wiki): add chunk and weeks retrieval endpoints`（135+/1-）。

---

## Task 3: MCP server 骨架 — 参数解析 + 握手 + 打包入口

**Files:**
- Create: `d:\cline\src\core\teaching\mcp\args.ts`
- Create: `d:\cline\src\core\teaching\mcp-wiki-server.ts`
- Create: `d:\cline\src\core\teaching\mcp\__tests__\args.test.ts`
- Modify: `d:\cline\esbuild.mjs`

**Interfaces:**
- Produces:
  - `parseMcpArgs(argv: string[]): { week: number; serverUrl: string }`
  - `clampWeek(n: unknown): number`
  - 可执行产物：`dist/mcp-wiki-server.js`

- [ ] **Step 1: 写 args 单测（先失败）**

创建 `d:\cline\src\core\teaching\mcp\__tests__\args.test.ts`：

```ts
import { expect } from "chai"
import { clampWeek, parseMcpArgs } from "../args"

describe("parseMcpArgs", () => {
	it("解析 --week 与 --server", () => {
		const r = parseMcpArgs(["node", "srv.js", "--week", "7", "--server", "http://localhost:4001"])
		expect(r.week).to.equal(7)
		expect(r.serverUrl).to.equal("http://localhost:4001")
	})

	it("缺少参数时回退为保守值", () => {
		const r = parseMcpArgs(["node", "srv.js"])
		expect(r.week).to.equal(1)
		expect(r.serverUrl).to.equal("")
	})

	it("week 越界被 clamp", () => {
		expect(parseMcpArgs(["--week", "99", "--server", "x"]).week).to.equal(18)
		expect(parseMcpArgs(["--week", "0", "--server", "x"]).week).to.equal(1)
		expect(parseMcpArgs(["--week", "abc", "--server", "x"]).week).to.equal(1)
	})

	it("serverUrl 去掉结尾斜杠", () => {
		expect(parseMcpArgs(["--server", "http://a:4001/"]).serverUrl).to.equal("http://a:4001")
	})
})

describe("clampWeek", () => {
	it("收紧到 [1,18]", () => {
		expect(clampWeek(5)).to.equal(5)
		expect(clampWeek(0)).to.equal(1)
		expect(clampWeek(19)).to.equal(18)
		expect(clampWeek("x")).to.equal(1)
	})
})
```

- [ ] **Step 2: 跑单测确认失败**

Run:
```powershell
cd d:\cline
npm run test:unit -- --grep "parseMcpArgs" 2>&1 | Select-Object -Last 20
```
Expected: 失败并报 `Cannot find module '../args'`。

- [ ] **Step 3: 实现 args.ts**

创建 `d:\cline\src\core\teaching\mcp\args.ts`：

```ts
/**
 * MCP server 启动参数解析（v2.13）
 *
 * 为什么周数要经启动参数传入：
 *   stdio MCP server 是**独立进程**，进程内没有 vscode 模块，
 *   读不到 clineTeaching.currentWeek。只能由插件在 spawn 时注入。
 *   好处是"当前周"这个权威值始终在模型进程之外传递（见 spec §D1）。
 */

/** 周数收紧到 [1,18]；非法值回退 1（最保守，不泄露后续周内容） */
export function clampWeek(n: unknown): number {
	const v = Number(n)
	if (!Number.isFinite(v)) return 1
	const i = Math.floor(v)
	if (i < 1) return 1
	if (i > 18) return 18
	return i
}

export interface McpArgs {
	week: number
	serverUrl: string
}

export function parseMcpArgs(argv: string[]): McpArgs {
	let week = 1
	let serverUrl = ""

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]
		if (a === "--week") {
			week = clampWeek(argv[i + 1])
			i++
		} else if (a === "--server") {
			const raw = String(argv[i + 1] ?? "").trim()
			serverUrl = raw.endsWith("/") ? raw.slice(0, -1) : raw
			i++
		}
	}

	return { week, serverUrl }
}
```

- [ ] **Step 4: 跑单测确认通过**

Run: `npm run test:unit -- --grep "parseMcpArgs" 2>&1 | Select-Object -Last 20`
Expected: `4 passing`。

- [ ] **Step 5: 实现 MCP server 骨架**

创建 `d:\cline\src\core\teaching\mcp-wiki-server.ts`：

```ts
/**
 * wiki-mcp-server — 课程资料检索的 MCP server（stdio）（v2.13）
 *
 * 职责（单一）：把插件注入的 currentWeek 拼到检索请求上，转发给教学后端。
 * 它**不做**回答生成、**不做**边界判定（边界由后端 SQL 强制）。
 *
 * 启动：node dist/mcp-wiki-server.js --week 5 --server http://host:4001
 * 设计文档：docs/design/wiki-mcp-retrieval-design.md
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { parseMcpArgs } from "./mcp/args"
import { callListWeeks, callReadChunk, callSearchWiki } from "./mcp/wikiBackend"

const { week, serverUrl } = parseMcpArgs(process.argv.slice(2))

const server = new Server(
	{ name: "wiki", version: "1.0.0" },
	{ capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
	tools: [
		{
			name: "search_wiki",
			description:
				"在课程资料库中按关键词检索。只返回当前教学周之前（含）已发布的资料。若返回 0 条，说明该知识点尚未在当前教学进度内发布 —— 此时不要展开讲解其具体用法，应告知其所属周次并给出当前进度内的相关基础。",
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "检索关键词，如 '列表' '函数'" },
					limit: { type: "number", description: "最多返回条数，默认 5，最大 10" },
				},
				required: ["query"],
			},
		},
		{
			name: "read_wiki_chunk",
			description: "读取某个资料块的完整内容。仅当该资料在当前教学周或更早发布时才可读取。",
			inputSchema: {
				type: "object",
				properties: { chunk_id: { type: "string", description: "search_wiki 返回的 id" } },
				required: ["chunk_id"],
			},
		},
		{
			name: "list_wiki_weeks",
			description: "列出当前可访问的教学周及其资料数量。",
			inputSchema: { type: "object", properties: {} },
		},
	],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
	const name = req.params.name
	const args = (req.params.arguments ?? {}) as Record<string, unknown>

	try {
		if (!serverUrl) {
			return { content: [{ type: "text", text: JSON.stringify({ error: "wiki_backend_not_configured" }) }] }
		}
		if (name === "search_wiki") {
			const r = await callSearchWiki(serverUrl, week, String(args.query ?? ""), Number(args.limit ?? 5))
			return { content: [{ type: "text", text: JSON.stringify(r) }] }
		}
		if (name === "read_wiki_chunk") {
			const r = await callReadChunk(serverUrl, week, String(args.chunk_id ?? ""))
			return { content: [{ type: "text", text: JSON.stringify(r) }] }
		}
		if (name === "list_wiki_weeks") {
			const r = await callListWeeks(serverUrl, week)
			return { content: [{ type: "text", text: JSON.stringify(r) }] }
		}
		return { content: [{ type: "text", text: JSON.stringify({ error: `unknown_tool: ${name}` }) }] }
	} catch (e) {
		// 工具失败不得中断学生对话：返回结构化错误，模型可继续作答
		return {
			content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }],
		}
	}
})

await server.connect(new StdioServerTransport())
```

> **注意**：三个工具的 `inputSchema` 中**没有任何周数字段** —— 这就是 spec §3.3 的 L1 边界防线。

- [ ] **Step 6: 实现 backend 调用封装（Task 4 会补全细节，此处先让骨架可编译）**

创建 `d:\cline\src\core\teaching\mcp\wikiBackend.ts`：

```ts
/** 教学后端 REST 调用封装（纯函数，便于单测） */

const TIMEOUT_MS = 5_000

async function getJson(url: string): Promise<unknown> {
	const ctrl = new AbortController()
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
	try {
		const resp = await fetch(url, { signal: ctrl.signal })
		const text = await resp.text()
		if (!resp.ok) {
			return { error: `http_${resp.status}`, detail: text.slice(0, 200) }
		}
		return JSON.parse(text)
	} catch (e) {
		return { error: "wiki_backend_unreachable", detail: e instanceof Error ? e.message : String(e) }
	} finally {
		clearTimeout(timer)
	}
}

export async function callSearchWiki(serverUrl: string, week: number, query: string, limit: number) {
	const q = encodeURIComponent(query.slice(0, 200))
	const lim = Math.min(Math.max(Math.floor(limit) || 5, 1), 10)
	return getJson(`${serverUrl}/api/v1/wiki/search?week=${week}&q=${q}&limit=${lim}`)
}

export async function callReadChunk(serverUrl: string, week: number, chunkId: string) {
	return getJson(`${serverUrl}/api/v1/wiki/chunk?chunk_id=${encodeURIComponent(chunkId)}&week=${week}`)
}

export async function callListWeeks(serverUrl: string, week: number) {
	return getJson(`${serverUrl}/api/v1/wiki/weeks?week=${week}`)
}
```

- [ ] **Step 7: 在 esbuild.mjs 增加 MCP server 入口**

打开 `d:\cline\esbuild.mjs`，找到 `entryPoints: [...]`（或等价的 entry 定义），在数组中**追加**一项：

```js
"src/core/teaching/mcp-wiki-server.ts",
```

并在构建输出里确认产物名为 `dist/mcp-wiki-server.js`（若 esbuild 配置用 `outdir` 则文件名自动由 entry 决定）。

- [ ] **Step 8: 构建并验证产物能启动 + 握手**

Run:
```powershell
cd d:\cline
node esbuild.mjs
Test-Path .\dist\mcp-wiki-server.js
# 手工握手验证（initialize + tools/list）
$init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
$listed = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
($init + "`n" + $listed) | node .\dist\mcp-wiki-server.js --week 5 --server http://127.0.0.1:4001
```
Expected: 输出两段 JSON，第二段包含 `search_wiki` / `read_wiki_chunk` / `list_wiki_weeks` 三个工具定义。

- [ ] **Step 9: 跑单测确认无回归**

Run: `npm run test:unit -- --grep "parseMcpArgs"`
Expected: `4 passing`。

- [ ] **Step 10: Commit**

```bash
cd d:\cline
git add src/core/teaching/mcp-wiki-server.ts src/core/teaching/mcp/args.ts src/core/teaching/mcp/wikiBackend.ts src/core/teaching/mcp/__tests__/args.test.ts esbuild.mjs
git commit -m "feat(mcp): add wiki stdio MCP server with three read-only tools"
```

---

## Task 4: MCP server 工具的后端联调与错误处理

**Files:**
- Modify: `d:\cline\src\core\teaching\mcp\wikiBackend.ts`（如需微调）
- Create: `d:\cline\scripts\verify-mcp-wiki-server.mjs`

**Interfaces:**
- Consumes: Task 3 的 `dist/mcp-wiki-server.js`；Task 1/2 的后端端点
- Produces: 验证结论 —— 三个工具在真实后端上各自返回预期结构

- [ ] **Step 1: 写 MCP 端到端验证脚本（先失败）**

创建 `d:\cline\scripts\verify-mcp-wiki-server.mjs`：

```js
/**
 * 验证 dist/mcp-wiki-server.js 与后端联调（JSON-RPC over stdio）
 * 用法：SERVER=http://127.0.0.1:4001 WEEK=5 node scripts/verify-mcp-wiki-server.mjs
 */
import { spawn } from "node:child_process";
import readline from "node:readline";

const SERVER = process.env.SERVER || "http://127.0.0.1:4001";
const WEEK = Number(process.env.WEEK || 5);

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

const child = spawn(process.execPath, ["dist/mcp-wiki-server.js", "--week", String(WEEK), "--server", SERVER], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {
    /* 忽略非 JSON 行 */
  }
});

let idSeq = 1;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = idSeq++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: { message: "timeout" } });
      }
    }, 8000);
  });

await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "verify", version: "0" },
});
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

console.log(`\n=== verify-mcp-wiki-server (week=${WEEK}) ===\n`);

// ---- tools/list ----
{
  const r = await rpc("tools/list", {});
  const names = (r.result?.tools ?? []).map((t) => t.name).sort();
  check("暴露三个工具", JSON.stringify(names) === JSON.stringify(["list_wiki_weeks", "read_wiki_chunk", "search_wiki"]), JSON.stringify(names));

  const allProps = (r.result?.tools ?? []).flatMap((t) => Object.keys(t.inputSchema?.properties ?? {}));
  check("★ 工具参数中不含任何周数字段", !allProps.some((p) => /week/i.test(p)), JSON.stringify(allProps));
}

// ---- search_wiki ----
let firstId = null;
{
  const r = await rpc("tools/call", { name: "search_wiki", arguments: { query: "" } });
  const payload = JSON.parse(r.result?.content?.[0]?.text ?? "{}");
  check("search_wiki 返回 ok", payload.ok === true, JSON.stringify(payload).slice(0, 120));
  const over = (payload.data ?? []).filter((d) => d.applicable_week > WEEK);
  check(`★ search_wiki 结果不越过第 ${WEEK} 周`, over.length === 0, `${over.length} 条越界`);
  firstId = payload.data?.[0]?.id ?? null;
}

// ---- read_wiki_chunk ----
{
  if (firstId) {
    const r = await rpc("tools/call", { name: "read_wiki_chunk", arguments: { chunk_id: firstId } });
    const payload = JSON.parse(r.result?.content?.[0]?.text ?? "{}");
    check("read_wiki_chunk 取到内容", payload.ok === true && typeof payload.data?.content === "string");
  } else {
    console.log("  ⏭  库中无资料，跳过 read_wiki_chunk");
  }
  const r2 = await rpc("tools/call", { name: "read_wiki_chunk", arguments: { chunk_id: "__nope__" } });
  const p2 = JSON.parse(r2.result?.content?.[0]?.text ?? "{}");
  check("越界/不存在的 chunk → 结构化错误（不抛异常）", p2.error !== undefined || p2.ok === false);
}

// ---- list_wiki_weeks ----
{
  const r = await rpc("tools/call", { name: "list_wiki_weeks", arguments: {} });
  const payload = JSON.parse(r.result?.content?.[0]?.text ?? "{}");
  check("list_wiki_weeks 返回数组", Array.isArray(payload.data));
  const over = (payload.data ?? []).filter((w) => w.week > WEEK);
  check("★ 周数列表不越过当前周", over.length === 0);
}

// ---- 后端不可达时的容错 ----
{
  const bad = spawn(process.execPath, ["dist/mcp-wiki-server.js", "--week", "5", "--server", "http://127.0.0.1:59999"], {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pend2 = new Map();
  const rl2 = readline.createInterface({ input: bad.stdout });
  rl2.on("line", (l) => {
    try {
      const m = JSON.parse(l);
      if (m.id && pend2.has(m.id)) {
        pend2.get(m.id)(m);
        pend2.delete(m.id);
      }
    } catch {
      /* ignore */
    }
  });
  const rpc2 = (method, params) =>
    new Promise((res) => {
      const id = 1;
      pend2.set(id, res);
      bad.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (pend2.has(id)) {
          pend2.delete(id);
          res({ error: { message: "timeout" } });
        }
      }, 9000);
    });
  await rpc2("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v", version: "0" } });
  const r = await rpc2("tools/call", { name: "search_wiki", arguments: { query: "a" } });
  const payload = JSON.parse(r.result?.content?.[0]?.text ?? "{}");
  check("后端不可达 → 返回 error 而非崩溃", typeof payload.error === "string", JSON.stringify(payload).slice(0, 120));
  bad.kill();
}

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
child.kill();
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 2: 跑脚本确认失败或部分通过**

Run:
```powershell
cd d:\cline
node esbuild.mjs
node scripts\verify-mcp-wiki-server.mjs
```
Expected: 若 Task 1/2 的后端未启动，应看到"后端不可达"相关断言通过、其余多项 `❌`。先启动后端再继续。

- [ ] **Step 3: 启动后端并跑通**

Run（teaching-server 另开终端 `npm run dev` 后）：
```powershell
cd d:\cline
$env:SERVER="http://127.0.0.1:4001"; $env:WEEK="5"; node scripts\verify-mcp-wiki-server.mjs
```
Expected: 全部 `✅`，`0 failed`。**重点确认两条 ★ 用例**（工具参数无周数字段、结果不越界）。

- [ ] **Step 4: Commit**

```bash
cd d:\cline
git add scripts/verify-mcp-wiki-server.mjs
git commit -m "test(mcp): add end-to-end verification for wiki MCP server"
```

---

## Task 5: WikiMcpRegistrar — 配置自注册与三条操作边界

**Files:**
- Create: `d:\cline\src\core\teaching\WikiMcpRegistrar.ts`
- Create: `d:\cline\src\core\teaching\__tests__\WikiMcpRegistrar.test.ts`
- Modify: `d:\cline\src\extension.ts`

**Interfaces:**
- Consumes: `getMcpSettingsFilePath(settingsDirectoryPath)`（`@core/storage/disk`）；Task 0 记录的实际路径
- **Task 0 校准（实测）**：
  - 入参必须是 `context.globalStorageUri.fsPath`。实测目录名为 `shiinamatsuri.student-teaching-assistant-edu`，**不是**上游的 `saoudrizwan.claude-dev` → **禁止硬编码**。
  - 写入后**无需调用任何 McpHub API**：`chokidar` watcher 会自动触发 `updateServerConnections()`（`awaitWriteFinish` 100ms 防抖、`atomic: true`）。只要不置位 `isUpdatingClineSettings`，重载必定发生。
  - 改 `args`（周数）**等于完整重启**：`configsRequireRestart()` 只豁免 `autoApprove` / `timeout`，`args`/`command`/`env`/`disabled` 变化都会「删连接 + 重新 spawn」→ 重启窗口内该 server 不可用（Task 6/9 必须按「失败可见」处理，不得回退全文注入）。
- Produces:
  - `buildWikiServerEntry(opts: { execPath: string; scriptPath: string; week: number; serverUrl: string }): McpServerEntry`
  - `mergeWikiServerEntry(existing: McpServersMap, entry: McpServerEntry): { changed: boolean; next: McpServersMap }`
  - `ensureWikiMcpServer(context): Promise<void>`
  - `registerWikiMcpConfigWatcher(context): vscode.Disposable`

- [ ] **Step 1: 写纯函数单测（先失败）**

创建 `d:\cline\src\core\teaching\__tests__\WikiMcpRegistrar.test.ts`：

```ts
import { expect } from "chai"
import { buildWikiServerEntry, mergeWikiServerEntry } from "../WikiMcpRegistrar"

const base = {
	execPath: "C:/vscode/Code.exe",
	scriptPath: "C:/ext/dist/mcp-wiki-server.js",
	week: 5,
	serverUrl: "http://a:4001",
}

describe("buildWikiServerEntry", () => {
	it("生成 stdio 条目并把 week/server 放进 args", () => {
		const e = buildWikiServerEntry(base)
		expect(e.type).to.equal("stdio")
		expect(e.command).to.equal(base.execPath)
		expect(e.args).to.deep.equal([
			base.scriptPath,
			"--week",
			"5",
			"--server",
			"http://a:4001",
		])
		expect(e.env?.ELECTRON_RUN_AS_NODE).to.equal("1")
	})

	it("预置 autoApprove 白名单（三个只读工具）", () => {
		const e = buildWikiServerEntry(base)
		expect(e.autoApprove).to.deep.equal(["search_wiki", "read_wiki_chunk", "list_wiki_weeks"])
	})

	it("week 越界被 clamp", () => {
		expect(buildWikiServerEntry({ ...base, week: 99 }).args).to.contain("18")
		expect(buildWikiServerEntry({ ...base, week: 0 }).args).to.contain("1")
	})
})

describe("mergeWikiServerEntry", () => {
	it("条目缺失 → 写入并标记 changed", () => {
		const r = mergeWikiServerEntry({}, buildWikiServerEntry(base))
		expect(r.changed).to.equal(true)
		expect(r.next.wiki).to.exist
	})

	it("内容一致 → 不写入（幂等）", () => {
		const first = mergeWikiServerEntry({}, buildWikiServerEntry(base))
		const second = mergeWikiServerEntry(first.next, buildWikiServerEntry(base))
		expect(second.changed).to.equal(false)
	})

	it("week 变化 → 重写 args", () => {
		const first = mergeWikiServerEntry({}, buildWikiServerEntry(base))
		const r = mergeWikiServerEntry(first.next, buildWikiServerEntry({ ...base, week: 9 }))
		expect(r.changed).to.equal(true)
		expect(r.next.wiki.args).to.contain("9")
	})

	it("★ 尊重 disabled=true（不覆盖学生的禁用选择）", () => {
		const first = mergeWikiServerEntry({}, buildWikiServerEntry(base))
		first.next.wiki.disabled = true
		const r = mergeWikiServerEntry(first.next, buildWikiServerEntry(base))
		expect(r.changed).to.equal(false)
		expect(r.next.wiki.disabled).to.equal(true)
	})

	it("不破坏其它 server 条目", () => {
		const existing = { other: { type: "stdio", command: "node" } }
		const r = mergeWikiServerEntry(existing as never, buildWikiServerEntry(base))
		expect(r.next.other).to.exist
		expect(r.next.wiki).to.exist
	})

	it("command/args 被篡改 → 覆盖回正确值", () => {
		const existing = { wiki: { type: "stdio", command: "bad", args: ["nope"] } }
		const r = mergeWikiServerEntry(existing as never, buildWikiServerEntry(base))
		expect(r.changed).to.equal(true)
		expect(r.next.wiki.command).to.equal(base.execPath)
	})
})
```

- [ ] **Step 2: 跑单测确认失败**

Run: `cd d:\cline; npm run test:unit -- --grep "buildWikiServerEntry|mergeWikiServerEntry" 2>&1 | Select-Object -Last 20`
Expected: `Cannot find module '../WikiMcpRegistrar'`。

- [ ] **Step 3: 实现 WikiMcpRegistrar**

创建 `d:\cline\src\core\teaching\WikiMcpRegistrar.ts`：

```ts
/**
 * WikiMcpRegistrar — wiki MCP server 的配置自注册（v2.13）
 *
 * 三条操作边界（见 docs/design/wiki-mcp-retrieval-design.md §D2）：
 *   1) 禁用（disabled=true）  → 尊重，不覆盖（由 watcher 提示后果，见 §D5）
 *   2) 删除条目              → 不允许：每次激活检测，缺失即重建
 *   3) 篡改 command/args     → 覆盖回正确值
 */
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"
import { getMcpSettingsFilePath } from "@core/storage/disk"
import { Logger } from "@/shared/services/Logger"
import { clampWeek } from "./mcp/args"

export interface McpServerEntry {
	type: "stdio"
	command: string
	args: string[]
	env?: Record<string, string>
	autoApprove?: string[]
	timeout?: number
	disabled?: boolean
}

type McpServersMap = Record<string, McpServerEntry>

export const WIKI_SERVER_NAME = "wiki"
export const WIKI_TOOL_NAMES = ["search_wiki", "read_wiki_chunk", "list_wiki_weeks"]

export function buildWikiServerEntry(opts: {
	execPath: string
	scriptPath: string
	week: number
	serverUrl: string
}): McpServerEntry {
	return {
		type: "stdio",
		command: opts.execPath,
		args: [opts.scriptPath, "--week", String(clampWeek(opts.week)), "--server", opts.serverUrl],
		// stdio server 是独立进程：用 VS Code 自带的 node 运行脚本
		env: { ELECTRON_RUN_AS_NODE: "1" },
		autoApprove: [...WIKI_TOOL_NAMES],
		timeout: 30,
	}
}

/** 合并逻辑（纯函数，便于单测）：只补缺失与不一致，不动 disabled，不动其它 server */
export function mergeWikiServerEntry(
	existing: McpServersMap,
	entry: McpServerEntry,
): { changed: boolean; next: McpServersMap } {
	const next: McpServersMap = { ...existing }
	const cur = next[WIKI_SERVER_NAME]

	// 1) 条目缺失 → 写入（"删除无效"）
	if (!cur) {
		next[WIKI_SERVER_NAME] = entry
		return { changed: true, next }
	}

	// 2) 被禁用 → 尊重，完全不改（"禁用可控"）
	if (cur.disabled === true) {
		return { changed: false, next }
	}

	// 3) 内容不一致（含 command/args 被篡改）→ 覆盖为正确值
	const same =
		cur.command === entry.command &&
		JSON.stringify(cur.args ?? []) === JSON.stringify(entry.args) &&
		cur.type === entry.type &&
		JSON.stringify(cur.autoApprove ?? []) === JSON.stringify(entry.autoApprove ?? [])
	if (same) {
		return { changed: false, next }
	}

	next[WIKI_SERVER_NAME] = { ...entry, disabled: false }
	return { changed: true, next }
}

/** 读取 MCP 配置文件（不存在则返回空表） */
async function readMcpSettings(settingsDir: string): Promise<{ path: string; map: McpServersMap; raw: Record<string, unknown> }> {
	const filePath = await getMcpSettingsFilePath(settingsDir)
	let raw: Record<string, unknown> = {}
	try {
		const text = await fs.readFile(filePath, "utf-8")
		raw = JSON.parse(text) as Record<string, unknown>
	} catch {
		raw = {}
	}
	const map = (raw.mcpServers as McpServersMap) ?? {}
	return { path: filePath, map, raw }
}

/**
 * 确保 wiki server 条目存在且正确。
 * 每次插件激活都会调用（覆盖"被意外删除"的情况）。
 */
export async function ensureWikiMcpServer(context: vscode.ExtensionContext): Promise<void> {
	try {
		const cfg = vscode.workspace.getConfiguration("clineTeaching")
		const week = cfg.get<number>("currentWeek") ?? 1
		const serverUrl = (cfg.get<string>("serverUrl") ?? "").trim()

		const scriptPath = path.join(context.extensionPath, "dist", "mcp-wiki-server.js")
		const entry = buildWikiServerEntry({
			execPath: process.execPath,
			scriptPath,
			week,
			serverUrl,
		})

		const settingsDir = context.globalStorageUri.fsPath
		const { path: filePath, map, raw } = await readMcpSettings(settingsDir)
		const { changed, next } = mergeWikiServerEntry(map, entry)
		if (!changed) {
			Logger.log(`[WikiMcpRegistrar] wiki MCP 条目已是最新，跳过写入`)
			return
		}

		raw.mcpServers = next
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf-8")
		Logger.log(`[WikiMcpRegistrar] 已写入/更新 wiki MCP 条目: ${filePath}`)
	} catch (e) {
		// 注册失败不应阻断插件启动
		Logger.error("[WikiMcpRegistrar] 注册失败:", e as Error)
	}
}

/** 监听周数变化 → 重写 args（使 MCP server 用新的 week 重启） */
export function registerWikiMcpConfigWatcher(context: vscode.ExtensionContext): vscode.Disposable {
	const disposable = vscode.workspace.onDidChangeConfiguration((e) => {
		if (!e.affectsConfiguration("clineTeaching.currentWeek") && !e.affectsConfiguration("clineTeaching.serverUrl")) {
			return
		}
		void ensureWikiMcpServer(context)
	})
	context.subscriptions.push(disposable)
	return disposable
}
```

- [ ] **Step 4: 跑单测确认通过**

Run: `npm run test:unit -- --grep "buildWikiServerEntry|mergeWikiServerEntry" 2>&1 | Select-Object -Last 25`
Expected: `10 passing`（含 ★ 尊重 disabled 的那条）。

- [ ] **Step 5: 在 extension.ts 接线**

在 `d:\cline\src\extension.ts` 的 `activate()` 中，紧接现有 `LLMWikiService` 初始化之后插入：

```ts
	// 【v2.13】wiki MCP server 自注册（缺失即重建 / 周数变化重写）
	const { ensureWikiMcpServer, registerWikiMcpConfigWatcher } = await import("./core/teaching/WikiMcpRegistrar")
	await ensureWikiMcpServer(context)
	registerWikiMcpConfigWatcher(context)
```

- [ ] **Step 6: 手工验证（VS Code 内）**

Run: `npm run watch`（若已在跑则跳过），然后**重载 VS Code 窗口**（命令面板 → `Developer: Reload Window`）。

Expected:
1. `cline_mcp_settings.json` 中出现 `wiki` 条目（含 `args: [... "--week", "5", "--server", ...]`）
2. VS Code MCP 面板中 `wiki` 显示 **Connected**
3. 手工删除该条目 → 重载窗口 → 条目**被重建**（验证"删除无效"）

- [ ] **Step 7: Commit**

```bash
cd d:\cline
git add src/core/teaching/WikiMcpRegistrar.ts src/core/teaching/__tests__/WikiMcpRegistrar.test.ts src/extension.ts
git commit -m "feat(mcp): self-register wiki MCP server with disable-respect and delete-rebuild"
```

---

## Task 6: 禁用提示（配置变化监听 + 后果告知）

**Files:**
- Modify: `d:\cline\src\core\teaching\WikiMcpRegistrar.ts`（新增 `watchWikiServerDisabled`）
- Modify: `d:\cline\src\extension.ts`
- Test: `d:\cline\src\core\teaching\__tests__\WikiMcpRegistrar.test.ts`（追加纯函数用例）

**Interfaces:**
- Produces: `detectDisabledTransition(prev: McpServersMap, next: McpServersMap): boolean`

- [ ] **Step 1: 写单测（先失败）**

在 `WikiMcpRegistrar.test.ts` 末尾追加：

```ts
describe("detectDisabledTransition", () => {
	it("false → true 视为禁用事件", () => {
		expect(detectDisabledTransition({} as never, { wiki: { type: "stdio", command: "c", disabled: true } } as never)).to.equal(true)
	})

	it("本就是 true → 不重复提示", () => {
		const prev = { wiki: { type: "stdio", command: "c", disabled: true } } as never
		expect(detectDisabledTransition(prev, prev)).to.equal(false)
	})

	it("条目不存在 → 不提示", () => {
		expect(detectDisabledTransition({} as never, {} as never)).to.equal(false)
	})
})
```

并把 import 改为：

```ts
import { buildWikiServerEntry, detectDisabledTransition, mergeWikiServerEntry } from "../WikiMcpRegistrar"
```

- [ ] **Step 2: 跑单测确认失败**

Run: `npm run test:unit -- --grep "detectDisabledTransition" 2>&1 | Select-Object -Last 15`
Expected: 失败（未导出该函数）。

- [ ] **Step 3: 实现禁用提示**

在 `WikiMcpRegistrar.ts` 末尾追加：

```ts
/** 检测"由启用变为禁用"这一次状态跃迁（避免每次读文件都弹提示） */
export function detectDisabledTransition(prev: McpServersMap, next: McpServersMap): boolean {
	const p = prev[WIKI_SERVER_NAME]
	const n = next[WIKI_SERVER_NAME]
	if (!n) return false
	const wasDisabled = p?.disabled === true
	const nowDisabled = n.disabled === true
	return !wasDisabled && nowDisabled
}

/**
 * 监听 wiki server 被禁用 → 立即提示后果并提供"重新启用"。
 *
 * 说明：禁用动作发生在 Cline 自带的 MCP 面板 UI 中，拦截该点击需要改 core 的 webview，
 * 因此改为"配置变化后立即提示"（延迟约百毫秒，效果等同"一禁用就提示"）。
 * 见 spec §D5。
 */
export function watchWikiServerDisabled(context: vscode.ExtensionContext, resolveSettingsDir: () => string): vscode.Disposable {
	let lastMap: McpServersMap = {}

	const tick = async (): Promise<void> => {
		try {
			const { map } = await readMcpSettings(resolveSettingsDir())
			if (detectDisabledTransition(lastMap, map)) {
				const pick = await vscode.window.showWarningMessage(
					"课程资料检索已禁用：AI 将无法获取教师发布的课程资料，可能给出超出教学进度的回答。是否重新启用？",
					"重新启用",
					"保持禁用",
				)
				if (pick === "重新启用") {
					await reEnableWikiServer(context)
				}
			}
			lastMap = map
		} catch {
			/* 读配置失败不影响主流程 */
		}
	}

	void tick()
	const timer = setInterval(() => void tick(), 2000)
	const disposable = new vscode.Disposable(() => clearInterval(timer))
	context.subscriptions.push(disposable)
	return disposable
}

/** 把条目写回 disabled:false（用于学生选择"重新启用"） */
export async function reEnableWikiServer(context: vscode.ExtensionContext): Promise<void> {
	try {
		const settingsDir = context.globalStorageUri.fsPath
		const { path: filePath, map, raw } = await readMcpSettings(settingsDir)
		const cur = map[WIKI_SERVER_NAME]
		if (!cur) return
		map[WIKI_SERVER_NAME] = { ...cur, disabled: false }
		raw.mcpServers = map
		await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf-8")
		Logger.log("[WikiMcpRegistrar] 已重新启用 wiki MCP server")
	} catch (e) {
		Logger.error("[WikiMcpRegistrar] 重新启用失败:", e as Error)
	}
}
```

- [ ] **Step 4: 跑单测确认通过**

Run: `npm run test:unit -- --grep "detectDisabledTransition" 2>&1 | Select-Object -Last 15`
Expected: `3 passing`。

- [ ] **Step 5: 在 extension.ts 接线**

在 Task 5 的接线之后追加：

```ts
	const { watchWikiServerDisabled } = await import("./core/teaching/WikiMcpRegistrar")
	watchWikiServerDisabled(context, () => context.globalStorageUri.fsPath)
```

- [ ] **Step 6: 手工验证**

在 VS Code 的 MCP 面板中把 `wiki` **禁用**。

Expected: 约 2 秒内弹出警告框，含「重新启用 / 保持禁用」；点「重新启用」后 `disabled` 回到 false。

- [ ] **Step 7: Commit**

```bash
cd d:\cline
git add src/core/teaching/WikiMcpRegistrar.ts src/core/teaching/__tests__/WikiMcpRegistrar.test.ts src/extension.ts
git commit -m "feat(mcp): warn on wiki server disable and offer re-enable"
```

---

## Task 7: 注入点改造 — 认知边界约束 + 资料索引

**Files:**
- Create: `d:\cline\src\core\teaching\wikiPrompt.ts`
- Create: `d:\cline\src\core\teaching\__tests__\wikiPrompt.test.ts`
- Modify: `d:\cline\src\core\teaching\LLMWikiService.ts`（**新增**索引与状态方法；本任务只增不删）
- Modify: `d:\cline\src\core\task\index.ts`（注入点）

> ⚠️ **前置依赖（重要）**：本任务的注入点改造需要 `LLMWikiService.buildIndexGroups()` /
> `isWikiMcpAvailable()` / `setWikiMcpAvailable()` 三个方法，它们定义在 **Task 8 的 Step 1**。
>
> **实际执行顺序：Task 8 Step 1-2 → Task 7 → Task 8 Step 3-6。**
> 之所以把“新增方法”与“删除旧代码”拆开，是为了让**清理动作发生在注入点切换之后** ——
> 否则中间态会出现“旧方法已删、新调用未接”的编译失败。

**Interfaces:**
- Consumes: `LLMWikiService._wikiCache`（chunk 元数据）；Task 8 Step 1 新增的三个方法
- Produces: `buildWikiSystemPrompt(opts: WikiPromptOptions): string`，以及 `WikiIndexGroup` 类型

- [ ] **Step 1: 写单测（先失败）**

创建 `d:\cline\src\core\teaching\__tests__\wikiPrompt.test.ts`：

```ts
import { expect } from "chai"
import { buildWikiSystemPrompt } from "../wikiPrompt"

const opts = {
	week: 5,
	index: [
		{ week: 3, titles: ["列表与字典", "函数基础"] },
		{ week: 5, titles: ["装饰器"] },
	],
	mcpAvailable: true,
}

describe("buildWikiSystemPrompt", () => {
	it("★ 必须包含认知边界约束段", () => {
		const s = buildWikiSystemPrompt(opts)
		expect(s).to.include("认知边界约束")
		expect(s).to.include("严禁使用超出第 5 周")
	})

	it("★ 必须包含「检索为空时不得展开讲解」规则", () => {
		const s = buildWikiSystemPrompt(opts)
		expect(s).to.include("检索结果为空")
		expect(s).to.include("不要展开讲解")
	})

	it("包含资料索引且不含全文", () => {
		const s = buildWikiSystemPrompt(opts)
		expect(s).to.include("列表与字典")
		expect(s).to.include("资料索引")
		// 索引模式不得塞入大段正文
		expect(s.length).to.be.lessThan(3000)
	})

	it("MCP 不可用时给出状态声明", () => {
		const s = buildWikiSystemPrompt({ ...opts, mcpAvailable: false })
		expect(s).to.include("当前不可用")
	})
})
```

- [ ] **Step 2: 跑单测确认失败**

Run: `npm run test:unit -- --grep "buildWikiSystemPrompt" 2>&1 | Select-Object -Last 15`
Expected: 模块不存在。

- [ ] **Step 3: 实现 wikiPrompt.ts**

创建 `d:\cline\src\core\teaching\wikiPrompt.ts`：

```ts
/**
 * 生成注入到 system prompt 的 wiki 相关文本（v2.13）
 *
 * 与旧 buildSystemPrompt 的区别：**不再注入全文**，只注入
 *   ① 认知边界约束（必须保留，见 spec §D6 的必需项）
 *   ② 资料索引（有哪些资料可查 → 提高检索命中率）
 *   ③ 检索状态（MCP 不可用时明确告知）
 */
import { clampWeek } from "./mcp/args"

export interface WikiIndexGroup {
	week: number
	titles: string[]
}

export interface WikiPromptOptions {
	week: number
	index: WikiIndexGroup[]
	mcpAvailable: boolean
}

const MAX_INDEX_CHARS = 2400

export function buildWikiSystemPrompt(opts: WikiPromptOptions): string {
	const week = clampWeek(opts.week)
	const parts: string[] = []

	parts.push(
		[
			`# 认知边界约束（不可违反）`,
			`1. 你只能引用通过 search_wiki / read_wiki_chunk 检索到的资料作为答疑依据。`,
			`2. 检索结果为空，说明该知识点尚未在当前教学进度内发布：`,
			`   - 不要展开讲解其具体用法`,
			`   - 应明确告知「该知识点将在后续周次讲解」，并给出当前进度内的相关基础`,
			`3. 严禁使用超出第 ${week} 周的高级语法、设计模式或库函数。`,
		].join("\n"),
	)

	if (!opts.mcpAvailable) {
		parts.push(
			[
				`# 资料检索状态`,
				`⚠️ 课程资料检索服务当前不可用，你无法查询教师发布的资料。`,
				`请基于通用知识作答，并明确告知学生「当前无法引用课程资料」。`,
			].join("\n"),
		)
		return parts.join("\n\n")
	}

	// 资料索引（控制长度，避免退化成"全文注入"）
	const lines: string[] = []
	let used = 0
	for (const g of opts.index.slice().sort((a, b) => a.week - b.week)) {
		const line = `- 第 ${g.week} 周：${g.titles.slice(0, 8).join(" / ")}`
		if (used + line.length > MAX_INDEX_CHARS) {
			lines.push(`- …（后续索引已省略）`)
			break
		}
		lines.push(line)
		used += line.length
	}

	parts.push(`# 资料索引（可用资料一览）\n${lines.length > 0 ? lines.join("\n") : "（当前进度暂无资料）"}`)

	return parts.join("\n\n")
}
```

- [ ] **Step 4: 跑单测确认通过**

Run: `npm run test:unit -- --grep "buildWikiSystemPrompt" 2>&1 | Select-Object -Last 15`
Expected: `4 passing`。

- [ ] **Step 5: 改造注入点**

打开 `d:\cline\src\core\task\index.ts`，找到现有这段（RAG 注入）：

```ts
		const ragContext = llmWiki.buildSystemPrompt(userQuery)
		systemPromptFinal = systemPrompt + "\n\n" + ragContext
```

**替换为**：

```ts
		// 【v2.13】改为注入「认知边界约束 + 资料索引」，不再注入全文（见 spec §D5/§D6）
		// - 全文注入会导致 16k 截断（本次改造要解决的问题），且与 MCP 按需检索重复
		// - 认知边界约束必须保留：检索边界拦不住模型"凭通用知识超纲作答"
		const mcpAvailable = llmWiki.isWikiMcpAvailable()
		const indexGroups = llmWiki.buildIndexGroups()
		const ragContext = buildWikiSystemPrompt({
			week: llmWiki.getCurrentWeek(),
			index: indexGroups,
			mcpAvailable,
		})
		systemPromptFinal = systemPrompt + "\n\n" + ragContext
```

并在该文件的 import 区加入：

```ts
import { buildWikiSystemPrompt } from "@/core/teaching/wikiPrompt"
```

- [ ] **Step 6: 验证（VS Code 内）**

Run: 重载窗口后发起一次提问，查看输出面板日志。

Expected: 日志 `[Task] Wiki RAG 已注入 (... ragChars=...)` 中的 `ragChars` **从原先的数千至上万降到几百**（证明不再注入全文）。

- [ ] **Step 7: Commit**

```bash
cd d:\cline
git add src/core/teaching/wikiPrompt.ts src/core/teaching/__tests__/wikiPrompt.test.ts src/core/task/index.ts
git commit -m "feat(task): inject cognitive-boundary constraints and wiki index instead of full text"
```

---

## Task 8: 清理旧路径 — 移除全量注入与未接线方法

**Files:**
- Modify: `d:\cline\src\core\teaching\LLMWikiService.ts`
- Modify: `d:\cline\package.json`（文案）

**Interfaces:**
- Produces: `LLMWikiService.isWikiMcpAvailable(): boolean`、`buildIndexGroups(): WikiIndexGroup[]`（供 Task 7 使用）
- Removes: `answerWithTools()`、`_executeToolCall()`、`_buildWikiContext()` 的全文拼接、`buildSystemPrompt()` 的旧实现

- [ ] **Step 1: 先补 Task 7 依赖的两个方法 + 单测**

在 `LLMWikiService.ts` 中新增（保留 `_wikiCache` 用于取元数据）：

```ts
	/**
	 * 【v2.13】生成资料索引（周 → 标题列表），供注入 system prompt 使用。
	 * 只取元数据，不含正文 —— 正文通过 MCP 工具按需检索。
	 */
	public buildIndexGroups(): Array<{ week: number; titles: string[] }> {
		const byWeek = new Map<number, string[]>()
		for (const chunks of this._wikiCache.values()) {
			for (const c of chunks) {
				if (c.applicable_week > this._currentWeek) continue
				if (!byWeek.has(c.applicable_week)) byWeek.set(c.applicable_week, [])
				const arr = byWeek.get(c.applicable_week)!
				if (!arr.includes(c.title)) arr.push(c.title)
			}
		}
		return Array.from(byWeek.entries())
			.map(([week, titles]) => ({ week, titles }))
			.sort((a, b) => a.week - b.week)
	}

	/**
	 * 【v2.13】wiki MCP 是否可用（由 McpHub 的连接状态决定）。
	 * 不可用时注入"检索不可用"状态声明，而非退回全文注入（见 spec §D5）。
	 */
	public isWikiMcpAvailable(): boolean {
		return this._wikiMcpAvailable
	}

	/** 由 WikiMcpRegistrar 在探测到连接状态后回写 */
	public setWikiMcpAvailable(available: boolean): void {
		this._wikiMcpAvailable = available
	}
```

并新增字段：

```ts
	/** 【v2.13】wiki MCP server 是否已连接 */
	private _wikiMcpAvailable = false
```

在 `src/core/teaching/__tests__/` 下追加 `LLMWikiService.index.test.ts`：

```ts
import { expect } from "chai"
import { LLMWikiService } from "../LLMWikiService"

describe("LLMWikiService.buildIndexGroups", () => {
	it("按周聚合标题且不返回超过当前周的资料", () => {
		const svc = LLMWikiService.getInstance()
		// 直接注入内部缓存（测试用）
		;(svc as unknown as { _wikiCache: Map<string, unknown[]> })._wikiCache = new Map([
			["a", [{ id: "a", title: "列表", applicable_week: 3, content: "x" }]],
			["b", [{ id: "b", title: "装饰器", applicable_week: 9, content: "y" }]],
		])
		;(svc as unknown as { _currentWeek: number })._currentWeek = 5

		const groups = svc.buildIndexGroups()
		expect(groups.map((g) => g.week)).to.deep.equal([3])
		expect(groups[0].titles).to.deep.equal(["列表"])
	})
})
```

- [ ] **Step 2: 跑单测**

Run: `npm run test:unit -- --grep "buildIndexGroups" 2>&1 | Select-Object -Last 15`
Expected: `1 passing`。

- [ ] **Step 3: 删除已废弃的实现**

在 `LLMWikiService.ts` 中**删除**以下成员（它们或因未接线、或因边界可绕过而被 §D5 弃用）：

| 删除目标 | 原因 |
|---|---|
| `answerWithTools()` | 从未被调用（dead code），且其 `grep_wiki` 允许 LLM 传 `max_week` 绕过边界 |
| `_executeToolCall()` | 同上；且 `read_chunk` 的查找条件写错（`c.id.includes("__chunk") === false` 恒真时忽略 chunkId） |
| `_registerTools()` / `_buildToolsSystemPrompt()` | 仅服务于 `answerWithTools` |
| `buildSystemPrompt()` 与 `_buildWikiContext()` | 全文拼接路径，按 §D5 不再作为降级方案 |
| 常量 `CHUNK_TRUNCATE_CHARS` / `TOTAL_CONTEXT_CHARS` / `MAX_TOOL_ROUNDS` | 随上一条一并移除 |

保留：`_wikiCache`、`fetchWikiForWeek()`、`_buildTextbookContext()`（教材章节仍用于索引生成）、`getCurrentWeek()`、`getServerUrl()`、`getWikiCacheSize()`。

> **注意**：`fetchWikiForWeek()` 仍然需要 —— 它是"索引"的数据来源。

- [ ] **Step 4: 更新设置项文案**

在 `d:\cline\package.json` 中找到 `clineTeaching.llmEnableTools`，把 description 改为：

```json
"description": "是否启用课程资料检索（MCP）。关闭后 AI 将无法查询教师发布的资料（不会退回全文注入）"
```

- [ ] **Step 5: 全量校验**

Run:
```powershell
cd d:\cline
npm run check-types 2>&1 | Select-Object -Last 20
npm run test:unit -- --grep "buildIndexGroups|buildWikiSystemPrompt|parseMcpArgs|WikiServerEntry|DisabledTransition" 2>&1 | Select-Object -Last 20
node esbuild.mjs
```
Expected: 类型检查通过（无新增错误）；单测全部 passing；构建成功。

- [ ] **Step 6: Commit**

```bash
cd d:\cline
git add src/core/teaching/LLMWikiService.ts src/core/teaching/__tests__/LLMWikiService.index.test.ts package.json
git commit -m "refactor(wiki): remove full-text injection path and dead tool-calling code"
```

---

## Task 9: 失败可见化与端到端验收

**Files:**
- Modify: `d:\cline\src\core\teaching\WikiMcpRegistrar.ts`（探测连接状态并回写 LLMWikiService）
- Create: `d:\cline\docs\design\wiki-mcp-retrieval-acceptance.md`（验收记录）

**Interfaces:**
- Consumes: Task 3-8 的全部产物
- Produces: 一份**验收记录**（逐条对应 spec §7 的测试策略）

- [ ] **Step 1: 实现连接状态探测**

在 `WikiMcpRegistrar.ts` 的 `ensureWikiMcpServer` 末尾追加（探测并回写）：

```ts
/** 探测 wiki MCP 连接状态并回写 LLMWikiService（供注入内容决定是否带"不可用"声明） */
export async function probeWikiMcpAvailability(): Promise<void> {
	try {
		const { McpHub } = await import("@/services/mcp/McpHub")
		const hub = McpHub.getInstance?.()
		const servers = hub?.getMcpServers?.() ?? []
		const wiki = servers.find((s: { name?: string }) => s.name === WIKI_SERVER_NAME)
		const connected = wiki?.status === "connected" && wiki?.disabled !== true
		const { LLMWikiService } = await import("./LLMWikiService")
		LLMWikiService.getInstance().setWikiMcpAvailable(Boolean(connected))
	} catch (e) {
		Logger.warn("[WikiMcpRegistrar] 探测 MCP 状态失败，按不可用处理")
		const { LLMWikiService } = await import("./LLMWikiService")
		LLMWikiService.getInstance().setWikiMcpAvailable(false)
	}
}
```

> ⚠️ `McpHub` 的实例获取方式与 `getMcpServers()` 的返回结构**需在实现时按实际 API 校准**（参考 `src/services/mcp/McpHub.ts` 的公开方法）。若 API 名称不符，以实际为准并在验收记录中注明。

在 `extension.ts` 中，`ensureWikiMcpServer` 之后调用一次，并加入配置监听：

```ts
	await probeWikiMcpAvailability()
	registerWikiMcpConfigWatcher(context) // 已有的监听内部也会重探
```

- [ ] **Step 2: 逐条执行验收（写入记录文件）**

创建 `d:\cline\docs\design\wiki-mcp-retrieval-acceptance.md`，按下表逐条填写实际结果：

```markdown
# Wiki MCP 检索改造 — 验收记录

> 执行日期：____　执行人：____
> 对应设计：`wiki-mcp-retrieval-design.md` §7 测试策略

## 服务端（脚本化验证）

| 用例 | 命令 | 期望 | 实际 |
|---|---|---|---|
| week 越界 400 | `node scripts/verify-wiki-search.mjs` | 4 项 ❌→✅ | |
| ★ week=3 结果无第 4 周内容 | 同上 | over.length === 0 | |
| ★ chunk 越界 404 | 同上 | 404 | |
| limit clamp | 同上 | ≤10 | |

## MCP server（端到端）

| 用例 | 命令 | 期望 | 实际 |
|---|---|---|---|
| ★ 工具参数无周数字段 | `node scripts/verify-mcp-wiki-server.mjs` | 无 week 字段 | |
| ★ 检索不越界 | 同上 | 无越界条目 | |
| 后端不可达 → 结构化错误 | 同上 | error 字段 | |

## VS Code 内手工验收

| 用例 | 操作 | 期望 | 实际 |
|---|---|---|---|
| 自注册 | 重载窗口 | `cline_mcp_settings.json` 出现 wiki 条目 | |
| ★ 删除重建 | 删条目→重载 | 条目被重建 | |
| ★ 禁用提示 | MCP 面板禁用 wiki | 2s 内弹警告 + 可重新启用 | |
| ★ token 不回升 | 禁用后提问 | **不注入全文**，ragChars 保持低位 | |
| 失败可见 | 停掉后端后提问 | 对话提示"检索当前不可用" | |
| 正常检索 | 问当前周内问题 | 模型调用 search_wiki 并作答 | |
| ★ 超纲提问 | week=3 问"装饰器"（资料在第 5 周） | 告知周次 + 给当前进度基础；**不展开语法**；**不拒答** | |
| ★ 可维护性 | 手工改库（`UPDATE wiki_chunks SET content='新内容' WHERE id='<某 id>'`）后提问 | 取到**新内容**（验证无客户端缓存陈旧；不依赖教师端编辑功能） |
| 思考链仍隐藏 | 任意提问 | 回复中无推理过程 | |
| 干预仍生效 | 连续索取代码 | 触发提示式干预 | |
```

- [ ] **Step 3: 跑完所有验收并填写记录**

Run（依次）：
```powershell
# 1) 后端
cd d:\web-dashboard\teaching-server; npm run dev   # 另开终端
$env:BASE_URL="http://127.0.0.1:4001"; node scripts\verify-wiki-search.mjs

# 2) MCP server
cd d:\cline; node esbuild.mjs
$env:SERVER="http://127.0.0.1:4001"; $env:WEEK="5"; node scripts\verify-mcp-wiki-server.mjs
```
然后在 VS Code 内完成手工验收表。

Expected: 两个脚本均 `0 failed`；手工表全部符合期望。**任何一条 ★ 未通过都不得进入 Task 10。**

- [ ] **Step 4: Commit**

```bash
cd d:\cline
git add src/core/teaching/WikiMcpRegistrar.ts src/extension.ts docs/design/wiki-mcp-retrieval-acceptance.md
git commit -m "feat(mcp): probe availability and add acceptance record"
```

---

## Task 10: CHANGELOG 与文档收尾

**Files:**
- Modify: `d:\cline\CHANGELOG.md`
- Modify: `d:\web-dashboard\CHANGELOG.md`

- [ ] **Step 1: 写 cline 侧 CHANGELOG**

在 `d:\cline\CHANGELOG.md` 顶部（当前版本段之上）插入：

```markdown
## [Unreleased] — 2026-09-29

### Added

- **课程资料检索 MCP 化**：新增本地 stdio MCP server（`dist/mcp-wiki-server.js`），暴露
  `search_wiki` / `read_wiki_chunk` / `list_wiki_weeks` 三个**只读**工具，由主对话 LLM 自主按需检索，
  取代原先"把 <=16k 字符全文塞进 system prompt"的做法 —— 解决资料多时被 `week+id` 字典序盲截断的问题。
- **配置文件自注册**（`WikiMcpRegistrar`）：插件激活时确保 `cline_mcp_settings.json` 中存在 wiki 条目；
  周数变化时重写 `--week` 参数并触发重载。

### Changed

- **注入内容变更**：system prompt 从"认知边界约束 + 资料全文"改为"**认知边界约束 + 资料索引 + 检索状态**"，
  上下文从 16k 降至 1k 量级。**认知边界约束段为必需项** —— 检索边界拦不住模型凭通用知识超纲作答。
- `clineTeaching.llmEnableTools` 语义变更：从"启用工具调用答疑（此前为空开关，无任何调用点）"改为"启用课程资料检索（MCP）"。

### Fixed

- **移除未接线且边界可绕过的工具调用代码**：`answerWithTools()` 从未被调用；其 `grep_wiki` 接受 LLM 传入的
  `max_week` 且无上限校验（传 18 即可读取未来周资料），`read_chunk` 的查找条件写错（恒真时忽略 chunkId）。

### Removed

- 全量注入路径（`buildSystemPrompt` 全文拼接 + `TOTAL_CONTEXT_CHARS` 截断）。
  **不再作为 MCP 不可用时的降级方案** —— 它会重新引入本次要解决的 token 与截断问题。
  改为「失败可见」：检索不可用时在对话中明确告知，禁用时提示后果并提供重新启用。
```

- [ ] **Step 2: 写 web-dashboard 侧 CHANGELOG**

在 `d:\web-dashboard\CHANGELOG.md` 的 `[Unreleased]` 段落追加：

```markdown
- 新增**学生端资料检索端点**（v2.13）：`GET /api/v1/wiki/search`、`/api/v1/wiki/chunk`、`/api/v1/wiki/weeks`。
  三者均在 SQL 层强制 `applicable_week <= week`（教学边界的唯一可信防线），
  检索为关键词 + 结构化排序（标题命中优先 → 更近周优先），**不引入向量检索**。
  资料 id 走 **query 参数**（id 可能含斜杠，路径段的 `:id` 会被 Express 当成多段而 404）。
  检索逻辑独立于 `src/wikiSearch.ts`，附 `scripts/verify-wiki-search.mjs` 脚本化验证。
```

- [ ] **Step 3: Commit**

```bash
cd d:\cline
git add CHANGELOG.md
git commit -m "docs: changelog for MCP-based wiki retrieval"

cd d:\web-dashboard
git add CHANGELOG.md
git commit -m "docs: changelog for wiki retrieval endpoints"
```

---

## 附：任务依赖与风险速查

| Task | 依赖 | 可否独立验证 | 风险 |
|---|---|---|---|
| 0 spike | 无 | ✅ | **高** —— 失败则方案退回远程 HTTP（需回到设计阶段） |
| 1-2 后端端点 | 无 | ✅ curl/脚本 | 低 |
| 3-4 MCP server | Task 1-2 | ✅ JSON-RPC 脚本 | 中 —— `esbuild` 多入口配置；MCP SDK 版本 |
| 5 自注册 | Task 0 的路径结论 | ✅ 单测 + VS Code | 中 —— `getMcpSettingsFilePath` 入参需校准 |
| 6 禁用提示 | Task 5 | ✅ 单测 + VS Code | 低 |
| 7 注入点 | Task 3-6 | ✅ 日志 ragChars | **中** —— ★ 约束段不可漏 |
| 8 清理 | Task 7 | ✅ 类型检查 + 单测 | 中 —— 误删仍在用的成员 |
| 9 验收 | 全部 | ✅ | **高** —— ★ 项是本次改造的核心目标 |
| 10 CHANGELOG | 全部 | ✅ | 低 |

**开工前必读**：spec §D5（为什么不降级）、§D6（约束不可去掉）、§10（4 项待验证事项）。
