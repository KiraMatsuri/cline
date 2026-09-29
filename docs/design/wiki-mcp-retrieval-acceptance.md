# Wiki MCP 检索改造 — 验收记录

> 执行日期：2026-09-29
> 对应设计：`wiki-mcp-retrieval-design.md` §7 测试策略
> 手工步骤：`wiki-mcp-retrieval-manual-test.md`
>
> **状态约定**：✅ 已实测通过　⏳ 待手工执行　⬜ 未开始

---

## 0. 结论摘要

| 层面 | 状态 | 证据 |
|---|---|---|
| 后端端点（脚本化） | ✅ | `17 passed, 0 failed` |
| MCP server（端到端，`node.exe`） | ✅ | `16 passed, 0 failed` |
| MCP server（端到端，`Code.exe`） | ✅ | `16 passed, 0 failed` |
| 单元测试 | ✅ | `749 passing / 111 pending / 0 failing` |
| 类型检查（扩展 + webview） | ✅ | `tsc --noEmit` 两侧均零输出 |
| 构建 | ✅ | `node esbuild.mjs` → `EXIT=0`，`dist/mcp-wiki-server.js` 1.53 MB |
| 配置文件自注册 / 禁用 / 重启用 | ✅ | Task 5、Task 6 宿主实测 |
| token 不回升（`ragChars`） | ⏳ | 离线已实测，**宿主侧待确认** |
| 边界类行为（超纲提问、失败可见、改库取新内容） | ⏳ | 待手工执行 |
| 检索开关（`llmEnableTools`） | ⏳ | 本次新增，待手工执行 |

---

## 1. 服务端（脚本化验证）

命令：

```powershell
cd d:\web-dashboard\teaching-server
node scripts\verify-wiki-search.mjs
```

结果：**17 passed, 0 failed**（`EXIT=0`）

| 用例 | 期望 | 实际 | 结论 |
|---|---|---|---|
| `week=0` / `19` / `-1` / `abc` | 400 | 400 | ✅ |
| `week=5` 检索 | 200、`ok:true`、`data` 为数组 | 一致 | ✅ |
| 每条命中都带 `applicable_week` | 是 | 是 | ✅ |
| 空 `q` 仍可列出（浏览） | 200 | 200 | ✅ |
| ★ `week=3` 结果无第 4 周内容 | 无越界条目 | 无 | ✅ |
| `limit=999` 被 clamp | 结果 ≤ 10 | ≤ 10 | ✅ |
| chunk 端点取真实 chunk | `textbook_python/27__chunk0` 可取 | 可取 | ✅ |
| `week=17` 取不到第 18 周 chunk | 否则 404 | 404 | ✅ |
| 不存在的 chunk | 404 | 404 | ✅ |
| `weeks` 端点 | 200、数组、不越界 | 一致 | ✅ |

> **设计要点**：`applicable_week <= week` 的过滤在 **SQL 层**完成 —— 这是教学边界唯一可信的防线。

---

## 2. MCP server（端到端）

命令：

```powershell
cd d:\cline
node esbuild.mjs
$env:SERVER="http://127.0.0.1:4001"; $env:WEEK="5"
node scripts\verify-mcp-wiki-server.mjs

# 再用与 McpHub 真实 spawn 路径一致的运行时复跑一遍
$env:MCP_RUNTIME="C:\Users\Kirara\AppData\Local\Programs\Microsoft VS Code\Code.exe"
node scripts\verify-mcp-wiki-server.mjs
```

结果：**两个运行时均 `16 passed, 0 failed`**（`EXIT=0`）

| 用例 | 期望 | 实际 | 结论 |
|---|---|---|---|
| 暴露三个工具 | 3 个 | 3 个 | ✅ |
| ★ 工具参数中不含任何周数字段 | 无 | 无 | ✅ |
| `search_wiki` 返回 `ok` 且非空 | 非空 | 非空 | ✅ |
| ★ 结果不越过第 5 周 | 无越界 | 无越界 | ✅ |
| `read_wiki_chunk` 取到内容 | 有内容 | 有内容 | ✅ |
| 不存在的 chunk → `not_found_or_out_of_scope` | 结构化错误 | 一致 | ✅ |
| `list_wiki_weeks` 返回非空且不越界 | 非空 | 非空 | ✅ |
| ★ **判别力对照**：`week=3` 检索「函数」非空 | 非空 | 非空 | ✅ |
| ★ `week=18` 结果中存在 >3 周条目 | 存在 | 存在 | ✅ |
| ★ 同一关键词：`week=3` 无越界条目 | 无 | 无 | ✅ |
| ★ `week=3` 与 `week=18` 结果集不同 | 不同 | 不同 | ✅ |
| ★ 越界读取真实 chunk（第 18 周）→ 结构化拒绝 | `not_found_or_out_of_scope` | 一致 | ✅ |
| 后端不可达 → 返回 `error` 而非崩溃 | 结构化错误 | 一致 | ✅ |

> **为什么加"判别力对照"**：早期版本的 ★ 断言在**后端完全不可达**时也会通过（空数组必然满足"无越界条目"）。
> 这类**空洞通过**是本次验收中对比出来的最危险问题。加固方式是给每条边界断言配一对"非空前提"+
> "两个不同 week 的结果必须不同"。加固后红灯会从 2 条变成 9 条，脚本才真正具备判别力。

---

## 3. VS Code 内手工验收

| 用例 | 操作 | 期望 | 实际 | 结论 |
|---|---|---|---|---|
| 自注册 | 重载窗口 | 出现 `wiki` 条目 | 条目写入**正确路径**，错误路径**未被创建** | ✅ |
| ★ 删除重建 | 删条目 → 重载 | 条目被重建 | 重建成功 | ✅ |
| ★ 进程真的被拉起 | 看进程列表 | `Code.exe <dist>\mcp-wiki-server.js --week N --server ...` | `PID 16008 :: Code.exe d:\cline\dist\mcp-wiki-server.js --week 1 --server http://localhost:4001` | ✅ |
| 周数变化重写 | 周数 1 → 2 | args 重写 + 进程重启 | args 变 `--week 2`，新进程 `PID 14580` | ✅ |
| ★ 禁用提示 | MCP 面板禁用 `wiki` | ~2s 内弹警告 | ~2s 弹出；`disabled=true`；PID 被杀死 | ✅ |
| ★ "保持禁用"不重复 | 选保持禁用 | 不再弹 | 不再弹 | ✅ |
| 重新启用 | 选「重新启用」 | `disabled` 回 `false`、进程重生 | `disabled=False`，mtime `21:37:25`，`PID 23620` | ✅ |
| ★ MCP 面板工具 schema | 展开三个工具 | 无 week 参数 | `Tools (3)`、`timeout: 30`、auto-approve 已勾选、**schema 无 week** | ✅ |
| ★ token 不回升 | 提问后看 `ragChars` | 百位量级 | ⏳ 待执行（T4） | ⏳ |
| 失败可见 | 停后端后提问 | 提示检索不可用 | ⏳ 待执行（T5） | ⏳ |
| 正常检索 | 问当前周内问题 | 调用 `search_wiki` 作答 | ⏳ 待执行（T6） | ⏳ |
| ★ 超纲提问 | `week=3` 问「装饰器」 | 告知周次 + 不展开语法 + **不拒答** | ⏳ 待执行（T7） | ⏳ |
| ★ 可维护性 | 改库后提问 | 取到**新内容** | ⏳ 待执行（T8） | ⏳ |
| 思考链仍隐藏 | 任意提问 | 无推理过程 | ⏳ 待执行（T10） | ⏳ |
| 干预仍生效 | 连续索取代码 | 触发提示式干预 | ⏳ 待执行（T11） | ⏳ |
| **★ 检索开关（新增）** | 关 `llmEnableTools` → 重载 | 条目**被移除**；打开后重建 | ⏳ 待执行（T12） | ⏳ |
| **★ 教材目录（新增）** | 未 `publish-as-wiki` 的教材 | 章节标题出现在索引里 | ⏳ 待执行 | ⏳ |

---

## 4. 离线定量对比（真实数据，week=18，77 个 chunk）

| 指标 | 改造前（全文注入） | 改造后（索引注入） | 变化 |
|---|---|---|---|
| 注入字符数 | 13,889 | 2,329 | **6.0x 缩小 / −83.2%** |
| 覆盖 chunk 数 | 6 / 77（**被截断**） | 索引覆盖全部标题，正文按需检索 | 不再截断 |

> 这组数字是本次改造的直接动机验证：旧实现不是"注入得少"，而是**注入了却在边界处盲截断**
> （按 `week+id` 字典序），导致资料越多、越靠后的内容越读不到。

---

## 5. 实施过程中发现并修正的计划问题

| # | 问题 | 处理 |
|---|---|---|
| 1 | 计划 Task 0 笔记称 `getMcpSettingsFilePath` 会补 `settings/` | **错**。它只做 `path.join(入参, "cline_mcp_settings.json")`。McpHub 传的是 `ensureSettingsDirectoryExists()`。按笔记实现会写入 McpHub 永不读取的文件 → 静默失效。已在代码、计划、`.clinerules/general.md` 三处修正 |
| 2 | 禁用检测"首次读取即判定跃迁" | 会导致每次激活都弹一次警告，与「禁用可控」矛盾。改为**首次只建立基线** |
| 3 | `process.exit()` 在 Node 24 / Windows 下触发 libuv 断言崩溃 | 脚本统一改用 `process.exitCode` |
| 4 | PowerShell `Set-Content -Encoding utf8` 写 BOM | BOM 会让 McpHub 的 `JSON.parse` 失败并**静默跳过重载**。脚本改用 `UTF8Encoding($false)` |
| 5 | 计划自称"无新增类型错误"，实际基线 | 实测扩展侧与 webview 侧 `tsc --noEmit` **均为零错误**，无基线错误 |
| 6 | 计划 Task 7/8 分为两个 commit | `LLMWikiService.ts` 同时承载 Task 7 新增与 Task 8 删除，按文件粒度无法拆出可独立通过类型检查的中间提交 → 合并为 `dc223f45` |
| 7 | 计划 Task 8 表要求删 `TOTAL_CONTEXT_CHARS`，保留行又要求保留依赖它的 `_buildTextbookContext()` | 真保留会触发 Biome `defined but never used`。按"全文路径必须彻底消失"一并删除 |
| 8 | 计划 Task 9 用 `McpHub.getInstance?.()` / `getMcpServers?.()` | **API 不存在**。`McpHub` 只能从 `WebviewProvider.getInstance().controller.mcpHub` 取，方法是 `getServers()`。按计划写会**永远判定"不可用"且不报错**（与 #1 同类的静默失效）。已按实际 API 实现，并加单测锁住该陷阱 |
| 9 | 计划未定义 `llmEnableTools` 的消费方 | 改造后该方法已无读者，设置项会变成"纯记录项"。经确认接线：**关闭时移除 wiki 条目**（而非写 `disabled:true`，避免触发误导性的"是否重新启用"提示），默认值改 `true` |
| 10 | 计划保留行称"教材章节仍用于索引生成"，但 `buildIndexGroups()` 只读 `_wikiCache` | 若教师尚未 `publish-as-wiki`，教材内容会对模型完全隐形。经确认**把教材章节标题并入索引**（只取周 + 标题，不含正文） |

---

## 6. 遗留风险

1. **`--week` 与实际进度的一致性**：MCP server 的周数由配置文件里的 args 决定，进程启动后不会自己更新。
   若 `currentWeek` 变更时 watcher 未触发重写，检索范围会停留在旧值。
   当前由 `registerWikiMcpConfigWatcher` 监听 `currentWeek` / `serverUrl` / `llmEnableTools` 三个键来保证。
   ⚠️ **这是"边界正确性"的单点**，值得在后续版本加自检（例如启动时比对 args 与 currentWeek 并记 warn）。
2. **打包产物**：F5 走的是仓库路径（`d:\cline\dist\mcp-wiki-server.js`），**不覆盖打包场景**。
   发布前需确认 `.vsix` 内包含 `dist/mcp-wiki-server.js`，否则安装版会因为找不到脚本而 spawn 失败。
3. **后端不可达时的表现**依赖模型把结构化错误转述给学生，而非我们直接拦截 —— 属于"提示式"而非"强制式"。
