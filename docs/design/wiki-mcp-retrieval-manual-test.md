# Wiki MCP 检索改造 — 手工测试指引

> 配套文档：
> - 设计：`wiki-mcp-retrieval-design.md`
> - 计划：`wiki-mcp-retrieval-plan.md`
> - 验收记录（实际结果填这里）：`wiki-mcp-retrieval-acceptance.md`
>
> 本文档面向**未参与实现**的执行者。每一步都给出「操作 → 预期 → 判定依据 → 失败长什么样」。

---

## 0. 30 秒背景

改造前：插件把「≤16k 字符的资料全文」直接拼进 system prompt，资料一多就被截断
（实测 week=18 时 13,889 字符只能覆盖 6/77 个 chunk）。

改造后：system prompt 里只放「**认知边界约束 + 资料目录索引 + 检索可用性声明**」
（实测同一份数据降到 2,329 字符，−83.2%）。正文改为让主对话 LLM 通过一个**本地 stdio MCP server**
（`dist/mcp-wiki-server.js`）按需检索，暴露 3 个只读工具：

| 工具 | 作用 |
|---|---|
| `search_wiki` | 按关键词搜索已发布资料 |
| `read_wiki_chunk` | 读取某个 chunk 全文 |
| `list_wiki_weeks` | 列出各周资料条数 |

**三个工具的参数里都没有「周数」** —— 教学边界由后端按 `--week` 强制在 SQL 层过滤，模型无法绕过。

---

## 1. 前置准备

### 1.1 启动后端（必须）

```powershell
cd d:\web-dashboard\teaching-server
npx tsx src/server.ts
```

预期：启动日志列出三个新端点（`/api/v1/wiki/search`、`/api/v1/wiki/chunk`、`/api/v1/wiki/weeks`）。

验证（新开一个终端）：

```powershell
(Get-NetTCPConnection -LocalPort 4001 -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count
```

预期 `1`。

### 1.2 构建扩展与 MCP server

```powershell
cd d:\cline
node esbuild.mjs
"EXIT=$LASTEXITCODE"
```

预期 `EXIT=0`，且：

```powershell
Get-Item d:\cline\dist\mcp-wiki-server.js | Select-Object Name,Length
```

预期存在，约 1.5 MB。**若只有 `dist\extension.js` 而没有 `mcp-wiki-server.js`，后面所有用例都会失败。**

### 1.3 启动扩展开发宿主

在 VS Code 中按 **F5**（配置名 `Run Extension`），会弹出一个标题为「扩展开发宿主」的新窗口。

> ⚠️ **所有手工用例都必须在「扩展开发宿主」窗口里操作。**
> 你自己日常用的那个窗口加载的是已安装的旧版本，不会体现本次改动。

---

## 2. 记住这一个路径（后面反复要用）

```
%APPDATA%\Code\User\globalStorage\shiinamatsuri.student-teaching-assistant-edu\settings\cline_mcp_settings.json
```

一键打印：

```powershell
$p = "$env:APPDATA\Code\User\globalStorage\shiinamatsuri.student-teaching-assistant-edu\settings\cline_mcp_settings.json"
Get-Content $p
```

### ⚠️ 路径陷阱（**最容易误判成"功能没做"**）

`getMcpSettingsFilePath(dir)` 只做 `dir + "\cline_mcp_settings.json"`，**不会**自己补一层 `settings\`。
McpHub 读的是 `<globalStorage>\settings\cline_mcp_settings.json`。

如果你发现文件出现在**没有 `settings\` 那一层**的位置：

```
...\globalStorage\shiinamatsuri.student-teaching-assistant-edu\cline_mcp_settings.json   ← 错
...\globalStorage\shiinamatsuri.student-teaching-assistant-edu\settings\cline_mcp_settings.json  ← 对
```

那就是注册逻辑写错了目录。**症状是"什么都没发生"，且不报任何错** —— 文件被写了，但没人读。
这类故障是本项目历史上反复踩的坑，遇到"配置写入了但行为无变化"先查这里。

### 日志在哪看

开发宿主窗口 → 菜单 **视图 → 输出** → 右上角通道下拉里选 **Cline**（找不到就选「扩展宿主」）。

本次改造相关的关键日志行：

| 日志 | 含义 |
|---|---|
| `[WikiMcpRegistrar] 已写入/更新 wiki MCP 条目: <路径>` | 注册（或按新 week 重写）成功 |
| `[WikiMcpRegistrar] wiki MCP 条目已是最新，跳过写入` | 幂等，无变化 |
| `[WikiMcpRegistrar] 检索开关已关闭 → 已移除 wiki MCP 条目: <路径>` | `llmEnableTools=false` 生效 |
| `[Task] Wiki RAG 已注入 (week=N, chunks=M, ragChars=K)` | **核心指标**，见用例 T4 |
| `[LLMWikiService] 拉取成功: max_week=N, chunks=M, baseIds=K` | 索引数据来源 |

---

## 3. 用例清单

编号带 ★ 的是关键用例，**任意一条不过都不得宣告改造完成**。

| 编号 | 用例 | 操作 | 预期 |
|---|---|---|---|
| T1 | 自注册 | 重载宿主窗口 | 配置文件出现 `wiki` 条目 |
| T2 | ★ 删除重建 | 手工删掉 `wiki` 条目 → 重载 | 条目被重建 |
| T3 | ★ 禁用提示 | MCP 面板禁用 wiki | ~2s 内弹警告，可选「重新启用」 |
| T4 | ★ token 不回升 | 禁用后提问，看 `ragChars` | 保持百位量级，**不注入全文** |
| T5 | 失败可见 | 停掉后端后提问 | 对话明确提示检索不可用 |
| T6 | 正常检索 | 问当前周内的问题 | 模型调用 `search_wiki` 并作答 |
| T7 | ★ 超纲提问 | 问「资料在未来周」的知识点 | 告知周次 + 不展开语法 + **不拒答** |
| T8 | ★ 可维护性 | 手工改库后提问 | 取到**新内容**（无客户端陈旧缓存） |
| T9 | 工具无周数参数 | 看 MCP 面板工具 schema | 三个工具**都没有** week 字段 |
| T10 | 思考链仍隐藏 | 任意提问 | 回复中无推理过程 |
| T11 | 干预仍生效 | 连续索取代码 | 触发提示式干预 |
| T12 | ★ 检索开关 | 关掉 `llmEnableTools` → 重载 | 条目**被移除**；打开后重建 |

---

### T1 自注册

**操作**：在开发宿主窗口按 `Ctrl+Shift+P` → `Developer: Reload Window`。

**预期**：配置文件出现 `wiki` 条目，形如：

```json
{
  "mcpServers": {
    "wiki": {
      "type": "stdio",
      "command": "C:\\Users\\<你>\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
      "args": ["d:\\cline\\dist\\mcp-wiki-server.js", "--week", "1", "--server", "http://localhost:4001"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" },
      "autoApprove": ["search_wiki", "read_wiki_chunk", "list_wiki_weeks"],
      "timeout": 30,
      "disabled": false
    }
  }
}
```

**判定依据**：`command` 是 `Code.exe`、`args[0]` 指向 `dist\mcp-wiki-server.js`、`env.ELECTRON_RUN_AS_NODE = "1"`。

**失败长什么样**：
- 条目缺失 → 看日志有没有 `已写入/更新`；没有则注册没被调用
- 条目出现在错误路径 → 见 §2 路径陷阱
- `command` 是 `node` 而不是 `Code.exe` → 打包版可能没有独立 node，会 spawn 失败

---

### T2 ★ 删除重建（对应"删除无效"）

**操作**：
1. 关掉开发宿主窗口（或至少先关掉，避免它马上写回）
2. 从配置文件里手工删掉整个 `"wiki": { ... }` 条目
3. 重新启动开发宿主（F5）

**预期**：条目被重新写入；日志出现 `已写入/更新 wiki MCP 条目`。

**判定依据**：学生无法通过"删配置"永久失掉检索能力。

---

### T3 ★ 禁用提示（对应"禁用可控"）

**操作**：在开发宿主窗口打开 Cline 的 **MCP 面板**，把 `wiki` 切到禁用。

**预期**：约 2 秒内弹出警告：

> 课程资料检索已禁用：AI 将无法获取教师发布的课程资料，可能给出超出教学进度的回答。是否重新启用？
> [重新启用] [保持禁用]

**判定依据**：
- 选 **重新启用** → 配置文件里 `disabled` 变回 `false`，MCP 面板恢复连接
- 选 **保持禁用** → **不再重复弹窗**（把"本来就禁用"当成新事件反复骚扰是不能接受的，这一点由 `detectDisabledTransition` 的"首次读取只做基线"保证）

**失败长什么样**：每次重载都弹一次 → 基线逻辑坏了。

---

### T4 ★ token 不回升（本次改造的核心指标）

**操作**：
1. 确认 `wiki` 处于**未禁用**状态
2. 在开发宿主里发一次提问（比如"第 1 周学了什么？"）
3. 输出面板（Cline 通道）搜 `Wiki RAG 已注入`

**预期**：

```
[Task] Wiki RAG 已注入 (week=1, chunks=<M>, ragChars=<K>)
```

**判定依据**：`ragChars` 为**百位~低千位**（例如 1,500~3,000）。
改造前同一场景是**数千到 13,889**。

**失败长什么样**：`ragChars` 达到 10k 以上 → 全文注入又被挂回去了（检查是否有降级路径复活）。

> 离线实测参考（真实数据 week=18，77 个 chunk）：
> 全文注入 13,889 字符 / 仅覆盖 6/77 chunk（被截断）→ 新索引 2,329 字符（6.0x 缩小）。

---

### T5 失败可见

**操作**：
1. 把后端终端 `Ctrl+C` 停掉
2. 在开发宿主里提问一个需要翻资料的问题

**预期**：对话中明确说明检索当前不可用 / 无法获取资料，**而不是**凭通用知识硬答还假装有依据。

**判定依据**：MCP server 把后端错误转成**结构化错误**返回（`{ ok:false, reason:"..." }`），模型据此说明。

**失败长什么样**：静默降级（不报错也不说明），或者干脆报"未找到资料"却语气笃定。

---

### T6 正常检索

**操作**：恢复后端，问一个**当前周范围内**、且资料里确实有的知识点。

**预期**：模型调用 `search_wiki`（必要时再调 `read_wiki_chunk`），回答里引用到资料内容。

**判定依据**：MCP 面板 → `wiki` → Tools (3)，且 `search_wiki` 被标为 auto-approve（不会弹审批打断）。

---

### T7 ★ 超纲提问（最关键的一条）

**操作**：
1. 先把 `clineTeaching.currentWeek` 改成 `3`（设置里搜 `clineTeaching`）
2. 用下面命令找一条**资料在第 3 周之后**的知识点：

```powershell
(Invoke-RestMethod "http://127.0.0.1:4001/api/v1/wiki?max_week=18").data |
  Sort-Object applicable_week |
  Select-Object applicable_week, title |
  Format-Table -AutoSize
```

挑一个 `applicable_week > 3` 的标题当问题（例如"装饰器怎么用？"）。

**预期**（三件事同时成立）：
1. 告知该知识点将在**第 N 周**讲解
2. 只给**当前进度内**能看懂的基础（不展开高级语法）
3. **不拒答** —— 不是"这个问题超纲我拒绝回答"，而是"现在先这样理解，第 N 周会正式讲"

**判定依据**：这一条拦的是"模型凭通用知识超纲作答"。
注意：**检索边界拦不住这件事** —— 模型完全可以不检索、直接凭训练知识讲装饰器。
所以 system prompt 里的「认知边界约束」段是**必需项**，不是可选装饰。

**失败长什么样**：模型直接开始讲装饰器/生成器/async —— 且没有提周次。

---

### T8 ★ 可维护性（无客户端陈旧缓存）

**操作**：
1. 找到数据库里某个 chunk 的 id
2. 改它的正文：

```sql
UPDATE wiki_chunks SET content = '【改库验证 ' || datetime('now') || '】' WHERE id = '<某个 id>';
```

3. 回到开发宿主，就那个 chunk 的话题提问

**预期**：模型读到的是**你刚写进去的新内容**。

**判定依据**：MCP server 每次调用都实时打后端 HTTP，不在客户端做缓存。
（这条也顺带证明：即使教师端还没做"编辑资料"功能，改库也能立即生效。）

---

### T9 工具无周数参数

**操作**：MCP 面板 → `wiki` → 展开三个工具的 schema。

**预期**：参数如下（已与实现逐一核对）：

| 工具 | 参数 | 必填 |
|---|---|---|
| `search_wiki` | `query`（检索关键词） | ✅ |
| | `limit`（最多返回条数，默认 5，最大 10） | ❌ |
| `read_wiki_chunk` | `chunk_id`（`search_wiki` 返回的 id） | ✅ |
| `list_wiki_weeks` | 无 | — |

**三个工具都没有 week / max_week / 任何可影响周数范围的字段。**

**判定依据**：这是"边界不可绕过"的**接口级**保证 —— 旧实现里 `grep_wiki` 接受模型传 `max_week`，传 18 就能读未来周资料，已随本次改造删除。

---

### T10 / T11 回归项

- **T10 思考链隐藏**：任意提问，回复里不应出现推理过程/思维链。
- **T11 干预仍生效**：连续向模型索取完整代码，应触发提示式教学干预。

这两项与本次改造无关，但改造动了 system prompt 拼接，属于必要回归。

---

### T12 ★ 检索开关（本次新增）

**操作**：
1. 设置里搜 `clineTeaching` → 把 **`llmEnableTools`（是否启用课程资料检索）** 改成 **关闭**
2. 重载窗口 / 观察日志

**预期**：
- 日志出现 `检索开关已关闭 → 已移除 wiki MCP 条目`
- 配置文件里 **`wiki` 条目整个消失**（不是 `disabled: true`）
- MCP 面板里不再有 `wiki`
- **不会**弹出 T3 的那种"检索已禁用，是否重新启用？"警告

**为什么是"移除"而不是写 `disabled:true`**：
写 `disabled:true` 会被禁用检测判定为"学生禁用了检索"并弹提示 ——
但这本来就是学生在设置页自己关的，再问一次属于噪音，且和设置项语义打架。

3. 再把开关打开 → 条目被重新写入、MCP 面板恢复。

---

## 4. 出问题时的排查顺序

按这个顺序查，能覆盖绝大多数情况：

1. **`dist\mcp-wiki-server.js` 存在吗？** 不存在 → 只跑了 `watch` 没跑对配置，或 esbuild 的第二个入口没生效。
2. **配置文件路径对吗？** 见 §2 路径陷阱 —— 尤其检查有没有 `settings\` 这一层。
3. **`--week` 与当前周数一致吗？** `currentWeek` 变了但 args 没重写 → `registerWikiMcpConfigWatcher` 没监听到（它现在监听 `currentWeek` / `serverUrl` / `llmEnableTools` 三个键）。
4. **后端在跑吗？** 端口 4001 有没有监听。
5. **`read_wiki_chunk` 的参数名是 `chunk_id`**（不是旧实现的 `chunkId`）；传错会得到结构化错误而不是崩溃。
6. **JSON 文件有 BOM 吗？** 用 PowerShell 的 `Set-Content -Encoding utf8` 会写 BOM，McpHub 的 `JSON.parse` 失败后会**静默跳过重载** —— 表现为"改了配置但没反应"。用 `[System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding $false))` 才是无 BOM。
