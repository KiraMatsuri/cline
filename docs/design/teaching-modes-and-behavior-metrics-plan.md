# 教学会话模式与行为指标改造 · 实施计划

> 版本 **v1.0**（2026-10-23）
> 上游设计：[teaching-modes-and-behavior-metrics-design.md](teaching-modes-and-behavior-metrics-design.md)（541 行，Q1–Q8 已全部裁定）
> 关联既有系统：[teaching-submission-bundle-design.md](teaching-submission-bundle-design.md)、[teaching-submission-implementation-plan.md](teaching-submission-implementation-plan.md)、`D:\web-dashboard\docs\design\dashboard-log-source-plan.md`

---

## 0. 文档定位与已裁定事项

### 0.1 本计划要做什么

把上游设计落成**可执行、可验证、可回滚**的改造序列，覆盖 4 件事：

1. **去周数**：学生端不再有「第 x 周」，llm-wiki 检索改为**按提问内容**召回（教学端 SQL 的周边界一并去掉）。
2. **双模式**：自由问答模式（不记日志、不干预、引导式、3 次放行完整代码）与实验任务模式（任务详情面板 → 开始实验 → 独立子工作区 + 实验指导 + 全程记录）。
3. **行为六分类 + 依赖度加权**：`concept / design / error_help / self_code / ai_code / other`，权重 `0.25 / 0.75 / 1.0 / 0 / 1.2`；删除 60 秒阻断式干预，改 6 条软提示。
4. **指标口径统一**：看板、报告、教学端入库三处共用一份 `metricsSpec`，旧数据标记 `metrics_schema='legacy'` 不重算。

### 0.2 用户裁定（2026-10-23，m05061）

| # | 事项 | 结论 |
|---|---|---|
| R1 | 伪代码算不算「助手编程」 | **算**。逻辑完整、翻译为对应语言后可直接运行的伪代码 → `ai_code`（`codeKind="pseudo_complete"`）；骨架/方向性伪代码 → `design` |
| R2 | 其余 7 项 | **全部按设计文档推荐值**（Q1 权重、Q3 目录名、Q4 计数范围、Q5 实验模式不给完整实现、Q6 不重算历史、Q7 保留 `queryType`、Q8 保留模型撰写文案） |
| R3 | 过程要求 | **每完成一项完整修改必须测试**；全部完成后测**全流程**并覆盖**边界条件**；通过后 `git commit` + 更新两个仓库的 `CHANGELOG` |

### 0.3 测试分层（本计划的「一项改动=通过一次测试」如何判定）

| 层 | 形式 | 跑法 | 用于 |
|---|---|---|---|
| L1 单测 | mocha（`D:\cline`）/ `tsx` 脚本（教学端） | `npm run test:unit`、`npx tsx scripts/xxx.ts` | 纯函数、状态机、分类器、校验器 |
| L2 闸门 | 真 SQLite + 真 HTTP（临时 DATA_DIR / 临时端口） | `npx tsx scripts/check-*.ts`、`node scripts/check-*.mjs` | 路由、入库、报告、看板、检索 SQL |
| L3 构建门 | `tsc --noEmit`（两处）、`npm run build`（webview/frontend）、`node esbuild.mjs` | 见 §9 | 类型与打包不退化 |
| L4 全流程 | 单脚本串起「发布任务 → 开始实验 → 答疑 → 提交 → 报告 → 看板」 | `node scripts/check-teaching-flow.mjs` | 端到端 + 边界矩阵 |

**判定规则**：每项任务的「测试」小节里列出的命令**全部通过**才可勾掉该项；进入下一项前重跑一遍**上一项**的闸门（防回归）。任一项失败 → 修到通过，不跳过。

### 0.4 计划外不做

- §10 前端「预期展示 vs 实际实现」18 项（`D:\web-dashboard\docs\design\dashboard-log-source.md` §10）——按 m04655 另开任务。
- 教师端鉴权 / `TEACHER_TOKEN`、事件表（`dashboard_events`）、日志上传链路改造（已上线，不动）。
- 报告页历史版本入口、代码预览 Modal。

---

## 1. 优先级与工作量

| 优先级 | 内容 | 任务数 | 人日 | 可独立上线 |
|---|---|---|---|---|
| **P0** | 去周数（教学端 SQL + 扩展 UI/配置/MCP + 预召回注入 + 附件正文） | 5 | 3.5 | 是（检索变了，日志格式不变） |
| **P1** | 双模式（会话模式判定、任务详情面板、实验子工作区、实验指导、上下文装配） | 7 | 5.5 | 是（依赖 P0 的检索） |
| **P2** | 行为与指标（六分类、删阻断、软提示、三端 spec、迁移 v3、E2E） | 7 | 6.0 | 是（依赖 P1 的 `mode`） |
| 合计 | | **19** | **15.0** | |

依赖关系：`P0-1 → P0-2 → P0-3`（检索链）、`P0-4` 可与 P0-3 并行；`P1-1 → P1-2 → P1-3 → P1-4 → P1-5`；`P2-1 → P2-2 → P2-3`，`P2-4` 依赖 `P2-1`，`P2-5` 依赖 `P2-4`，`P2-6` 依赖全部。

---

## 2. 全流程定义（E2E 的验收对象）

一条完整的教学流程，共 6 步，任何一步断了都不算跑通：

```
① 教师端发布任务（标题/描述/指导书附件/模板代码）
        ↓
② 学生端点「实验任务」→ 任务详情面板（标题、描述、指导书正文或下载、附件、模板预览）
        ↓
③ 点「开始实验」→ 生成 experiments/<assignmentId>/{模板, GUIDE.md, attachments/, .cline-logs/, .teaching/task.json}
        ↓
④ 答疑（引导式：方向 → 思路 → 具体步骤；第 4 次索要才给伪代码）+ 学生自己编码/调试（run_traces）
        ↓
⑤ 点「提交」→ 出题面板 → 确认 → bundle 上传（代码 + 日志 + 运行痕迹 + 答案）
        ↓
⑥ 教师端「学生实验报告」看答案与代码；「学情画像看板」看 depIndex / 行为分布 / 引导有效性
```

**自由问答模式**走 ②′：不建实验目录、不写日志、仍可用 wiki，答疑阶梯为 3 次放行完整代码。

---

## 3. 三端字段对照（契约单一来源）

改造后一条学生请求在链路上的形态：

| 层 | 字段 | 说明 |
|---|---|---|
| 日志事件（`types.ts`） | `behaviorType` / `behaviorWeight` / `behaviorSource` / `behaviorSignals` / `mode` / `experimentId` / `codeKind` | 新增后 7 项；`queryType` 保留并映射 |
| 提交包 meta | `mode` / `experiment_id` / `metrics_schema` / `client_version` | `bundleContract.ts` 与 `bundleTypes.ts` 同步 |
| DB `submissions`（v3） | `mode` / `experiment_id` / `dep_index` / `self_coding_ratio` / `adoption_deepening` / `guidance_effect` / `error_resolution_rate` / `behavior_mix`(JSON) / `metrics_schema` | 迁移 v3 |
| 报告 API | `metrics{depIndex,selfCodingRatio,adoptionDeepening,guidanceEffect,errorResolutionRate,behaviorMix,metricsSchema}` | `reportService.ts` |
| 看板事件 API | 事件原样透传 `behaviorType/mode/experimentId` | `dashboardEvents.ts` 无需改 SQL |

**统一公式（三端同源，`metricsSpec` 常量）**

```
w      = { concept: 0.25, design: 0.75, error_help: 1.0, self_code: 0, ai_code: 1.2 }
W      = 1.2                                   // 归一化基准（ai_code 权重）
N      = 参与的六类事件数，other 不计（分子分母都不计）
depIndex          = Σ(w × count) / (W × N)     // ∈ [0,1]
selfCodingRatio   = self_code / (self_code + ai_code)              // 分母 0 → null
adoptionDeepening = selfEditsAfterAdoption / adoptions             // 分母 0 → null
guidanceEffect    = 1 - ai_code / demands                          // demands 0 → null
errorResolutionRate = resolvedErrors / error_help                  // 分母 0 → null
behaviorMix       = { concept, design, error_help, self_code, ai_code, other } 计数
```

> 说明：`ai_code` 含「完整实现」与 `pseudo_complete` 两种形态（R1），按同一权重计入 —— 这正是学生要求的「伪代码也算助手编程」。

---

## 4. P0：去周数（3.5 人日）

### P0-1 教学端 wiki 检索去周数 + 相关度排序（0.8）

**目标**：`/api/v1/wiki/search|chunk|weeks` 在**不带 week** 时检索全部已发布资料；带旧 `week` 参数**接受但忽略**并回 `meta.week_ignored=true`（灰度期旧插件不报错）。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| `D:\web-dashboard\teaching-server\src\wikiSearch.ts` | `:46 searchWiki` | 签名改 `opts: { week?: number; maxWeek?: number; q: string; limit: number }`；SQL 条件改为「`maxWeek` 给出时 `applicable_week <= ?`，否则不加条件」；排序改**相关度**：标题命中 > 正文命中次数 > `applicable_week DESC` > `chunk_index`（正文命中次数用 `(length(content) - length(replace(content, ?, ''))) / length(?)` 近似，词数按 `LIKE` 命中粗算） |
| 同上 | `:98 getChunk` | `week` 可选；不给时不加 `applicable_week <= ?` |
| 同上 | `:113 listWeeks` | `week` 可选；不给时分组统计全部周（供教师端统计，学生端不再用） |
| 同上 | `:12 clampWeek` | 保留（教师端仍用），新增 `clampMaxWeek`（1..18，非法→undefined） |
| `D:\web-dashboard\teaching-server\src\server.ts` | `:1516 /wiki/search` | 读 `q/limit/week/max_week`；`week` 只在 `max_week` 缺省时作为 `maxWeek` 兼容（日志 warn）；响应 `meta:{week_ignored:boolean, max_week:number\|null, total, ordered_by:"relevance"}` |
| 同上 | `:1543 /wiki/chunk`、`:1573 /wiki/weeks` | 同步去掉必填 week；越界语义保留（chunk 不存在 → 404） |

**测试**

```powershell
cd D:\web-dashboard\teaching-server
npx tsx scripts/check-wiki-search.ts        # 新建：直连 wikiSearch + 临时 SQLite
node  scripts/check-wiki-routes.mjs         # 新建：起临时服务打 3 个端点
```

断言（`check-wiki-search.ts`，≥18 条）：
1. 无 week → 同时返回第 3 周与第 12 周的 chunk（证明不再按周截断）；
2. `maxWeek=8` → 只有 ≤8；
3. 关键词命中**标题**的 chunk 排在只命中正文的前面；
4. 空 `q` → 浏览模式，按 `applicable_week DESC`；
5. `limit` 夹取 1..50（`0`→1、`999`→50、`abc`→默认 10）；
6. `getChunk` 无 week 可取任意 chunk；不存在 id → `null`；
7. `listWeeks` 无 week 返回全部周计数，合计 = 总行数。

断言（`check-wiki-routes.mjs`，≥10 条）：
8. `GET /api/v1/wiki/search?q=列表` 200 且 `meta.week_ignored=false`；
9. `GET .../search?q=列表&week=8` 200 且 `meta.week_ignored=true`、结果与不带 week **完全一致**；
10. `GET .../search?q=列表&max_week=3` → 全部 `applicable_week<=3`；
11. `GET .../chunk?id=<存在>` 200；不存在 → 404 `{ok:false}`；
12. `GET .../weeks` 200 数组元素 `{week,count}`。

**边界**：BN-01（0 条资料）、BN-02（q 只有空格）、BN-03（q 含 `%`/`_` 通配符 → 必须转义）、BN-04（`max_week=0/19/abc`）。

**完成标准**：两个脚本全绿；`npx tsc --noEmit` 无新增错误（基线 11 条不变）。

---

### P0-2 扩展侧删周数（1.2）

**目标**：插件里不再存在「当前教学周」这一概念 —— 配置项、状态栏控件、MCP `--week`、共享周文件全部移除；旧工作区里的 `teaching-week.json` **不主动删**（避免动学生文件），但不再被读取。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| `D:\cline\package.json` | `:445-451` | 删除 `clineTeaching.currentWeek` 配置项；`grep` 确认没有其它引用 |
| `D:\cline\webview-ui\src\components\common\WikiWeekSelector.tsx` | 整个文件 | 删除 |
| `D:\cline\webview-ui\src\components\common\Navbar.tsx` | `:103` | 移除 `<WikiWeekSelector />` 与相关 import |
| `D:\cline\src\hosts\vscode\VscodeWebviewProvider.ts` | 周相关 postMessage | 删除 `currentWeek` 推送与 `updateCurrentWeek` 处理 |
| `D:\cline\src\core\teaching\LLMWikiService.ts` | `:145-153,188,193,416-420` | 删除 `currentWeek` 字段、`setWeek()`、监听配置里的周变化；`buildIndexGroups()` 不再返回 `week` |
| `D:\cline\src\core\teaching\WikiMcpRegistrar.ts` | `:54-78,238-247`（`:65` 的 `--week`） | 去掉 `--week` 参数；不再写 `week` 字段 |
| `D:\cline\src\core\teaching\weekStatePath.ts`、`weekStateFile.ts` | 整个文件 | 删除（含 2 个单测） |
| `D:\cline\src\core\teaching\mcp-wiki-server.ts` | `:31-37` | 删除 `effectiveWeek`（原本「文件 > 参数」），工具描述去掉周字样 |
| `D:\cline\src\core\teaching\wikiPrompt.ts` | `:19-81` | 索引段去掉 `第 N 周`；保留「认知边界约束」 |
| `D:\cline\webview-ui\src\components\teaching\AssignmentTab.tsx` | `:923-956` | 删除「📅 学习进度」死控件 |
| `D:\cline\webview-ui\src\components\teaching\AssignmentHeader.tsx` | 整个文件 | 删除（无引用） |

**测试**

```powershell
cd D:\cline
$env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "wiki|周"
npx tsc --noEmit ; cd webview-ui; npx tsc --noEmit
cd ..; node esbuild.mjs            # 产出 dist/mcp-wiki-server.js
node scripts/verify/mcp-wiki-server.mjs   # 新建：stdio 握手 + tools/list + tools/call
```

断言（新单测 `__tests__/noWeekConfig.test.ts`，≥6 条）：
1. `package.json` 的 `contributes.configuration.properties` 无 `currentWeek`；
2. `src/**` 无 `currentWeek` / `setWeek(` / `weekStateFile` 引用（白名单：`clampWeek` 注释、迁移说明）；
3. `webview-ui/src/**` 无 `WikiWeekSelector`；
4. `mcp-wiki-server` 的 `tools/list` schema 中 `search_wiki` 无 `week` 字段；
5. `wikiPrompt` 生成的索引不含「第 x 周」正则；
6. `WikiMcpRegistrar` 生成的 args 里没有 `--week`。

断言（`scripts/verify/mcp-wiki-server.mjs`，≥8 条）：
7. `initialize` 握手成功、`serverInfo.name` 存在；
8. `tools/list` 返回 3 个工具；
9. `tools/call search_wiki {q:"列表"}` 返回 `content[0].text` 且为 JSON；
10. 缺少 `q` → 返回错误而非崩溃；
11. 过程在 5s 内退出（`kill` 正常）。

**边界**：BN-05（旧工作区存在 `teaching-week.json` → 不读、不报错）、BN-06（旧 `cline_mcp_settings.json` 里残留 `--week` → 注册器重写时清掉）。

**完成标准**：单测 + 两个 tsc + `esbuild.mjs` + MCP 脚本全绿；`dist/` 与 `webview-ui/build/` 可正常产出。

---

### P0-3 提问预召回 + 引导式提示词（0.8）

**目标**：学生提问时，插件**先用提问原文**向教学端 `/api/v1/wiki/search` 预召回 top 3 片段（合计 ≤1600 字）注入 system prompt；MCP 工具保留作深挖。检索失败静默降级为仅索引。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| `D:\cline\src\core\teaching\wikiBackend.ts` | `:45-56` | 新增 `searchWikiBackend({q, limit})` → `{hits, error}`，3s 超时 + 5 分钟 LRU（key=query hash） |
| `D:\cline\src\core\teaching\LLMWikiService.ts` | 新增 `recallForQuestion(q)` | 返回 `{lines[], totalChars, error?}`；单片段 `title + 正文前 400 字`；去重按 chunk id；命中合计超预算时按相关度截断 |
| `D:\cline\src\core\teaching\wikiPrompt.ts` | 新增 `renderRecallSection` | 输出「## 参考教材片段（按相关度，仅供引用）」+ 每条 `**[n] 标题**\n正文`；尾部加「引用资料时标注标题，不要编造」 |
| `D:\cline\src\core\task\index.ts` | `:2427`（注入点）、`:2581-2589`、`:2595-2603` | 在拼 system prompt 时 `await recallForQuestion(userText)`；预算 `WIKI_RECALL_CHARS = 1600`；失败只 warn |

**测试**

```powershell
cd D:\cline
$env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "wikiRecall|wikiPrompt"
```

断言（新单测 `__tests__/wikiRecall.test.ts` + 更新 `wikiPrompt.test.ts`，≥12 条）：
1. 3 条命中 → 3 段、总字数 ≤1600；
2. 命中 5 条 → 只取前 3（相关度序）；
3. 单段正文 2000 字 → 截到 400 字 + 省略号；
4. 无命中 → 返回空、prompt 里出现「本次未检索到相关资料」而非报错；
5. 后端 500 / 超时 → `error` 有值、prompt 仍生成（降级）、耗时 <3.2s；
6. 同 query 二次调用命中缓存（`Date.now` 不变时 backend 只被调 1 次）；
7. prompt 含标题且含「标注标题」约束；
8. 自由模式与实验模式都注入（`mode` 不影响召回）；
9. 空提问 → 不召回、不抛错。

**边界**：BN-07（教学端不可达）、BN-08（返回超大正文）、BN-09（`q` 含换行/emoji）、BN-10（缓存别名：同义 query 不串味）。

**完成标准**：单测全绿；`tsc --noEmit` 0 新增。

---

### P0-4 附件正文读取（0.6）

**目标**：任务详情面板要展示指导书正文（md/txt/docx/pdf），因此需要「读取附件文本」的能力：教学端提供 `text` 端点，扩展侧加 `fetchAttachmentText`。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| `D:\web-dashboard\teaching-server\src\server.ts` | `:865-901` 附件下载附近 | 新增 `GET /api/v1/assignments/:id/attachments/:fileId/text`：复用 `officeParser.ts` 抽取文本；`maxChars=200000` 截断；类型不支持 → 415 `TEXT_UNSUPPORTED`；文件缺失 → 404；返回 `{ok, text, truncated, mime, chars}` |
| `D:\web-dashboard\teaching-server\src\officeParser.ts` | 复用 | 若既有 `extractText` 不支持 md/txt，补纯文本分支（utf8 读入 + 去 BOM） |
| `D:\cline\src\core\teaching\AssignmentManager.ts` | `:1307-1386` 下载逻辑旁 | 新增 `fetchAttachmentText(assignmentId, attachmentId)` → `{text, truncated}`；失败返回 `{error}` 不抛 |

**测试**

```powershell
cd D:\web-dashboard\teaching-server
npx tsx scripts/check-attachment-text.ts     # 新建：临时库 + 三种附件（md/txt/pdf）+ 一个 .exe
cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "attachment"
```

断言（≥10 条）：
1. md/txt 文件 → 文本逐字一致（含中文、`\r\n` 归一）；
2. pdf（用仓库内已有样例或生成的最小 pdf）→ 抽取非空、`truncated=false`；
3. 200KB 以上 → `truncated=true` 且 `chars=200000`；
4. `.exe` → 415 `TEXT_UNSUPPORTED`；
5. 文件被删 → 404；
6. 附件不属于该任务 → 404（防越权）；
7. 扩展侧 `fetchAttachmentText` 对 415/404/超时都返回 `{error}`，面板显示「附件无法预览，可下载」；
8. 下载按钮回执（`AssignmentManager.ts:1376-1380`）在前端有接收分支（P1-2 使用）。

**边界**：BN-11（零字节附件）、BN-12（附件名中文/含空格）、BN-13（同一任务 10 个附件只看第 1 个）。

**完成标准**：两个脚本全绿；`tsc` 无新增。

---

### P0-5 P0 汇总闸门（0.1）

```powershell
cd D:\cline; npx tsc --noEmit; cd webview-ui; npx tsc --noEmit; cd ..
$env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha          # 基线 1291 passing / 111 pending
cd D:\web-dashboard\teaching-server; npx tsc --noEmit                 # 仅 11 条基线
node scripts/contract-check.mjs                                       # 57/57（含看板组）
npx tsx scripts/check-dashboard-events.ts                             # 30/30
cd ..\backend; node scripts/check-dashboard-source.mjs                # 49/49
node scripts/check-bundles.mjs                                        # 37/37
```

**完成标准**：全绿 + 现有 `wiki` 相关手工步骤（M-70 前置）无退化。

---

## 5. P1：双模式（5.5 人日）

### P1-1 会话模式判定与门控（0.8）

**目标**：单一判定点决定「当前是自由模式还是实验模式」，并据此门控日志、干预、wiki、阶梯阈值。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| 新增 `D:\cline\src\core\teaching\TeachingSessionMode.ts` | — | `export type SessionMode = "free" \| "experiment"`；`interface SessionContext {mode; experimentId?; logRoot; ladderLimit}`；`resolveSessionMode(task?)`：存在 `experimentId`（来自 `task.json`/`initialState`）→ `experiment`，否则 `free`；`logPersistEnabled(ctx)`、`interventionEnabled(ctx)`、`wikiEnabled(ctx)`（恒 true）、`ladderLimit(ctx)`（free=3 / experiment=4） |
| `D:\cline\src\core\task\index.ts` | `:1297-1570` 日志写入点 | 写日志前 `if (!logPersistEnabled(ctx)) return`；事件补 `mode` 与 `experimentId` |
| 同上 | `:2427`、`:2581-2603` | 注入 wiki 上下文不受 mode 影响（保持） |
| `D:\cline\src\core\task\student-analytics\StudentLogPersister.ts` | `:14-38` | 新增 `mode`、`experimentId` 参数透传；`file_save` 等多步事件补 `mode` |
| `D:\cline\src\core\teaching\TeachingInterventionManager.ts` | 调用方 | 自由模式 `interventionEnabled=false` 时直接跳过（P2-3 收尾时统一） |

**测试**

```powershell
cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "sessionMode|modeLogging"
```

断言（≥14 条）：
1. 无 `task.json` → `free`；有 → `experiment` 且 `experimentId` 等于目录名；
2. free：`logPersistEnabled=false`、`interventionEnabled=false`、`wikiEnabled=true`、`ladderLimit=3`；
3. experiment：`true/true/true/4`；
4. free 模式连续 3 条学生事件 → 日志文件**零新增行**（用临时目录断言 mtime/大小不变）；
5. free 模式仍写 `run_traces.jsonl`（运行报错可追踪，需求明确）；
6. experiment 模式写 `student_interactions.log` 且首行带 `mode:"experiment"`；
7. 模式判定不受「当前打开的编辑器文件」影响；
8. 会话恢复（`initialState` 里带 `experimentId`）→ 仍是 experiment；
9. 目录被手工删除后恢复 → 判定为 experiment 但 `logRoot` 回退默认并 warn（BN-20）；
10. 两个并行任务一个 free 一个 experiment → 各自门控正确。

**边界**：BN-14（`task.json` 损坏 JSON）、BN-15（`experimentId` 含中文）、BN-16（free 模式下提问频率极高不产生日志增长）。

**完成标准**：单测全绿 + `tsc` 0 新增。

---

### P1-2 任务详情面板（1.2）

**目标**：点任务 → VS Code 编辑器区面板显示标题/描述/指导书正文/附件下载/模板预览 + 「开始实验」；取消双击建文件。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| 新增 `D:\cline\src\hosts\vscode\AssignmentDetailPanelProvider.ts` | — | 仿 `FeedbackPanelProvider.ts:1-211`：`viewId="clineAssignmentDetailPanel"`、单例、`reveal(payload, handlers)`、消息 `openAttachment`/`startExperiment`/`close` |
| 新增 `D:\cline\webview-ui\src\components\teaching\AssignmentDetailForm.tsx` | — | 展示 + 按钮；附件列表 `onClick` 发下载；模板用 `<pre>` 折叠；「开始实验」禁用条件（已开始则显示「继续实验」） |
| `D:\cline\webview-ui\src\App.tsx` | `:40-42` 旁 | 新增 `data-view` 分支 `clineAssignmentDetailPanel` |
| `D:\cline\webview-ui\src\components\teaching\AssignmentTab.tsx` | `:819-838`（列表）、`:825`（双击）、`:851-913`（详情区） | 单击 → `openAssignmentDetail`；删除双击 `createOneFile`；原内嵌详情区收敛为「打开详情面板」按钮（保留列表卡片） |
| `D:\cline\src\core\teaching\AssignmentManager.ts` | `:382-475` 消息 switch、`:1231-1264` | 新命令 `openAssignmentDetail`、`startExperiment`；`createOneFile` 保留内部复用（实验初始化用），但不再由双击触发；`fetchAttachmentText` 接入 |
| `D:\cline\src\hosts\vscode\VscodeWebviewProvider.ts` | 面板接线 | `assignmentManager.attachDetailPanelOpener(payload => panel.reveal(payload, handlers))` |

**测试**

```powershell
cd D:\cline
$env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "assignmentDetail"
cd webview-ui; npx tsc --noEmit; npm run build
```

断言（新单测 `__tests__/assignmentDetailPayload.test.ts`，≥10 条）：
1. payload 含 `id/title/week/description/templateCode/attachments[]`；
2. 附件项含 `id/name/size/downloadUrl`；
3. 缓存命中不发网络请求；缓存 miss → `GET /api/v1/assignments` 后组装；
4. 任务不存在 → `{error:"未找到实验任务"}`；
5. 指导书正文 >200k → payload 标 `guideTruncated=true`；
6. 无附件 → `attachments=[]` 且面板显示「无附件」；
7. 无模板 → `templateCode=""` 且按钮仍可开始实验（生成空模板 + TODO 注释）；
8. `startExperiment` 在已开始时返回 `alreadyStarted=true` 并复用目录；
9. 未知命令 → `未知命令`（保持既有兜底）；
10. 消息往返 `postMessage` 结构符合 `AssignmentResponse{command,success,data?,error?}`。

**边界**：BN-17（任务被教师删除但缓存仍在）、BN-18（附件下载 404）、BN-19（描述含 Markdown 表格 → 面板按纯文本安全渲染，不注入 HTML）。

**完成标准**：单测 + webview tsc/build 全绿；手工点一次面板能打开（记入 M-71）。

---

### P1-3 实验子工作区（1.0）

**目标**：`开始实验` 在工作区建 `experiments/<assignmentId>/`（模板、`GUIDE.md`、`attachments/`、`.cline-logs/`、`.teaching/task.json`），并把日志根切到该目录。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| 新增 `D:\cline\src\core\teaching\ExperimentWorkspace.ts` | — | `ensureExperimentWorkspace({workspaceRoot, assignment, templateCode, guideText})` → `{dir, created, files}`；常量 `EXPERIMENT_ROOT = "experiments"`；幂等（已存在不覆盖学生改动，只补缺失文件）；模板扩展名按 `assignment.language`（默认 `.py`）；写 `.teaching/task.json{assignmentId,mode:"experiment",startedAt}`；写 `.cline-logs/student_interactions.log`（空文件） |
| `D:\cline\src\core\teaching\logPathResolver.ts` | 解析链 | 新增最高优先级 `experimentRoot`（显式传入时**只认该目录**，与 workspaceRoot 同为权威信号） |
| `D:\cline\src\core\teaching\workspaceLogPath.ts` | `resolveStudentLogFile` | 支持 `experimentRoot` 参数 |
| `D:\cline\src\core\teaching\AssignmentManager.ts` | `startExperiment` | 调 `ensureExperimentWorkspace` → 打开模板文件 → 返回 `{dir, files}` |
| `D:\cline\src\core\teaching\submission\SubmissionPackager.ts` | `collectCodeFiles` | 实验模式只收 `experiments/<id>/**` 下的文件（避免把无关作业上传） |

**测试**

```powershell
cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "experimentWorkspace|logPathResolver|submissionPackager"
```

断言（新单测 ≥16 条）：
1. 首次创建 → 目录含 `模板/GUIDE.md/attachments/.cline-logs/student_interactions.log/.teaching/task.json`；
2. 二次调用 → `created=false`，学生已改的模板**不被覆盖**；
3. 只缺 `GUIDE.md` → 只补该文件；
4. `assignmentId` 含 `/`、`..`、空格 → 目录名被 `sanitizeSegment` 清洗，且不越界（`path.relative` 校验）；
5. `language=java` → 模板 `Main.java`；未知语言 → `.py`；
6. `logPathResolver` 传 `experimentRoot` → 命中该目录的 `.cline-logs`；该目录无日志 → `exists=false` **且不回退**工作区根；
7. 传 `experimentRoot` 且 `workspaceRoot` 同时存在 → 仍然只用 experimentRoot；
8. 打包器在实验模式 → 只含 `experiments/<id>/` 下文件，不含 `D:\...\other.py`；
9. 自由模式打包 → 全工作区扫描（现有行为不变）；
10. 目录只读（模拟 `chmod`/ACL 失败）→ 返回 `{error}`，面板提示，不抛异常。

**边界**：BN-20（目录被删后恢复）、BN-21（同名文件已存在但为空）、BN-22（`experiments` 已存在且是文件不是目录）、BN-23（超长任务 id）。

**完成标准**：单测全绿；既有 `logPathResolver` 15 例不回归。

---

### P1-4 实验指导生成与校验（1.0）

**目标**：按「附件正文 + 任务描述 + 模板 + 相关教材片段」生成 `GUIDE.md`（**只给方向**），带硬校验与缓存。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| 新增 `D:\cline\src\core\teaching\ExperimentGuide.ts` | — | `generateExperimentGuide(input, deps)` → `{markdown, source:"llm"\|"template", warning?}`；`validateGuide(markdown)` → `{ok, violations[]}`；预算 6000 字符；模板兜底（无 LLM 时按任务描述生成 4 段固定结构） |
| 同上 | 校验规则 | 禁止：完整函数体（`def main(` / `function main(` + ≥3 行体）、`for/while` 带 ≥3 行实现、`print(` 具体调用超过 2 处、含「完整代码」「直接复制」字样；允许：伪代码式步骤、变量名、思路提示 |
| `D:\cline\src\core\teaching\AssignmentManager.ts` | `createQuestionLLMCaller` | 抽公用 `createTeachingLLMCaller()`（同一 act→plan 回退机制），出题与指导共用 |
| 同上 | `startExperiment` | 生成或复用 `GUIDE.md`（`.teaching/guide.json` 记 `{hash, generatedAt, source}`，hash 变才重生成） |

**测试**

```powershell
cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "experimentGuide"
```

断言（≥14 条）：
1. LLM 返回合规文本 → `source="llm"`；
2. LLM 返回含完整函数体 → `violations` 非空 → 降级为模板文本（`source="template"` + warning）；
3. 含「完整代码」字样 → 违规；
4. 伪代码步骤（无实现）→ 通过；
5. 无模型配置 → 模板 + warning；
6. 模型 401 → act→plan 回退后仍失败 → 模板（复用 `describeLLMFailure`）；
7. 输入超 6000 字符 → 按「指导书 > 描述 > 模板 > wiki」顺序截断；
8. 缓存 hash 不变 → 不重复调用 LLM（计数断言）；
9. 任务描述变更 → hash 变 → 重生成；
10. 生成文本非中文？不强制（跟随任务语言）；
11. `GUIDE.md` 写入后二次 `startExperiment` 不再覆盖（学生可能改过）；
12. 违规清单为空时 `warning` 也为空；
13. 模型返回 JSON 包裹/围栏 → 正常剥离；
14. 超时（`deps.callLLM` 抛 timeout）→ 模板 + warning。

**边界**：BN-24（LLM 返回空串）、BN-25（返回 50KB 超长）、BN-26（markdown 注入 `<script>` → 输出时转义）。

**完成标准**：单测全绿 + `tsc` 0 新增。

---

### P1-5 实验模式上下文装配（0.8）

**目标**：实验模式答疑时把「GUIDE + 附件正文摘要 + 模板 + 教材片段」按预算装配进 system prompt；自由模式只装「教材片段 + 索引」。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| 新增 `D:\cline\src\core\teaching\TeachingContext.ts` | — | `assembleTeachingContext({mode, guide, attachments, template, recall, budget=6000})` → `{sections[], totalChars, dropped[]}`；固定顺序与配额：guide 3000 / attachments 1500 / template 800 / recall 700；超配额按优先级丢尾部 |
| `D:\cline\src\core\task\index.ts` | `:2581-2603` | 用 `assembleTeachingContext` 替换现有拼接 |
| 同上 | 实验模式 | 额外注入「本任务处于实验模式：只给方向，不给可运行完整实现；第 4 次索要才可给伪代码」硬约束段 |

**测试**

```powershell
cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "teachingContext"
```

断言（≥10 条）：
1. 全量输入 → 4 段按序、总 ≤6000；
2. guide 4000 字 → 截到 3000 + `dropped` 记 `guide`；
3. 附件缺失 → 跳过该段不报错；
4. free 模式 → 只有 recall + 索引段，无 guide/模板段；
5. experiment 模式 prompt 含「只给方向」「第 4 次」；
6. 模板为空 → 段省略；
7. recall 为空 → 段省略并记 `dropped`；
8. 总字符数计算与实际字符串长度一致（含标点）；
9. 中文按字符计不按字节；
10. 两模式并发生成互不串上下文。

**边界**：BN-27（全部输入为空 → 只留硬约束段）、BN-28（emoji/中文混排截断不破字）。

**完成标准**：单测全绿。

---

### P1-6 自由模式行为（0.5）

**目标**：自由模式：不写日志、不干预、仍用 wiki、阶梯 3 次放行完整代码（逐段中文注释）。会话内计数，切模式/新建任务清零。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| `D:\cline\src\core\teaching\TeachingSessionMode.ts` | — | 新增 `bumpDemandCounter(ctx, message)`、`shouldReleaseFullCode(ctx)`（free: `count>=3`；experiment: `false`）、`shouldOfferPseudo(ctx)`（experiment: `count>=4`） |
| `D:\cline\src\core\task\index.ts` | 提问入口 | 调用计数器；`shouldReleaseFullCode` 为真时在 system prompt 追加「本次可以给完整实现，但必须逐段中文注释 + 末尾列出学生需自己改的地方」 |
| 同上 | 实验模式 | `shouldOfferPseudo` 为真 → 追加「可以给伪代码（逻辑完整则可运行），仍不得给可运行完整实现」 |

**测试**

```powershell
cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "demandLadder"
```

断言（≥10 条）：
1. free：第 1/2 次 → 不放行；第 3 次 → 放行；
2. experiment：第 1–3 次不放行、第 4 次给伪代码许可、第 5 次仍只伪代码（**永不放行完整实现**）；
3. 非索要消息（概念提问）不增计数；
4. 学生自己写代码（`self_code`）→ 计数清零；
5. 切模式 → 清零；
6. 新任务（新 `taskId`）→ 清零；
7. 计数持久化到任务 `initialState`（恢复会话后不重置）；
8. free 模式命中第 3 次 → prompt 含「逐段中文注释」；
9. experiment 第 4 次 → prompt 含「伪代码」且不含「完整实现」许可；
10. 计数器上限（第 10 次）不溢出。

**边界**：BN-29（索要与概念混在同一条消息）、BN-30（一次消息里两次索要只计 1）。

**完成标准**：单测全绿。

---

### P1-7 P1 汇总闸门（0.2）

同 §4 P0-5 的全套命令 + `cd webview-ui; npm run build` + `node esbuild.mjs` + 手工 M-71/M-72（面板打开、开始实验建目录）。

---

## 6. P2：行为分类与指标统一（6.0 人日）

### P2-1 六类行为分类器（1.2）

**目标**：每条学生消息与每个助手产出都被归到六类之一，并写日志字段。

**改动**

| 文件 | 位置 | 改法 |
|---|---|---|
| 新增 `D:\cline\src\core\teaching\behavior\behaviorClassify.ts` | — | `classifyStudentMessage({text, hasCode, mode, demandCount})` → `{type, weight, signals}`；`classifyAssistantTurn({text, hasFullImpl, toolsUsed, codeKind})` → 同上；`detectCodeKind(text)` → `full` / `pseudo_complete` / `pseudo_partial` / `snippet`（**R1 核心**） |
| 新增 `D:\cline\src\core\teaching\behavior\metricsSpec.ts` | — | 权重常量 + `computeDependenceMetrics(events)`（§3 公式）；导出 `METRICS_SCHEMA = "behavior-weighted/v1"` |
| `D:\cline\src\core\task\student-analytics\types.ts` | `:77-148` | 事件类型加 `behaviorType/behaviorWeight/behaviorSource/behaviorSignals/mode/experimentId/codeKind` |
| `D:\cline\src\core\task\index.ts` | `:1297-1570` | 学生消息事件写分类结果；助手回合结束写 `ai_code`/`design` |
| `D:\cline\src\core\task\student-analytics\StudentLogPersister.ts` | — | 透传新字段 |

**`pseudo_complete` 判定规则（必须可测）**

| 信号 | 权重 |
|---|---|
| 含 `TODO` / `省略` / `自行补充` / `…` 占位 → `pseudo_partial` | 否决 |
| 行数 <5 且无函数签名/无控制流 → `snippet` | 否决 |
| 含函数签名（`def x(` / `function x(` / `public static`）**或**「步骤 1..n」且 n≥3 | +1 |
| 含控制流（`for`/`while`/`if`/`遍历`/`循环`/`判断`）≥2 处 | +1 |
| 含输入/输出（`返回`/`return`/`print`/`输出`）≥1 处 | +1 |
| 与任务要点匹配的词命中 ≥3 | +1 |
| 得分 ≥3 → `pseudo_complete`（`ai_code`）；否则 `pseudo_partial`（`design`） | — |

**测试**

```powershell
cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "behaviorClassify|metricsSpec"
```

断言（≥40 条），必含：
1. 「什么是列表」→ `concept` 0.25；
2. 「这个功能该怎么设计」→ `design` 0.75；
3. 「报错 KeyError 怎么解决」+ 最近 `run_trace exit_code!=0` → `error_help` 1.0；
4. 学生自己 `code_edit editor=student` → `self_code` 0；
5. 助手 `write_to_file` 整文件 → `ai_code` 1.2（`codeKind=full`）；
6. **助手给完整伪代码（函数签名+控制流+返回，无占位符）→ `ai_code` 1.2（`pseudo_complete`）**；
7. 助手给方向性伪代码（含「这里自己补」）→ `design` 0.75；
8. 助手给 3 行片段 → `design`；
9. 「你好」「谢谢」→ `other`（不入分子分母）；
10. 同一条消息既报错又索要实现 → `error_help`（优先级 §5.1 细则 1）；
11. `depIndex` 单测：全 `self_code` → 0；全 `ai_code` → 1.0；概念+自主各半 → 0.125；
12. `other` 混入不改变 `depIndex`（同分母断言）；
13. `selfCodingRatio` 分母 0 → `null`；
14. 空事件数组 → `{depIndex:null, ...}` 全 null 不抛错；
15. 旧事件无 `behaviorType` → 回退 `queryType` 映射（concept→concept、coding→design、other→other）。

**边界**：BN-31（文本 10 万字符）、BN-32（中英混排）、BN-33（代码块里含「TODO」但正文完整 → 判 partial，需记录理由）、BN-34（`queryType` 缺失且无 behaviorType 的历史事件）。

**完成标准**：单测全绿（≥40 条），`tsc` 0 新增。

---

### P2-2 删除阻断式干预（0.8）

**目标**：不存在任何「阻断 / 60 秒 / 结束回合」的干预路径。

**改动（删除清单）**

| 文件 | 位置 |
|---|---|
| `D:\cline\src\core\teaching\TeachingInterventionManager.ts` | `:43-44`（`60_000`）、`:82-98`、`:148-166`、`:290-326`、`:382-387` |
| `D:\cline\src\core\teaching\InterventionMessageGenerator.ts` | `:347-430` |
| `D:\cline\src\core\teaching\rulePolicy.ts` | `:38` 阻断白名单 |
| `D:\cline\src\core\teaching\BehaviorMonitor.ts` | `:147,772,798,834` 的 `blockingTriggered`；`:38-73` 阈值表去掉阻断项 |
| `D:\cline\src\core\task\index.ts` | `:3393-3452`（阻断回合、`ask("followup")`、`return true`） |
| `D:\cline\webview-ui\src\components\chat\TeachingBlockingBanner.tsx` | 整个文件 |
| `D:\cline\webview-ui\src\components\chat\ChatView.tsx` | `:348` |
| `D:\cline\src\core\controller\index.ts` | `:901` 横幅状态 |
| 测试 | `interventionParams.test.ts:9`、`interventionRegression.test.ts:90`、`blockingIdempotence.test.ts` 等断言 `60_000` 的用例 → 改为「不存在 blocking」 |

**测试**

```powershell
cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha --grep "intervention|blocking"
```

断言（≥12 条）：
1. `TeachingInterventionManager` 不再导出任何 `*blocking*` 成员（源码扫描断言）；
2. `src/**` 无 `60_000`（白名单：无关超时除外，需逐条登记）；
3. `task/index.ts` 不存在「干预后 `return true`」的路径（扫描 `intervention` 附近的 `return true`）；
4. 触发 `ai_coding_rounds` 达 3 → 只产出一条 `severity:"hint"`，任务**继续执行**；
5. 干预不影响 `attempt_completion`；
6. `webview-ui` 无 `TeachingBlockingBanner` 引用；
7. 阈值仍 3 的规则保留计数（可审计）；
8. 删除后 `rulePolicy` 白名单为空且不再升级；
9. 旧日志含 `interventionType:"blocking"` → 解析不报错（向后兼容读）；
10. 前端无「⛔」banner 渲染路径；
11. 干预冷却仍生效（120s 内同类只 1 条）；
12. 单条规则每学生请求最多 1 次。

**边界**：BN-35（旧版本会话恢复时状态字段缺失）、BN-36（前端持久化状态里残留 `blocking`）。

**完成标准**：单测全绿；`tsc` 0 新增；`webview-ui build` 通过。

---

### P2-3 六条软提示（0.8）

**目标**：`design_stall` / `same_error_twice` / `full_impl_demand` / `ai_code_streak` / `concept_streak` / `error_no_progress` 六条，全部 `hint|question`，**永不阻断**。

**改动**：`BehaviorMonitor.ts` 规则实现 + `rulePolicy`（改软名单）+ `InterventionMessageGenerator` 文案（保留 `<teaching_intervention_copy>` 契约与模板兜底）。

**测试**：`__tests__/softInterventions.test.ts`（≥24 条，6 规则 × 4 断言：触发 / 不触发 / 冷却 / 不影响流程）。

**边界**：BN-37（同一条消息同时命中 3 条规则 → 只出一条，优先级 `full_impl_demand` > `same_error_twice` > 其它）、BN-38（规则命中但模型文案校验不过 → 模板兜底仍展示）。

---

### P2-4 三端指标统一（1.2）

**目标**：看板、报告、教学端入库用**同一份公式**；同一批事件三处 `depIndex` 完全一致（±0）。

**改动**

| 仓库 | 文件 | 改法 |
|---|---|---|
| cline | `src/core/teaching/behavior/metricsSpec.ts` | 权威常量 + 公式（`behavior-weighted/v1`） |
| teaching-server | 新增 `src/submission/metricsSpec.ts` | 镜像常量（同一数值，加注释指向 cline 文件） |
| teaching-server | `src/submission/metrics.ts` | `computeMetrics` 改为调用 spec：`ai_dependency` 保留旧字段（兼容），新增 `dep_index` 等 |
| backend | `src/analytics.js` | `computeSummary`/`computeProfile`/`computeInterventionInsights` 全部走同一公式；`codeEditRate` 改为 `selfCodingRatio`（旧字段保留别名）；`totalTasks`/`totalSessions` 保持 P0 语义 |
| backend | 新增 `src/metricsSpec.js` | 镜像常量 |
| teaching-server | `db/migrations.ts` | schema **v3**：`mode`、`experiment_id`、`dep_index`、`self_coding_ratio`、`adoption_deepening`、`guidance_effect`、`error_resolution_rate`、`behavior_mix`、`metrics_schema`（默认 `'v1'`，新行写 `'behavior-weighted/v1'`） |
| teaching-server | `bundleContract.ts`/`bundleService.ts` | meta 读 `mode/experiment_id/metrics_schema`；入库写新列 |
| teaching-server | `reportService.ts` | `metrics` 返回新字段 + `metricsSchema` |
| frontend | `StudentReport.tsx` | 展示 `depIndex/selfCodingRatio/adoptionDeepening/guidanceEffect/errorResolutionRate` + 「旧口径」徽标（`metricsSchema==='v1'`） |

**测试**

```powershell
cd D:\web-dashboard\teaching-server
npx tsx scripts/check-metrics-spec.ts        # 新建：同一 fixture 喂三处实现
node scripts/contract-check.mjs               # 第 13 组「指标 spec」断言
cd ..\backend; node scripts/check-dashboard-source.mjs
cd ..\frontend; npm run build
```

断言（`check-metrics-spec.ts`，≥20 条）：
1. fixture 20 条事件（6 类各若干）→ cline `metricsSpec`、teaching-server `metricsSpec`、backend `analytics.js` 三者 `depIndex` **完全相等**（浮点 `toString()` 相等）；
2. `adoptionDeepening` 三者一致；
3. `guidanceEffect` 分母 0 → 三者都 `null`；
4. `other` 全占 → `depIndex=null`；
5. 权重常量三处字面量一致（断言对象 deepEqual）；
6. 旧事件（无 behaviorType、有 queryType）→ 三者都按映射回退且结果一致；
7. `metrics_schema` 新行 = `behavior-weighted/v1`；
8. 报告接口字段齐全；
9. 看板 `/summary` 返回 `depIndex` 与报告一致（用同一 DB + API 交叉断言）；
10. 契约闸门 13 组断言全过（三文件常量、字段名、`METRICS_SCHEMA` 字符串一致）。

**边界**：BN-39（事件缺 `ts`）、BN-40（`behaviorWeight` 越界 0..1.2 之外 → 夹取并 warn）、BN-41（同一 `submission_id` 混入旧/新字段）。

**完成标准**：三处实现一致 + 契约闸门全绿 + frontend build 通过。

---

### P2-5 迁移 v3 与历史兼容（0.6）

**改动**：`db/migrations.ts` v2→v3（幂等，`PRAGMA user_version`）；`scripts/check-submission-migration.ts` 扩展；历史行 `metrics_schema='legacy'`、新列为 NULL，报告页显示「旧口径」徽标。

**测试**

```powershell
cd D:\web-dashboard\teaching-server
npx tsx scripts/check-submission-migration.ts     # 原 36 条 + 新增 ≥10 条
```

断言（新增）：
1. 合成 v0 库 → v3，`user_version=3`；
2. 二次迁移幂等（`applied=[]`）；
3. 历史行 `metrics_schema='legacy'`、`dep_index IS NULL`；
4. 新行 `metrics_schema='behavior-weighted/v1'`；
5. 真实库副本迁移后行数不变、无重复 current；
6. `mode/experiment_id` 默认 NULL 且不破坏旧查询；
7. 迁移失败（模拟锁）→ 抛错且 `user_version` 不回退。

**边界**：BN-42（WAL 下有并发读）、BN-43（列已存在时重复迁移）。

---

### P2-6 全流程与边界闸门（0.8）

**目标**：一条脚本跑完 §2 全流程 + 边界矩阵中全部「可自动验证」项。

**新增** `D:\web-dashboard\teaching-server\scripts\check-teaching-flow.mjs`（真 HTTP + 真 SQLite，临时 DATA_DIR，端口 4130+）：

| 步骤 | 断言 |
|---|---|
| E2E-01 建任务（含 md 附件 + 模板） | 201 + 附件 id |
| E2E-02 拉列表/附件列表/正文端点 | 200 + 正文一致 |
| E2E-03 模拟「开始实验」产物（脚本直接建同构目录，因插件侧无法在 Node 里跑） | 目录结构齐 |
| E2E-04 构造 free 模式事件（无 student 日志）→ 提交 | 提交包无日志也 201，warning 明示 |
| E2E-05 构造 experiment 事件（含 behaviorType 六类 + run_traces）→ 提交 | 201；`dep_index` 与脚本手算一致 |
| E2E-06 报告 `/reports/current` | `metrics.depIndex` 与 E2E-05 一致；`questions` 含答案 |
| E2E-07 看板 `/api/dashboard/events` | 事件数一致、`behaviorType` 透传 |
| E2E-08 看板 `/summary` | `depIndex` 与报告一致；`behaviorMix` 一致 |
| E2E-09 过滤三态 | 任务/学生/时间 + `emptyReason` 四态 |
| E2E-10 边界集 | BN-01/05/09/14/20/24/31/40 等自动项逐条 |

**判定**：脚本末行 `总计 N 项断言：通过 X，失败 Y`，`Y>0` → 退出码 1。

**边界**（脚本内覆盖，非全部矩阵）：BN-01、BN-05、BN-09、BN-11、BN-14、BN-17、BN-20、BN-24、BN-29、BN-31、BN-34、BN-40、BN-44、BN-45、BN-46。

---

### P2-7 文档与 CHANGELOG（0.6）

- `D:\cline\docs\manual-test-plan.md` 新增 §8「会话模式与指标」M-70~M-79。
- 设计文档 `teaching-modes-and-behavior-metrics-design.md` 加 §12「实施记录」（落点表 + 偏差 + 闸门结果）。
- 本计划文档加 §13「实施记录」。
- 两个 `CHANGELOG.md` 各自新增 `## [Unreleased] — 2026-10-2x` 段（内容见 §10.3）。

---

## 7. 边界条件矩阵（BN-01 ~ BN-46）

> 「自动」= 由 §8 脚本覆盖；「手工」= 记入 `manual-test-plan.md`。

| # | 场景 | 期望 | 覆盖 |
|---|---|---|---|
| BN-01 | wiki 库 0 条资料 | search 200 + 空数组 + `total=0` | 自动 P0-1 |
| BN-02 | `q` 只有空格 | 走浏览模式 | 自动 P0-1 |
| BN-03 | `q` 含 `%`/`_` | 转义，不返回全表 | 自动 P0-1 |
| BN-04 | `max_week=0/19/abc` | 夹取或忽略，200 | 自动 P0-1 |
| BN-05 | 旧工作区残留 `teaching-week.json` | 不读、不报错 | 自动 P0-2 |
| BN-06 | `cline_mcp_settings.json` 残留 `--week` | 注册器重写时清除 | 自动 P0-2 |
| BN-07 | 教学端不可达 | 召回降级，prompt 仍生成 | 自动 P0-3 |
| BN-08 | 召回正文超大 | 截断到预算 | 自动 P0-3 |
| BN-09 | `q` 含换行/emoji | 正常检索 | 自动 P0-3 |
| BN-10 | 同义 query 缓存 | 不串味（key 精确） | 自动 P0-3 |
| BN-11 | 零字节附件 | `text=""`，`truncated=false` | 自动 P0-4 |
| BN-12 | 中文/空格文件名 | 下载与正文都正常 | 手工 M-71 |
| BN-13 | 单任务 10 个附件 | 列表与正文均可用 | 自动 P0-4 |
| BN-14 | `.teaching/task.json` JSON 损坏 | 判定 free + warn | 自动 P1-1 |
| BN-15 | `experimentId` 含中文 | 目录正常 | 自动 P1-3 |
| BN-16 | free 模式高频提问 | 日志零增长 | 自动 P1-1 |
| BN-17 | 任务被删但缓存仍在 | 面板提示「任务不存在」 | 自动 P1-2 |
| BN-18 | 附件 404 | 面板显示「下载失败」 | 自动 P1-2 |
| BN-19 | 描述含 HTML/Markdown 表格 | 纯文本安全渲染 | 手工 M-71 |
| BN-20 | 实验目录被手工删除后恢复 | 重建 + `logRoot` 回退 warn | 自动 P1-3 |
| BN-21 | 模板文件已存在但为空 | 不覆盖 + 提示 | 自动 P1-3 |
| BN-22 | `experiments` 是文件不是目录 | 报错提示，不崩溃 | 自动 P1-3 |
| BN-23 | 超长任务 id | 目录名截断到 60 字符 + hash 后缀 | 自动 P1-3 |
| BN-24 | LLM 返回空串 | 模板兜底 | 自动 P1-4 |
| BN-25 | LLM 返回 50KB | 截断 + warn | 自动 P1-4 |
| BN-26 | 指导书含 `<script>` | 逃逸后写入 | 自动 P1-4 |
| BN-27 | 上下文全空 | 只留硬约束段 | 自动 P1-5 |
| BN-28 | 截断处是 emoji | 不破字符 | 自动 P1-5 |
| BN-29 | 一条消息既报错又索要 | 归 `error_help` | 自动 P2-1 |
| BN-30 | 一条消息两次索要 | 只计 1 | 自动 P1-6 |
| BN-31 | 文本 10 万字符 | 分类不超时（<50ms） | 自动 P2-1 |
| BN-32 | 中英混排 | 分类正确 | 自动 P2-1 |
| BN-33 | 代码块含 `TODO` 但正文完整 | `pseudo_partial` + 记录理由 | 自动 P2-1 |
| BN-34 | 历史事件无任何类型字段 | 回退 `other` 且不入分母 | 自动 P2-1 |
| BN-35 | 旧会话恢复缺状态字段 | 默认值兜底 | 自动 P2-2 |
| BN-36 | 前端残留 blocking 状态 | 忽略 | 手工 M-72 |
| BN-37 | 一条消息命中 3 条软规则 | 只出 1 条（优先级） | 自动 P2-3 |
| BN-38 | 干预文案校验不过 | 模板兜底 | 自动 P2-3 |
| BN-39 | 事件缺 `ts` | 用 `submitted_at` 兜底 | 自动 P2-4 |
| BN-40 | `behaviorWeight` 越界 | 夹取 0..1.2 + warn | 自动 P2-4 |
| BN-41 | 同一提交混入新旧字段 | 以新字段为准 | 自动 P2-4 |
| BN-42 | WAL 并发读时迁移 | 不锁死（busy_timeout 5s） | 自动 P2-5 |
| BN-43 | 列已存在重复迁移 | 幂等跳过 | 自动 P2-5 |
| BN-44 | 提交包无日志（free 模式） | 201 + warning | 自动 P2-6 |
| BN-45 | 提交包无代码文件 | 201 + `code_count=0` | 自动 P2-6 |
| BN-46 | 同一学生同任务并发提交 | revision 1/2，只有一条 current | 自动 P2-6 |

---

## 8. 全流程联调（L4）

```powershell
# 1) 起教学端（临时数据卷，避免污染真库）
cd D:\web-dashboard\teaching-server
$env:DATA_DIR='D:\web-dashboard\teaching-server\.tmp-flow'; $env:PORT='4130'; npx tsx src/server.ts   # 后台
# 2) 跑全流程
node scripts/check-teaching-flow.mjs      # 内部起 backend 实例（4131）做看板交叉断言
# 3) 收尾
# 杀掉后台进程、删 .tmp-flow
```

失败自查表：

| 症状 | 先查 |
|---|---|
| 报告 `depIndex` 与看板差 >0 | 三处 spec 常量是否同值（`contract-check` 第 13 组） |
| 提交 400 `META_INVALID` | `mode/metrics_schema` 是否在 `BUNDLE_META` 白名单 |
| 看板空 | `/api/dashboard/sources` + `meta.emptyReason` |
| 实验目录没生成 | `startExperiment` 返回的 `{error}`（面板会显示） |
| 日志没写 | 会话 `mode` 是否误判为 free（`task.json` 是否存在） |

---

## 9. 回归闸门清单（每次任务收尾都要跑）

| # | 命令 | 期望 |
|---|---|---|
| 1 | `cd D:\cline; npx tsc --noEmit` | 0 错误 |
| 2 | `cd D:\cline\webview-ui; npx tsc --noEmit` | 0 错误 |
| 3 | `cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha` | 全绿（基线 1291 + 新增） |
| 4 | `cd D:\cline; node esbuild.mjs` | 产出 `dist/` 与 `dist/mcp-wiki-server.js` |
| 5 | `cd D:\cline\webview-ui; npm run build` | 构建成功 |
| 6 | `cd D:\cline; node scripts/verify/mcp-wiki-server.mjs` | 8+ 断言 |
| 7 | `cd D:\web-dashboard\teaching-server; npx tsc --noEmit` | 仅 11 条基线错误 |
| 8 | `cd D:\web-dashboard\teaching-server; node scripts/contract-check.mjs` | 全绿（57 + 新增） |
| 9 | `cd D:\web-dashboard\teaching-server; npx tsx scripts/check-submission-migration.ts` | 36 + 新增 |
| 10 | `cd D:\web-dashboard\teaching-server; npx tsx scripts/check-dashboard-events.ts` | 30/30 |
| 11 | `cd D:\web-dashboard\teaching-server; npx tsx scripts/check-wiki-search.ts` | 18+ |
| 12 | `cd D:\web-dashboard\teaching-server; node scripts/check-wiki-routes.mjs` | 10+ |
| 13 | `cd D:\web-dashboard\teaching-server; npx tsx scripts/check-attachment-text.ts` | 10+ |
| 14 | `cd D:\web-dashboard\teaching-server; npx tsx scripts/check-metrics-spec.ts` | 20+ |
| 15 | `cd D:\web-dashboard\backend; node scripts/check-dashboard-source.mjs` | 49/49 |
| 16 | `cd D:\web-dashboard\backend; node scripts/check-bundles.mjs` | 37/37 |
| 17 | `cd D:\web-dashboard\frontend; npm run build` | 成功 |
| 18 | `cd D:\web-dashboard\teaching-server; node scripts/check-teaching-flow.mjs` | 全绿（L4） |

> 说明：`npm run lint` / `npm run compile` 不作为闸门 —— 仓库 HEAD 便有 28+ 条既有 biome 违规（`vscode-api.grit`、`console-log.grit`），无法通过；提交时沿用 `--no-verify`（见 §10.4）。

---

## 10. 提交与 CHANGELOG 计划

### 10.1 提交节奏

每完成一个优先级（P0/P1/P2 各自全部任务 + 闸门全绿）提交一次，共 3 次/仓库，最后各补 1 次 CHANGELOG 提交：

| 顺序 | 仓库 | 提交信息 |
|---|---|---|
| 1 | `D:\cline` | `feat(teaching): drop week gating and recall wiki by question` |
| 2 | `D:\web-dashboard` | `feat(wiki): search chunks without a week boundary` |
| 3 | `D:\cline` | `feat(teaching): add free/experiment session modes with guided experiment workspace` |
| 4 | `D:\web-dashboard` | `feat(teaching): serve experiment attachments as text for the detail panel` |
| 5 | `D:\cline` | `feat(teaching): classify student behavior and weight the AI dependence index` |
| 6 | `D:\web-dashboard` | `feat(metrics): share one behavior-weighted spec across dashboard and reports` |
| 7 | `D:\cline` | `docs(changelog): 记录去周数、双模式与加权依赖度` |
| 8 | `D:\web-dashboard` | `docs(changelog): 记录去周数与行为加权指标` |

### 10.2 提交前检查

```powershell
cd D:\cline; git status --short          # 只暂存本次相关文件，排除他人改动（src/core/task/index.ts 若含他人格式改动需先确认）
git diff --cached --stat
cd D:\web-dashboard; git status --short  # 排除 teaching-server/pnpm-workspace.yaml
```

### 10.3 CHANGELOG 段落（两个仓库都要写）

**`D:\cline\CHANGELOG.md`** 新增 `## [Unreleased] — 2026-10-2x`（Added / Changed / Fixed）：

- Added：会话模式（自由/实验）、任务详情面板、实验子工作区（`experiments/<任务id>/`）、实验指导生成与校验、六类行为分类（含 `pseudo_complete` 判据）、`metricsSpec`、问题预召回（top3/1600 字）、附件正文读取、软提示 6 条。
- Changed：删除「当前教学周」全部入口（配置/状态栏/MCP `--week`/共享周文件）；wiki 改为按提问召回；删除 60 秒阻断式干预；「提交」前的出题阶梯改为 3/4 次语义；AI 依赖度改为行为加权公式。
- Fixed：`ai_code` 在实验模式下恒为 0；`wikiPrompt` 周字样误导；`AssignmentManager` 附件下载回执前端无接收。

**`D:\web-dashboard\CHANGELOG.md`** 新增 `## [Unreleased] — 2026-10-2x`：

- Added：`/api/v1/wiki/*` 去 week（`max_week` 可选、`meta.week_ignored`）、`/attachments/:fileId/text`、`metrics_spec` 三端一致闸门、迁移 v3（`dep_index` 等 9 列）、报告页新指标与新口径徽标。
- Changed：wiki 检索排序改相关度、入库指标改行为加权、看板指标改同一 spec、`codeEditRate` → `selfCodingRatio`（旧字段保留别名）。
- Fixed：旧 `week` 参数导致资料被截断；报告与看板 `depIndex` 口径不一致；历史行无 `metrics_schema` 时的前端误读。

### 10.4 钩子说明

`D:\cline` 的 `pre-commit`（`biome check --staged`）在本仓库 HEAD 就必然失败（存量 28+ 违规，见 2026-10-18 记录），提交使用 `git commit --no-verify`，并在提交说明里注明「仅跳过格式化检查，`tsc`/`mocha` 已单独跑过」。

---

## 11. 风险与止损

| 风险 | 触发信号 | 止损 |
|---|---|---|
| 三端 spec 漂移 | 契约闸门第 13 组失败 | 常量只有三份字面量，闸门直接比对；失败阻断提交 |
| 分类误判拉偏指标 | 教师反馈某学生 depIndex 异常 | `behaviorSignals` 可回溯；`teaching.behaviorClassifyLLM` 兜底；阈值可配 |
| 删周数影响旧教师端 | 旧插件请求带 week | 后端「接受并忽略」+ `week_ignored`；灰度一周后清理兼容分支 |
| 实验目录污染学生工作区 | 学生已有 `experiments/` | 目录名固定 + 只补不覆盖 + 首次创建前 `showWarningMessage` 确认 |
| 删阻断后 AI 代写变多 | `ai_code` 占比上升 | 软提示 + `ai_code_streak` + 老师端分档告警（P2 已含） |
| 迁移 v3 失败 | 启动日志 error | 迁移失败不阻断启动（现有约定），但报告/看板读不到新列时降级 `null` |

---

## 12. 完成定义（DoD）

1. 19 项任务的「测试」小节全部通过，且每项都有落盘证据（命令 + 输出摘要记入本文档 §13）。
2. §9 的 18 条闸门在最后一次改动后全绿。
3. `check-teaching-flow.mjs` 全流程通过，且 §7 矩阵中标「自动」的 33 条全部有断言覆盖。
4. 手工验收 M-70~M-79 由人确认（面板、目录、拦截文案、报告页）。
5. 两个仓库各 4 次提交完成，`CHANGELOG.md` 均含 `2026-10-2x` 段。
6. 设计文档、实施计划、`manual-test-plan.md` 三处文档与实际实现一致（含偏差说明）。

---

## 13. 实施记录（执行时填写）

| 任务 | 状态 | 闸门结果 | 偏差 |
|---|---|---|---|
| P0-1 教学端去周数 | ✅ 完成 | `check-wiki-search.ts` 29→**37/37**；`check-wiki-routes.mjs` **26/26**；tsc 仅 11 条基线 | 新增 `extractTerms`（见 P0-3 偏差①） |
| P0-2 扩展删周数 | ✅ 完成 | mocha 全量 **1287 passing / 111 pending**；cline+webview-ui tsc 0；`node scripts/verify/mcp-wiki-server.mjs` **17/17**；webview build ✓ | ①`weekToolDescriptions` 由「只改 SEARCH」扩为三个工具描述全改；②新增 `noWeekConfig.test.ts` 结构守卫（`process.cwd()` 取仓库根，ESM 无 `__dirname`） |
| P0-3 提问预召回 | ✅ 完成 | 单测 **20 passing**（`--grep "预召回"`）；`scripts/verify/wiki-recall.mjs` **14/14**（真服务 + 真 SQLite） | ①**必须新增后端切词**：整句 `LIKE` 在自然语言提问上必然 0 命中 → `wikiSearch.ts` 增 `extractTerms()`（汉字 2-gram，最多 8 词）+ 打分排序（标题 +2 / 正文 +1）；②检索接口回 `snippet` 而非 `content`，扩展侧两者都要认（否则「后端命中 2 条、前端 0 条」） |
| P0-4 附件正文 | ✅ 完成 | `scripts/check-attachment-text.ts` **29/29**；`--grep "附件正文"` **11 passing**；tsc 无新增 | 新增 422 `TEXT_PARSE_FAILED` 分支（解析失败时面板仍可给下载按钮，而不是 500） |
| P0-5 汇总闸门 | ✅ 完成 | contract **57/57**、dashboard-events **30/30**、dashboard-source **49/49**、check-bundles **37/37**、check-wiki-search **37/37**、check-wiki-routes **26/26**、check-attachment-text **29/29**、mcp-wiki-server **17/17**、wiki-recall **14/14**；mocha **1318 passing / 111 pending**；cline+webview-ui tsc 0；teaching-server tsc 仅 11 条基线；webview build ✓ 48.8s；esbuild ✓ | mocha 基线由计划的 1291 升至 1318（P0 新增用例） |

| P1-1 会话模式判定与日志门控 | ✅ 完成 | `sessionMode.test.ts`；P1 阶段 mocha 1379 → P2 收口 **1508/111**；两处 tsc 0 | `.teaching/task.json` 缺失/损坏判 free（BN-14）；free 日志零增长（BN-16） |
| P1-2 实验子工作区 | ✅ 完成 | `experimentWorkspace.test.ts`；E2E-03 + M-73 覆盖目录结构 | 目录名固定 `experiments/<assignmentId>/`，只补不覆盖（BN-20/21/22） |
| P1-3 任务详情面板与附件正文 | ✅ 完成 | `assignmentDetail.test.ts`、`attachmentText.test.ts`；web `check-attachment-text.ts` 29/29 | 附件 50KB 截断（BN-25）、422 `TEXT_PARSE_FAILED` 面板下载兜底（P0-4 偏差） |
| P1-4 GUIDE 生成与校验 | ✅ 完成 | `experimentGuide.test.ts`；prompt 注入 + 校验失败模板兜底 | LLM 空串回退模板（BN-24）；GUIDE 不含可运行完整实现 |
| P1-5 上下文装配 | ✅ 完成 | `teachingContext.test.ts` **13 条**；P1 定向 **35 passing** | 配额 3000/1500/800/700、总预算 6000；Unicode 码点截断不破字（BN-28）；free 只 recall+索引 |
| P1-6 自由模式阶梯 | ✅ 完成 | `demandLadder.test.ts` **14 条**；全量 mocha 1508/0 | 计数落 `<globalStorage>/tasks/<taskId>/teaching-demand.json`（未用 initialState）；free 仍跑被动 BehaviorMonitor；实验模式不注入教材索引 |
| P1-7 汇总闸门 | ✅ 完成 | 两处 tsc 0、全量 mocha **1508/111/0**、`node esbuild.mjs` ✓、webview build ✓、mcp-wiki-server **17/17**、wiki-recall **14/14** | 手工 M-70~M-79 待人工确认（DoD 第 4 条） |
| P2-1 六类行为分类与指标 spec | ✅ 完成 | `metricsSpec.test.ts` 48 + `behaviorClassify.test.ts` 43 = **91 passing**；task/index.ts 三处写入点接入 | `pseudo_complete` 计 ai_code；behaviorSignals 逗号分隔 ≤120 字、空→`no_signal`；guidanceEffect 不含窗口；窗口距离 0 计入 |
| P2-2 删除阻断 | ✅ 完成 | `noBlocking.test.ts` 10 用例/43 expect（运行时≈120 断言）、`aiCodingRounds.test.ts` 15、`blockingIdempotence.test.ts` 5；生产 grep 0 残留 | `severity` 恒 `"gentle"`、hint/question 归 style；`"blocking_template"` 仅历史日志读兼容保留 |
| P2-3 六条软提示 | ✅ 完成 | `softInterventions.test.ts` **31 条**；`--grep "intervention\|blocking"` 41 passing / 2 pending / 0 failing | 优先级 full_impl_demand > same_error_twice > error_no_progress > design_stall > ai_code_streak > concept_streak；文案校验失败模板兜底（BN-38） |
| P2-4 三端统一指标 | ✅ 完成 | metrics-spec **196/0**、contract-check **78/78**（含第 13 组）、dashboard-source **131/0**、check-bundles 37/37、dashboard-events 30/30；frontend build ✓ | `ai_dependency`=depIndex、`codeEditRate`=selfCodingRatio 留别名；前端兼容旧稿 `weighted-v1` |
| P2-5 迁移 v3 | ✅ 完成 | `check-submission-migration.ts` **87/0**（+51）；真实库已备份 `teaching_system.db.pre-v3.bak`（sha256 `7bf86380…`，未手动迁移） | 历史行 `metrics_schema='legacy'`、新行 `behavior-weighted/v1`；列已存在幂等（BN-43）；失败不回退 user_version（BN-42 WAL 覆盖） |
| P2-6 全流程 E2E | ✅ 完成 | `check-teaching-flow.mjs` 1150 行；末行 `总计 299 项断言：通过 299，失败 0`（连续两次一致） | 真 HTTP+真 SQLite、临时 DATA_DIR + 4130 端口、不 mock；BN-14/20/24 插件侧由单测覆盖并在脚本输出「覆盖率说明」 |
| P2-7 文档与 CHANGELOG | ✅ 完成 | manual-test-plan §8（M-70~M-79，120→144 行）、design §12、plan §13、两仓库 CHANGELOG `## [Unreleased] — 2026-10-24` | 偏差与已知限制见 design §12.4；手工项待人工确认 |
