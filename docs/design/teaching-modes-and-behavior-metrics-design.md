# 教学辅助系统改造设计 · 去周数 / 双模式 / 六类行为与指标统一

> 版本 v1.0（2026-10-23）｜范围：`D:\cline`（VS Code 扩展 + webview）+ `D:\web-dashboard`（teacher-server / backend 看板 / frontend）
> 本文是**分析与设计方案**，不含实现代码。实施计划见 §8，待你确认的取舍见 §11。

---

## 0. 摘要

三条需求，本质是**把「周数驱动」改成「内容驱动」**、**把「一种对话」拆成「两种模式」**、**把「隐式启发式」换成「显式行为分类 + 统一口径」**。

| 需求 | 核心改动 | 主要落点 |
|---|---|---|
| 1 去周数 | 删除 `clineTeaching.currentWeek` 与「第 x 周」UI；wiki 检索去掉 `applicable_week <= week`，改为按提问内容召回 | `webview-ui`（删）、`WikiMcpRegistrar`/`mcp-wiki-server`/`wikiPrompt`/`task/index.ts`（改）、**`web-dashboard/teaching-server`** 三个 wiki 端点（改） |
| 2 双模式 | 新增 `sessionMode = free \| experiment`；自由模式**不记行为日志、不干预**、仍用 wiki、引导阶梯；实验模式新增任务详情面板 + 「开始实验」建子工作区 + LLM 生成实验指导 + 日志落子目录 | `AssignmentManager`、新 `AssignmentDetailPanelProvider`、新 `ExperimentWorkspace`、`StudentLogPersister`/`logPathResolver` |
| 3 六类行为 | 新增 `behaviorType`（concept / design / error_help / self_code / ai_code / other）与权重；**删除阻断式干预**；AI 依赖度改加权公式；四套指标口径统一到一份 spec | `student-analytics/**`、`task/index.ts`、`backend/src/analytics.js`、`teaching-server/src/submission/metrics.ts`、`frontend/src/App.jsx` |

**建议总工作量：约 15 人日**（P0 3.5 / P1 5.5 / P2 6.0，见 §8）。三个需求**建议按 P0→P1→P2 串行**，因为 P2 的指标依赖 P1 的模式与 P0 的检索上下文。

---

## 1. 现状证据（本次勘察结论，含行号）

### 1.1 周数：配置 + 共享文件 + MCP 三通道

- 权威值：`clineTeaching.currentWeek`（number，默认 1，1–18），`package.json:445-451`；读写集中在 `src/core/teaching/LLMWikiService.ts:188`（`getCurrentWeek`）、`:193`（`setCurrentWeek`）、`:145-153`（`_refreshConfig`）、`:416-420`（`clampWeek`）、`:127-136`（`listenConfigChanges`）。
- MCP server 是独立进程读不到 VS Code 配置，因此**三通道同步**：`--week` 参数（`WikiMcpRegistrar.ts:65` → `args.ts:11`）、共享文件 `teaching-week.json`（`weekStatePath.ts:13`、`weekStateFile.ts:22/36`）、MCP 每次调用热读文件且优先于参数（`mcp-wiki-server.ts:31-37` `effectiveWeek`）。
- UI：`webview-ui/src/components/menu/WikiWeekSelector.tsx`（挂载 `Navbar.tsx:103`），显示「第 x 周」`:243`，交互 `:122-173`，防抖后发 `{command:"switchWeek",week}` `:104-119` → `VscodeWebviewProvider.ts:320-327`。另有两处残留：`AssignmentHeader.tsx:171-177`（已不被引用，`AssignmentTab.tsx:43-44,721-722`）、`AssignmentTab.tsx:923-956` 底部「📅 学习进度」**只改本地状态、不发命令**（死控件）。
- 真正的周边界在**后端 SQL**：`D:\web-dashboard\teaching-server\src\server.ts` 的 `applicable_week <= ?`（`wikiSearch.ts` 三函数：`searchWiki`/`listWeeks`/`getChunk`，调用点 `server.ts:56`）。扩展侧 `buildIndexGroups`（`LLMWikiService.ts:224-260`）**已无周过滤**，只注入索引标题。

### 1.2 检索链路：索引注入 + 模型自主调工具

- 注入发生在每次请求：`src/core/task/index.ts:2427` `attemptApiRequest` → `:2581-2589` `fetchWikiForWeek(getCurrentWeek())`（3s 超时）→ `:2595-2602` `buildWikiSystemPrompt({week,index,mcpAvailable})` → `:2603` 拼入 system prompt。**不限实验任务**，所有对话都会注入。
- 正文不注入，由 MCP 工具现取：`search_wiki(query,limit)` / `read_wiki_chunk(chunk_id)` / `list_wiki_weeks()`（`mcp-wiki-server.ts:40-69`），schema **没有 week**，服务端 `:80-88` 用 `effectiveWeek()` 补到 REST 请求（`wikiBackend.ts:45-56`）。
- 预算：`wikiPrompt.ts:26` 2400 字符；分级截断 `:74-81`；认知边界 A/B/C `:38-50`（含「第 N 周」文案）。

### 1.3 双模式缺失：任务只有「双击建文件」

- 列表卡片 `AssignmentTab.tsx:819-838`；`onClick` → `handleSelectTask` `:823`（`:561-563` 仅 `setSelectedTask`）；`onDoubleClick` → `handleCreateOne` `:825`（`:583-597`，发 `createOneFile`）。
- 详情区：标题+周徽章 `:851-854`、指导书 `:857-864`（`pre-wrap` 纯文本）、附件 `:867-893`（点即下载）、提交按钮 `:896-913`。`template_code` 前端声明了（`:56`）但**从不渲染**。
- `AssignmentManager.createExperimentFile`（`src/core/teaching/AssignmentManager.ts:1231-1264`）：写**工作区根** `${safeId}_experiment.py`（`:1237-1238`），已存在就静默返回（`:1241-1243`，但 `:1187-1192` 仍回 success:true）；模板取 `template_code`（`:1246-1247`），否则注释占位。
- 附件下载 `handleDownloadAttachment`（`:1307-1386`）：URL `${apiBase}/api/v1/assignments/{id}/attachments/{fileId}/download`（`:1325-1327`），落**工作区根**（`:1361`），文本类打开、其它 `vscode.open`（`:1368-1372`），回传 `{filePath,fileName}`（`:1376-1380`）但**前端没有 `downloadAttachment` 接收分支**，回执被丢弃。
- 工作区根只有 `workspaceFolders[0].uri.fsPath`（`AssignmentManager.ts:1169,1322`、`workspaceLogPath.ts:45,57,75`）；**没有任务级子目录概念**；`ensureStudentLogFile`（`workspaceLogPath.ts:69-99`）只在根建 `.cline-logs/student_interactions.log`。
- 面板范式现成：`FeedbackPanelProvider`（viewId `clineFeedbackPanel`）、`ThinkingQuestionsPanelProvider`（viewId `clineThinkingQuestionsPanel`，`reveal(payload,onConfirm)` 可带回调）；`App.tsx:47-49` 按 `data-view` 分发。

### 1.4 行为日志与干预：字段齐、分类粗、阻断式存在

- 唯一写入器 `StudentLogPersister.ts:14-15,38-40,69-77`（appendFile JSONL），cwd 由 `task/index.ts:1054-1059` 注入。写入点全在 `task/index.ts`：`task_start` `:1297-1339`、用户 `:1347-1401`（**先** `monitorBehavior` `:1394` **再** persist `:1395`）、助手 `:1408-1494`、`adoption_infer` `:1548-1570`、干预三事件 `:1117/:1127-1132/:1146`。
- 字段（`student-analytics/types.ts:77-148`）：`ts/taskId/eventType/role/category/queryType/dependencyWeight/contentLength/hasCode/hasCodeBlock/hasFullImpl/languageHint/imageCount/fileCount/turnIndex/rawContent(≤2000)/suggestionType/toolsUsed/filePath/changeDelta/editor/adoptionStatus/interventionRuleId…/copyVoice/copyDecision/copyReasons/copyAdvisories/demandCompliance`。
- **报错不记**：`student-analytics` 目录无 error/diagnostic/terminal 字段；终端痕迹另走 `.cline-logs/run_traces.jsonl`（`RunTraceCollector.ts:22-38`：`ts/command/exit_code/stdout_tail/shell/cwd`），与行为日志不互通。
- 自主编程识别：`CodeEditTracker.ts:114` 监听、2s 防抖（`:25,177-182`）、`flushEdit` 落 `code_edit`（`:261-276`），`editor` 由 `resolveEditEditor`（`:45`）查 `wasRecentlyWrittenByCline`（`:32`）；`file_save` `:195-239`。
- 采纳：`AdoptionTracker.ts:40` 60s 窗口、`:132-153` 判定；**缺陷**：`onCodeEdit:188`/`onFileSave:210` 不看 `editor`，AI 自己落盘也会被记成 adopted。
- 干预：仅 `ai_coding_rounds` 可阻断（`rulePolicy.ts:38`），常开规则 `:41`，策略 `:49-65`；阈值 `BehaviorMonitor.ts:38-73`（noEdit 3、assistantCode 3、escalation 3、aiCoding 3、依赖加权 3、cooldown 120s）；阻断态 `TeachingInterventionManager.ts:82-98,148-166,290-326`，`blockingCooldownMs` **60_000**（`:43-44`），执行于 `task/index.ts:3396`（`isBlockingActive`）→ `:3409`（requestKey）→ `:3439` `ask("followup", …)` → `:3451` 结束本轮；前端横幅 `webview-ui/src/components/chat/TeachingBlockingBanner.tsx`（挂载 `ChatView.tsx:348`），控制器 `src/core/controller/index.ts:901`。
- 分类只有两级：`TaskClassifier.ts:234`（`classify`，关键词表 `:25-233`）→ `refineStudentCategory`（`RequestIntentRefiner.ts:42`，调用 `task/index.ts:1354`），`queryType` 只是映射（`queryType.ts:12/27/40`），Web 端**不渲染**。

### 1.5 指标：四套口径同时在跑（这是「数值对不上」的根因）

**A. 看板 `backend/src/analytics.js`**（conv = `eventType ∈ {task_start, turn_message}`；key = `assignment_id || taskId`）
- `computeSummary:141-192`：`aiDependencyScore = assistant/(user+assistant)`（分母 conv，`:146-149`）；`codeGenerationRatio = assistant∧hasCode / assistant`（`:148,168`）；`adoptionRate = adopted / {adopted,rejected,continued}`（`:151-154`）；`interventionSuccessRate = improved / 全部 intervention_evaluation`（`:156-158`）；`codeEditRate = 有 code_edit 的 key / 全部 key`（`:169-170`）；`totalTasks = key 数`、`totalSessions = taskId 数`（`:143-144,173-175`）。
- `computeProfile:398-443`：`codeEditRatio = min(1, code_edit 事件 / assistant∧hasCode 轮)`（`:422`）；`selfModificationRate = 有 code_edit 的 taskId / 有 assistant 代码的 taskId`（`:424`）；`debuggingFrequency`（`:419`）；`explorationBreadth = 出现 category 去重 / 8`（`:418`）；`learningStyle:390-396`；`totalTasks = taskId 数`（`:401`，**与 summary 同名不同义**）。
- `computeInterventionInsights:257-388`：`successRate = improved / count`（`:356-368`），仅 `rawContent` 可解析的评估计入（`:130`）。
- `computeStudents:460-482`、`computeAssignments:490-519`（只认 `assignment_id`，`:493`）。

**B. 教学端 `teaching-server/src/server.ts` 的 `analyzeLogs:228-272`**：
`ai_dependency = (role=assistant ∨ category=code_generation) / 全部事件`（`:247-254`）；`adoptionRate = adopted / 全部 adoption_infer`（`:256-258`）；`metric_gaming_score = 0.7×adoption + 0.3×assistant 占比`（`:259-265`）；`user_edit_count = (code_edit ∨ refactoring)` 事件数（`:250-252`）。

**C. 提交包 `submission/metrics.ts:30-53`**：与 B 同式，`toFixed(2)`，落库 `bundleService.ts:260-293`（`metrics_source='local'`）。

**D. 报告页** `reportService.ts:221-226` **直读列、不重算**，`StudentReport.tsx:374-385` 展示。

**同一段真实数据（16 事件）实测差异**：看板 `9/11 = 81.8%`（`analytics.js:149`）vs 报告 `9/16 = 56%`（`server.ts:254`）。另有 6 处冲突：同名 `codeEditRate`/`codeEditRatio` 两种分母（`:170` vs `:422`，后者可能被 clamp 到 1）；`totalTasks` 两义（`:144` assignment vs `:401` taskId）；`selfModificationRate` 注释与实现不符（`server.ts:917-918` 说 user_edit_count/totalUserTurns）；采纳率分母三状态 vs 全部；干预成功率教学端无实现且丢弃无 `rawContent` 的评估；`dashboardEvents.ts:63-76` 从不读 `submissions.ai_dependency`；**`dependencyWeight`/`queryType` 已入数据流但四套公式都没读**。

---

## 2. 总体设计

### 2.1 三个新概念

1. **`sessionMode`（会话模式）**：`"free" | "experiment"`。模式决定「是否记日志」「是否干预」「是否装配任务上下文」。默认 `free`，进入实验模式必须显式点「开始实验」。
2. **`behaviorType`（行为类型）**：六类。新增字段，**不改 `queryType` 语义**（它是外部契约，教师端已按它复算，见 `docs/design/teaching-intervention-fix-plan-2.md:1590-1593`）。
3. **`metricsSpec`（指标唯一口径）**：一份常量 + 公式说明，三端各自实现但由契约闸门比对，前端只展示、不重算。

### 2.2 数据流

```
学生提问 ──► TaskClassifier/RequestIntentRefiner ──► behaviorType + weight
                    │
                    ├─ free 模式 ──► 不写 student_interactions.log
                    │               （run_traces.jsonl 仍写，供报错追踪）
                    │               不跑 BehaviorMonitor / InterventionManager
                    │               仍注入 wiki 索引 + 预召回教材片段
                    │
                    └─ experiment 模式 ──► 写日志（含 behaviorType）
                                           软干预（无阻断）
                                           上下文 = 实验指导 + 附件 + 教材片段 + 运行痕迹 + 代码
                     ▼
        student_interactions.log ──► 提交包 ──► teaching-server
                                                    ├─ submissions（含 behavior 统计）
                                                    └─ dashboard/…jsonl ──► backend 看板
```

### 2.3 关键取舍（先给结论，理由见各章）

| 决策 | 选择 | 否决的替代 | 理由 |
|---|---|---|---|
| D1 检索 | 「预召回 + 工具」双通道：每次提问先用**用户原文**打后端 search（top3，1600 字）注入「参考教材片段」，同时保留 MCP 工具供深挖 | 只靠模型自主调工具 | 需求要求「若存在相关教材资料则根据资料回答」，纯靠工具在弱模型上会不调用（v2.13 实测过） |
| D2 去周数范围 | 学生端完全去周数；**教师端发布仍保留 `week` 字段**（仅作排序/归档） | 连 `week` 列一起删 | 教师端「按周发布/筛选」是教学管理需求，与学生可见性无关 |
| D3 模式切换 | 显式按钮 + 顶部徽标；实验模式绑定到一个任务目录；退出即回自由模式 | 自动按文件路径推断 | 自动推断会误判（学生随手打开别的文件） |
| D4 日志位置 | 实验模式写 `<实验目录>/.cline-logs/`，自由模式写工作区根 `.cline-logs/`（自由模式几乎不写） | 全部写根目录 | 需求明确要子目录；且终端脚本 `walk-up` 天然能找到（见 §4.4） |
| D5 行为分类实现 | 规则优先（关键词 + 事件信号）+ 可选的 LLM 兜底（`teaching.behaviorClassifyLLM`，默认关） | 纯 LLM 分类 | 日志要可复算、可审计；LLM 每次调用成本高且不可解释 |
| D6 权重 | concept **0.25** / design **0.75** / error_help **1.0** / self_code **0** / ai_code **1.2**（取你给区间的中点） | 用区间端点 | 中点是可解释的默认值，改一行常量即可调 |
| D7 依赖度归一化 | `depIndex = Σw / (1.2 × N)`（0–1，可直接当百分比）；同时回传 `weightedMean = Σw/N`（0–1.2） | 只回传平均值 | 教师需要 0–100% 的直觉值，也需要原始均值做统计 |
| D8 阻断 | **整体删除**（代码、横幅、测试） | 保留但默认关 | 需求明确「取消 60 秒阻隔式干预」；留着是死代码 + 认知负担 |
| D9 口径统一 | 三端各一份实现 + `contract-check.mjs` 断言权重与公式字符串一致；历史数据 `metrics_schema='legacy'` 不重算 | 抽公共 npm 包 | 两个仓库独立部署，抽包成本高于断言守卫 |

---

## 3. 需求 1：取消周数，改为内容检索

### 3.1 要删的东西（学生端）

| 位置 | 处理 |
|---|---|
| `package.json:445-451` `clineTeaching.currentWeek` | 标 `deprecationMessage` 并停止读取；P0 结束后可整段删除 |
| `webview-ui/src/components/menu/WikiWeekSelector.tsx` + `Navbar.tsx:103` | 删除组件与挂载 |
| `AssignmentTab.tsx:323-344,923-956`（底部学习进度） | 删除（死控件） |
| `AssignmentHeader.tsx`（整文件，已不被引用） | 删除 |
| `weekStateFile.ts` / `weekStatePath.ts` | 删除，并清理残留 `teaching-week.json` |
| `WikiMcpRegistrar.ts:54-78,238-247`、`extension.ts:188-193` | 去掉 `--week`/`--week-file` 与切换监听 |
| `mcp-wiki-server.ts:31-37`（`effectiveWeek`）、`args.ts:26-52` | 删除，工具签名不变（本来就没有 week 参数） |
| `wikiPrompt.ts:19-23,38-50` | 去掉「第 N 周」，认知边界改为「教材已发布范围」 |
| `LLMWikiService.ts:329-378`（visible 过滤）、`:349`（`max_week`）、`:303`、`:140-190` | 去掉周状态，保留 index 构建 |
| `VscodeWebviewProvider.ts:20-37,311-327` | 删除 `switchWeek` 分支 |
| `LLMSettingsView.tsx:282,346` | 文案里 `grep_wiki`/`read_chunk` 已过时，顺手改 |

> 注意：改 `mcp-wiki-server.ts` 后必须重建 `dist/mcp-wiki-server.js`（`esbuild.mjs` 产出），否则学生机上仍跑旧 bundle。

### 3.2 后端（`D:\web-dashboard\teaching-server`，成败所在）

`server.ts` 四个 wiki 端点 + `wikiSearch.ts`：

| 现在 | 改为 |
|---|---|
| `GET /api/v1/wiki?week=N` | `GET /api/v1/wiki?max_week=&scope=`（都**可选**；不传=全部已发布） |
| `GET /api/v1/wiki/search?q=&week=N` | `GET /api/v1/wiki/search?q=&limit=&max_week=`（`max_week` 仅作兼容过滤） |
| `GET /api/v1/wiki/chunks/:id?week=N` | `GET /api/v1/wiki/chunks/:id`（不校验周） |
| `GET /api/v1/wiki/weeks` | 保留（教师端仍用） |
| SQL `applicable_week <= ?` | 去掉；改用**相关度**排序（现有 `LIKE`/FTS 打分 + 标题命中加权 + chunk 顺序） |

**兼容策略**：旧客户端仍会传 `week=N`，服务端**接受并忽略**（不 400），并在响应 `meta.week_ignored = true` 标记一次。这样灰度期不会打挂已安装的旧插件（`args.ts:36` 解析失败会回退默认，容易踩坑）。

### 3.3 召回质量（预召回通道）

新增 `LLMWikiService.recallForQuestion(userText, {limit=3, budget=1600})`：
1. 取最近 1 条用户文本（≤300 字）+ 当前实验任务标题（若有）拼 query；
2. `GET /api/v1/wiki/search?q=…&limit=8`；
3. 去重、按 chunk 分数排序，拼成：

```
## 参考教材片段（自动检索，可能不完整）
[教材#<chunk_id>｜<title>] <content 截断 500 字>
…
规则：上述片段若与问题相关，必须以此为准并在回答末尾标注来源 (教材: <chunk_id>)；
若片段与问题无关，不要强行引用，直接说明「教材中暂未找到直接相关内容」。
```

4. 注入点：`task/index.ts:2595-2603` 的 `buildWikiSystemPrompt` 之后（预算 2400 → **4000 字符**，索引部分按相关度截断）。
5. 无命中时只注入索引（现状行为），避免空上下文。

**验收**：问「什么是列表推导式」→ 命中 `chunk_id` 且回答引用；问「今天天气」→ 不引用、不编造教材内容。

---

## 4. 需求 2：两类对话模式

### 4.1 状态机与入口

```
free（默认）
  │ 点击任务详情面板「开始实验」
  ▼
experiment(assignmentId, experimentDir)  ← 可切换到别的任务（旧目录保留）
  │ 点「结束实验」/ 关闭 VS Code 重开（默认回 free）
  ▼
free
```

- 存储：`context.workspaceState`（键 `teaching.sessionMode`、`teaching.activeExperiment`），**不进 `settings.json`**（避免污染学生配置）；同时写 `<experimentDir>/.teaching/task.json` 供恢复与教师端核对。
- 入口：
  - 自由模式：现有聊天界面，顶部徽标「💬 自由问答」；
  - 实验模式：徽标「🧪 实验：<任务标题>」（替换原周数控件的位置，`Navbar.tsx` 右侧）。
- 模式对系统的可见影响（**唯一判定点**，集中在 `TeachingSessionMode.ts` 一个模块）：
  - `shouldPersistBehaviorLog()` → free: false，experiment: true
  - `shouldRunIntervention()` → free: false，experiment: true
  - `guidancePolicy()` → free: 阶梯 3 级 + 3 次放行；experiment: 阶梯 3 级 + 第 4 次仅伪代码
  - `contextAssembly()` → free: wiki + 近期 run_traces；experiment: + 实验指导 + 附件文本 + 任务模板

### 4.2 自由问答模式

| 行为 | 规则 |
|---|---|
| 日志 | **不写** `student_interactions.log`；不跑 `BehaviorMonitor`/`TeachingInterventionManager` |
| 报错追踪 | 仍写 `<workspace>/.cline-logs/run_traces.jsonl`（`RunTraceCollector` 已有）；学生问「为什么报错」时把最近 3 条 trace 注入上下文 |
| wiki | **启用**（预召回 + 工具），回答须以教材为准 |
| 回答风格 | 引导阶梯 L1 方向 → L2 大致思路 → L3 具体思路；**默认不给完整代码** |
| 放行规则 | 连续第 3 次明确索要完整实现才给完整代码，且：中文注释逐段解释 + 末尾「这段代码的关键点/你需要自己改的地方」 |
| 计数 | 放行次数只存 `workspaceState`（`teaching.freeDemandCount`），**不入日志**（free 模式不记录学生行为） |

### 4.3 实验任务模式

#### 4.3.1 任务详情面板（替代「双击建文件」）

- 新面板 `AssignmentDetailPanelProvider`：`viewId = "clineAssignmentDetailPanel"`，`data-view` 同名字段；沿用 `FeedbackPanelProvider` 的 `getInstance(extensionUri)` + `reveal()` + CSP/nonce 范式。
- 内容（把现在 `AssignmentTab.tsx:851-913` 那段迁移过去）：
  - 标题、周次徽章（仅展示，不参与过滤）
  - 实验指导书 `description`（Markdown 渲染，**不再 `pre-wrap` 纯文本**）
  - 附件列表：**下载**与**在编辑器打开**两个动作（修掉「回执被丢弃」的缺陷：`AssignmentTab` 增加 `downloadAttachment`/`openFile` 接收分支）
  - 模板代码预览（只读，折叠）
  - 主按钮：**开始实验**
- 侧栏 `AssignmentTab` 改为：单击 → 发 `openAssignmentDetail`（开面板）；双击行为**删除**；底部保留「提交实验」与「学生信息」。

#### 4.3.2 「开始实验」做什么

```
<workspace>/
└── experiments/
    └── <assignmentId>/                ← D6：独立子工作区
        ├── <template file>            ← template_code 或按语言推断扩展名（.py/.c/.java…）
        ├── GUIDE.md                   ← LLM 生成的实验指导（见 4.3.3）
        ├── attachments/               ← 全部附件落这里（原来平铺在工作区根）
        ├── .cline-logs/
        │   ├── student_interactions.log
        │   └── run_traces.jsonl
        └── .teaching/
            └── task.json              ← {assignmentId,title,week,startedAt,mode:"experiment",templateFile,guideHash}
```

- 幂等：目录已存在 → 不覆盖学生文件，只补缺失项（`.cline-logs`/`GUIDE.md`），并提示「继续上次的实验」。
- 附件文本化：新增 `GET /api/v1/assignments/:id/attachments/:fileId/text`（服务端已有 `officeParser`/`textbookParser`，返回 `{ok,text,truncated}`），供上下文装配；附件本体仍下载到 `attachments/`。
- 切目录后打开模板文件（`showTextDocument`），并**不**强制切换 VS Code 窗口（`vscode.openFolder` 会重启窗口，此处不用）。

#### 4.3.3 实验指导生成（LLM，一次性）

- 输入：任务标题 + `description` + 附件文本（每份 ≤3000 字，合计 ≤8000）+ 教材片段（预召回 top5，≤3000）+ 模板代码（≤1500）。
- 输出：`GUIDE.md`，结构固定：
  1. 本次实验要达成的目标（可验证的 3–5 条）
  2. 涉及的知识点（引用教材 chunk id）
  3. 建议步骤（**只给方向与检查点，不给完整代码/完整设计**）
  4. 常见坑与自查清单
  5. 提交前自检
- 硬约束（prompt + 后校验）：不得出现完整可运行实现；代码块只允许 ≤5 行的片段或伪代码；出现 `def main`/完整函数体 → 重写一次，仍失败则降级为纯文字步骤。
- 缓存：`guideHash = sha1(description + 附件文本 + 教材片段)`，命中则复用；面板提供「重新生成」。

#### 4.3.4 实验模式的上下文装配（每次请求）

预算总计 **≤ 6000 字符**（可配 `teaching.experimentContextBudget`）：

| 段 | 上限 | 来源 |
|---|---|---|
| 实验指导（`GUIDE.md`） | 2200 | 本地 |
| 附件要点（LLM 摘要或首 3000 字） | 1200 | `/text` 端点 |
| 教材片段（预召回） | 1600 | wiki search |
| 运行痕迹（最近 5 条，失败优先） | 800 | `.cline-logs/run_traces.jsonl` |
| 当前文件片段（活动编辑器前 120 行） | 800 | 编辑器 |

注入位置同 §3.3，`ephemeralIntervention` 之外新增 `ephemeralExperimentContext`（**不**占用干预文案的回执机制）。

### 4.4 日志路径改造

现状 `workspaceLogPath.ts` 只认 `workspaceFolders[0]`。改造：

```ts
// 新增 teachingSession.ts
export function activeLogRoot(): string | null
// experiment → <experimentDir>；free → <workspaceRoot>（但 free 只写 run_traces）
```

- `StudentLogPersister` 的 `cwd` 来源（`task/index.ts:1054-1059`）改调 `activeLogRoot()`。
- `logPathResolver` 增加 `experimentRoot` 入参，优先级：`--log` > `CLINE_STUDENT_LOG` > `--workspace` > `experimentRoot` > 工作区根 > cwd > 向上回溯。终端脚本因此**在实验目录里跑就自动分析该实验的日志**，在工作区根跑则分析根日志 —— 与需求 1 的「不带参数分析默认路径」一致。
- 提交包（`prepareSubmission`）里的 `logPath` 同样取 `activeLogRoot()`，保证「上传的日志 = 面板显示的那份」。

---

## 5. 需求 3：六类行为、去阻断、指标重算

### 5.1 六类行为定义与判定

| 类型 | 中文 | 判定信号（按优先级） | 权重 |
|---|---|---|---|
| `error_help` | 报错求助 | ①最近 10 分钟内有 `run_traces` 且 `exit_code ≠ 0` ②文本含 `Traceback/Error/Exception/报错/异常/undefined/null pointer/段错误/编译错误` ③粘贴了 ≥3 行栈信息 | **1.0** |
| `design` | 思路询问 | 文本含 `思路/怎么实现/如何设计/步骤/方案/从哪里开始/用什么结构` 且无报错信号 | **0.75** |
| `concept` | 概念问答 | 文本含 `什么是/是什么/区别/语法/怎么用/数据结构有什么/为什么` 且无代码请求、无报错 | **0.25** |
| `self_code` | 学生自主编程 | `code_edit` 且 `editor = "user"`（`CodeEditTracker:45`）；或 `file_save` 且非 AI 近期写入 | **0.0** |
| `ai_code` | 助手编程 | 助手轮 `hasFullImpl = true`，或 `toolsUsed ∈ {write_to_file, replace_in_file}` 且 `changeDelta` 为整文件/整函数 | **1.2** |
| `other` | 其他 | 与任务无关：问候/闲聊/其他课程/测试消息；判定为兜底类 | —（分子分母都不计） |

判定细则：

1. **一轮学生消息只归一主类**（`error_help` > `design` > `concept` > `other`）。
2. `self_code`/`ai_code` 是**非消息类事件**，分别独立计数（不占「一轮」）。
3. 助手同轮既讲解又给完整实现 → 该轮记 `ai_code`（讲解部分不再单独计 `concept`）。
4. 需求里的「伪代码」判定（**2026-10-23 用户裁定**，见 §11 Q2）：**逻辑完整、翻译为对应语言后可直接运行的伪代码，计 `ai_code`（1.2）**。理由：实验任务模式**永不给可运行的完整实现**，伪代码就是该模式下唯一的「助手编程」形态；若不算，`ai_code` 在这些会话里恒为 0，与「只有提供代码才记助手编程、否则记思路询问」的设计自相矛盾。
   判据（`behaviorSignals.codeKind`）：
   - `full`：整函数/整文件落盘（`write_to_file` / `replace_in_file` 后 `changeDelta` 覆盖完整逻辑）→ `ai_code`。
   - `pseudo_complete`：给了伪代码且**具备完整控制流 + 关键步骤 + 输入输出、无 `TODO/省略/自行补充`** → `ai_code`。
   - `pseudo_partial`：只给方向、骨架或关键步骤缺失 → `design`。
   - `snippet`：局部片段（<5 行、无完整语义）→ `design`。
   判定以**规则为主**（结构信号：函数签名/`返回`/控制流关键词/占位符检测/行数阈值），`teaching.behaviorClassifyLLM=true` 时可用模型兜底并把 `behaviorSource` 记为 `llm`。
5. **伪代码的放行阶梯（用户需求原文）**：第 1–3 次索要完整实现 → 拒绝 + 引导（记 `design`）；**第 4 次起才提供伪代码**（`pseudo_complete` 则记 `ai_code`）。自由问答模式不同：第 3 次即给**完整代码**（`full`，记 `ai_code`），且须逐段中文注释。
6. 分类实现：`behaviorClassify.ts`（新模块，纯函数），复用 `inabilityDetect.ts:56`、`demandDetect.ts:37`、`fullImplementationDetect.ts:56`、`TaskClassifier` 关键词表；`teaching.behaviorClassifyLLM`（默认 `false`）可开启 LLM 兜底，结果写 `behaviorSource:"llm"`。
7. 日志新增字段：`behaviorType`、`behaviorWeight`、`behaviorSource`（`"rule"|"llm"`）、`behaviorSignals`（命中的关键词/信号，≤120 字，便于审计）。**`queryType` 保留**并按 `concept→concept`、`design|error_help→coding`、`other→other` 映射，保证旧教师端可读。

### 5.2 干预重设计（删除阻断 + 软提示）

**删除清单**

- `TeachingInterventionManager.ts` 中 `blockingActive/blockingEndsAt/triggerBlocking/isBlockingCooldownExpired` 等（`:82-98,148-166,290-326,382-387`）
- `InterventionMessageGenerator.ts:347-430`（`generateBlockingInterventionMessage`、`formatBlocking…`）
- `task/index.ts:3393-3452`（阻断回合：`isBlockingActive`/`requestKey`/`ask("followup")`/`return true`）
- `webview-ui/src/components/chat/TeachingBlockingBanner.tsx` + `ChatView.tsx:348` + `src/core/controller/index.ts:901` 的横幅状态
- `rulePolicy.ts:38` 的阻断白名单、`BehaviorMonitor.ts` 的 `blockingTriggered`（`:147,772,798,834`）
- 断言 60_000 的测试（`__tests__/interventionParams.test.ts:9`、`interventionRegression.test.ts:90`、`blockingIdempotence.test.ts` 等）→ 改为断言「不存在 blocking 类型」

**保留/新增的软提示（6 条，全部 `severity: hint|question`，永不阻断）**

| 规则 | 触发 | 文案方向 |
|---|---|---|
| `design_stall` | 连续 3 次 `design` 且期间无 `self_code` | 「先用 3 行伪代码写下你的猜测，再来问」 |
| `same_error_twice` | 同一 `exit_code`+同一首行错误 2 次 | 「把最小复现代码缩到能复现的那 5 行」 |
| `full_impl_demand` | 本轮索要完整实现（`demandDetect`） | 拒绝 + 给方向；**第 4 次起给伪代码**（完整逻辑 → `ai_code`，否则 `design`） |
| `ai_code_streak` | 连续 2 次 `ai_code` 且中间无 `self_code` | 「读懂这段后自己改 3 行」 |
| `concept_streak` | 连续 3 次 `concept` 且无 `self_code` | 「先动手试一行，再回来问概念」 |
| `error_no_progress` | `error_help` 后 5 轮内无 `file_save`/新 `run_trace` | 「加一行 print / 断点看变量」 |

节流：仍用 `cooldownMs = 120_000`、每条规则每学生请求最多 1 次（现有 `BehaviorMonitor` 机制保留），但**不修改任务流程、不结束回合**。

### 5.3 AI 依赖度新公式

```
W = { concept: 0.25, design: 0.75, error_help: 1.0, self_code: 0.0, ai_code: 1.2 }
N = 参与计分的行为条数（other 不计）
ΣW = Σ W[behaviorType]
depIndex      = ΣW / (1.2 × N)      // 0–1，前端显示百分比
weightedMean  = ΣW / N              // 0–1.2，供统计/回归
```

示例：全自主 `0%`；1 概念 + 1 自主 `(0.25+0)/(1.2×2)=10.4%`；半自主半求助 `(0+1.0)/(1.2×2)=41.7%`；全助手 `100%`。

**分档建议**（用于教师端标签与颜色）：`<20% 自主` / `20–40% 轻度依赖` / `40–60% 中度依赖` / `60–80% 较重依赖` / `≥80% 重度依赖`。

**为什么归一化到 1.2**：最大权重 1.2 对应「全部由助手写」，不归一化会得到 0–1.2 的奇怪区间；归一化后 `depIndex` 与旧 `aiDependencyScore` 同为 0–1，前端所有百分比组件无需改。

### 5.4 其他指标重设计（替换现有同名指标）

| 指标 | 新定义 | 旧定义 | 变化理由 |
|---|---|---|---|
| `aiDependencyScore` | 见 §5.3 | assistant/(user+assistant) | 需求指定加权 |
| `selfCodingRatio`（新名，替换 `codeEditRate`） | `self_code / (self_code + ai_code)` | 有 code_edit 的任务占比 | 原指标把「改一行」与「写整段」同等计 |
| `adoptionDeepening`（替换 `adoptionRate`） | `adopted 且 5 轮内出现 self_code / adopted` | adopted / 三状态 | 「采纳后有没有自己动手」才是教学价值 |
| `guidanceEffect`（替换 `interventionSuccessRate`） | `提示后 3 轮内 self_code↑ 或同类错误消失 / 提示数` | improved / 全部评估 | 旧口径依赖 `intervention_evaluation`，实现缺失、且丢弃无 `rawContent` 的评估 |
| `errorResolutionRate`（新） | `报错求助后 5 轮内出现 exit_code=0 的新 trace / 报错求助数` | 无 | 直接衡量「会不会自己排错」 |
| `behaviorMix`（新） | 六类计数与占比 | 无 | 看板主图，替掉 `category` 饼图 |
| `guideLadderDepth`（新） | 平均「从 design 到 self_code 的轮数」 | 无 | 衡量引导阶梯是否真的推动了动手 |
| `dependenceTrend`（新） | 每周 depIndex 折线 | 无 | 教师看变化而非快照 |

保留：`totalTasks`（= assignment 去重）、`totalSessions`（= taskId 去重，**必须分开显示**）、`codeGenerationRatio`（助手代码消息占比，改名 `aiCodeShare` 避免与 `selfCodingRatio` 混淆）、`learningStyle`（改用新 depIndex 阈值 `.75/.3` 不变）。

### 5.5 口径统一（「所有界面数值一致」）

1. 新增 `docs/design/metrics-spec.md` + 三份 `metricsSpec` 常量文件：
   - `src/core/task/student-analytics/metricsSpec.ts`
   - `backend/src/metricsSpec.js`
   - `teaching-server/src/submission/metricsSpec.ts`
   每份导出 `BEHAVIOR_WEIGHTS`、`DEPENDENCY_DIVISOR`、`ADOPTION_WINDOW_TURNS`、`GUIDANCE_WINDOW_TURNS`、`specVersion`。
2. `teaching-server` 入库时按 `behaviorType` 重算（无 `behaviorType` 的旧事件回退 `queryType` 映射），写入新列；`metrics_source='local'|'snapshot'|'legacy'` 保留。
3. 看板 `backend/src/analytics.js` 改成读同一 spec（权重从 spec 导入，不再硬编码）。
4. `teaching-server/scripts/contract-check.mjs` 增加第 13 组：三份 spec 的 `BEHAVIOR_WEIGHTS` 六个数值、`DEPENDENCY_DIVISOR`、`specVersion` 必须一致；`analytics.js` 里不得出现硬编码权重字面量。
5. `frontend` 只展示 API 返回的 `depIndex/behaviorMix/...`，**禁止前端重算**（现有 `App.jsx:42-51` 的雷达归一化保留，但输入改为后端字段）。

### 5.6 数据库变更（`teaching-server`，迁移 v3）

```sql
ALTER TABLE submissions ADD COLUMN metrics_schema TEXT;        -- 'legacy' | 'weighted-v1'
ALTER TABLE submissions ADD COLUMN dep_index REAL;             -- 0..1
ALTER TABLE submissions ADD COLUMN behavior_counts TEXT;       -- JSON {concept,design,error_help,self_code,ai_code,other}
ALTER TABLE submissions ADD COLUMN self_coding_ratio REAL;
ALTER TABLE submissions ADD COLUMN guidance_effect REAL;
ALTER TABLE submissions ADD COLUMN error_resolution_rate REAL;
```

- `PRAGMA user_version` 3；旧行 `metrics_schema='legacy'`、新列 NULL，报告页显示「旧口径」标签而不是显示 0。
- `ai_dependency` 列保留写 `dep_index*100`（兼容旧前端/旧接口）。

---

## 6. 数据契约变更

### 6.1 行为日志（`student_interactions.log`，只增不删）

```jsonc
{
  "ts": "...", "taskId": "...", "eventType": "turn_message",
  "role": "user", "category": "coding",
  "behaviorType": "design",        // 新增：六类之一
  "behaviorWeight": 0.75,          // 新增
  "behaviorSource": "rule",        // 新增：rule | llm
  "behaviorSignals": "思路,怎么实现", // 新增（≤120 字）
  "queryType": "coding",           // 保留：由 behaviorType 映射
  "dependencyWeight": 0.75,        // 语义改为 behaviorWeight（旧值 0.5/1 兼容读）
  "mode": "experiment",            // 新增：free | experiment
  "experimentId": "task_week5_oop" // 新增：实验模式下的任务 id，free 为 null
}
```

### 6.2 提交包 meta 扩展

`BundleMeta` 增加可选 `behavior_summary`：`{counts:{…}, depIndex, weightedMean, specVersion}`；服务端校验 `specVersion` 与自身一致，不一致则按自身 spec 重算并在 `warnings` 里说明。

### 6.3 API

| 端点 | 变更 |
|---|---|
| `/api/v1/wiki/*` | 去 week 必填（§3.2） |
| `/api/v1/assignments/:id/attachments/:fid/text` | 新增：返回附件纯文本（供实验指导与上下文） |
| `/api/v1/dashboard/events` | 事件透传 `behaviorType/behaviorWeight/mode`（已有字段直接流出） |
| `/api/dashboard/summary` 等 | 新增 `depIndex/weightedMean/behaviorMix/selfCodingRatio/adoptionDeepening/guidanceEffect/errorResolutionRate/guideLadderDepth`；`aiDependencyScore` 语义改指向 `depIndex`（旧字段名保留一个版本） |

---

## 7. 改造清单（按仓库/文件）

### 7.1 `D:\cline`（扩展）

**新增**
- `src/core/teaching/TeachingSessionMode.ts`：模式状态机 + `activeLogRoot()` + `contextAssembly()`
- `src/core/teaching/ExperimentWorkspace.ts`：建子工作区、下载附件、生成 `GUIDE.md`、写 `.teaching/task.json`
- `src/core/teaching/ExperimentGuide.ts`：指导书生成 prompt + 校验 + 缓存
- `src/core/teaching/AttachmentContext.ts`：附件文本拉取与截断
- `src/core/task/student-analytics/behaviorClassify.ts` + `metricsSpec.ts`
- `src/hosts/vscode/AssignmentDetailPanelProvider.ts`
- `webview-ui/src/components/teaching/AssignmentDetailForm.tsx`
- 单测：`behaviorClassify.test.ts`、`modeLogging.test.ts`、`experimentWorkspace.test.ts`、`metricsSpec.test.ts`

**修改**
- `src/core/task/index.ts`：日志写入前后加 mode gate（`:1297-1570`）、干预调用加 gate（`:3393-3452` 删除阻断分支）、上下文装配（`:2581-2603`）、`cwd` 来源改 `activeLogRoot()`（`:1054-1059`）
- `src/core/task/student-analytics/StudentLogPersister.ts`：写 `behaviorType/behaviorWeight/mode/experimentId`
- `StudentProfiler.ts:110-113,242`：改用 `metricsSpec`
- `BehaviorMonitor.ts`：删 blocking 状态；保留软提示与 `dependencyWeightedThreshold`
- `TeachingInterventionManager.ts`、`InterventionMessageGenerator.ts`、`rulePolicy.ts`、`types.ts`、`interventionDisplay.ts`：删阻断
- `AssignmentManager.ts`：新增 `openAssignmentDetail`/`startExperiment`/`endExperiment`/`fetchAttachmentText` 命令；`handleCreateOneFile` 保留但 UI 不再调用（P1 后删除）
- `webview-ui/src/components/teaching/AssignmentTab.tsx`：双击删除、单击开面板、补 `downloadAttachment`/`openFile` 接收分支、删底部学习进度
- `Navbar.tsx`：周数控件 → 模式徽标
- `VscodeWebviewProvider.ts` / `App.tsx`：注册新面板与 `data-view` 分支
- `package.json`：删 `currentWeek`，新增 `teaching.behaviorClassifyLLM`、`teaching.experimentContextBudget`、`teaching.experimentRootDir`（默认 `experiments`）

**删除**：`WikiWeekSelector.tsx`、`AssignmentHeader.tsx`、`weekStateFile.ts`、`weekStatePath.ts`、`TeachingBlockingBanner.tsx`

### 7.2 `D:\web-dashboard`

**teaching-server**
- `src/server.ts:611-640`（wiki 端点）/`src/wikiSearch.ts`：去 week 过滤，改相关度
- `src/server.ts` 新增 `GET /api/v1/assignments/:id/attachments/:fid/text`
- `src/submission/metrics.ts` + `src/submission/metricsSpec.ts`：六类加权
- `src/db/migrations.ts`：v3 迁移
- `src/submission/bundleContract.ts`：`behavior_summary`、`specVersion`
- `scripts/contract-check.mjs`：第 13 组（spec 一致性）

**backend**
- `src/analytics.js`：`computeSummary`/`computeProfile`/`computeInterventionInsights` 改用新口径 + 新字段
- `src/metricsSpec.js`（新）
- `scripts/check-metrics-spec.mjs`（新闸门）

**frontend**
- `src/App.jsx`：KPI 替换（depIndex/selfCodingRatio/adoptionDeepening/guidanceEffect/errorResolutionRate）、`behaviorMix` 饼图、`dependenceTrend` 折线、`totalTasks`/`totalSessions` 分列
- `src/components/StudentReport.tsx`：新增六类计数与 `metrics_schema` 标记

---

## 8. 实施计划

| 阶段 | 任务 | 人日 | 闸门 |
|---|---|---|---|
| **P0 去周数**（3.5） | P0-1 后端 wiki 端点去 week + 相关度排序 + 兼容 `week_ignored`（1.0）；P0-2 扩展侧删周数（UI/配置/状态文件/MCP 参数）0.8；P0-3 预召回与 prompt 重写（0.8）；P0-4 `attachments/:fid/text` 端点（0.4）；P0-5 闸门：wiki 检索命中率脚本 + 无周数回归（0.5） | 3.5 | `node scripts/check-wiki-search.mjs`（新，≥20 断言）；扩展 `npx mocha` 全绿；`dist/mcp-wiki-server.js` 重建后 `verify-mcp-wiki-server.mjs` 通过 |
| **P1 双模式**（5.5） | P1-1 模式状态机 + gate（1.0）；P1-2 任务详情面板 + 侧栏改造（1.2）；P1-3 实验子工作区与日志根（1.0）；P1-4 实验指导生成 + 校验（1.2）；P1-5 上下文装配（0.6）；P1-6 闸门与手测（0.5） | 5.5 | `experimentWorkspace.test.ts`、`modeLogging.test.ts`；手测 M-70~M-78；`npm run build`（webview） |
| **P2 行为与指标**（6.0） | P2-1 `behaviorClassify` + 字段（1.5）；P2-2 删阻断（1.0）；P2-3 软干预 6 规则（1.0）；P2-4 三端 spec + 新指标（1.5）；P2-5 迁移 v3 + 报告页（0.5）；P2-6 闸门与文档（0.5） | 6.0 | `behaviorClassify.test.ts`、`check-metrics-spec.mjs`、`contract-check.mjs` 第 13 组、`check-dashboard-events.ts`、`check-dashboard-source.mjs`、全量 mocha |

**总计 15.0 人日**，建议串行（P2 依赖 P1 的模式字段与 P0 的上下文）。

> **执行入口**：可落地的 19 项任务分解、逐项测试命令与判据、46 条边界矩阵、全流程联调脚本、18 条回归闸门、提交与 CHANGELOG 计划见
> [teaching-modes-and-behavior-metrics-plan.md](teaching-modes-and-behavior-metrics-plan.md)（v1.0，2026-10-23）。

---

## 9. 测试计划

- **单测**：六类判定 30+ 例（每类正例/反例/边界：伪代码、粘贴栈、混合意图）；权重与归一化 8 例；模式 gate 6 例（free 不写日志、experiment 写）；日志路径解析 5 例（实验目录/根目录/CLI walk-up）。
- **闸门脚本**：
  - `backend/scripts/check-metrics-spec.mjs`：三份 spec 常量一致、analytics 无硬编码、同一 fixture 三端算出的 `depIndex` 相同（±1e-6）。
  - `teaching-server/scripts/check-wiki-search.mjs`：无 week 参数可检索全库、旧 week 参数被忽略、相关度排序稳定、空命中返回空数组。
  - `contract-check.mjs` 第 13 组。
- **人工验收**（追加到 `docs/manual-test-plan.md`）：
  - M-70 自由模式问代码题 → 三次内只给方向；第 3 次给完整代码且带逐段注释；`student_interactions.log` **无新增行**。
  - M-71 自由模式故意运行报错 → `run_traces.jsonl` 有记录，提问时助手能引用该报错。
  - M-72 点任务 → 详情面板出现指导书/附件；双击不再建文件。
  - M-73 开始实验 → 目录结构与模板正确、`.cline-logs` 存在、`GUIDE.md` 不含完整实现。
  - M-74 实验模式提问 → 日志含 `behaviorType`；提交后报告页与看板 `depIndex` 一致（±0.1%）。
  - M-75 连续 3 次索要完整实现 → 第 1–3 次拒绝并给思路，第 4 次给伪代码且该轮记 `design`。
  - M-76 触发原来会阻断的场景（连续 AI 写文件 3 次）→ **不再出现横幅、不再中断回合**，只有软提示。

---

## 10. 风险与回滚

| 风险 | 影响 | 对策 |
|---|---|---|
| 后端未升级时扩展已升级 | wiki 检索 400 → 回答无教材依据 | 扩展先探测 `/api/v1/wiki?max_week=`，失败回退旧 `?week=18` |
| 去周边界 → 学生看到后续周资料 | 教学进度泄露 | 需求已明确不限制；文档记录该决定，教师端可按 `publish` 状态控制（未发布不可检） |
| 预召回每次请求多一次 HTTP | 首 token 延迟 +150~300ms | 3s 超时 + 5 分钟 LRU 缓存（query hash）+ 失败静默降级到索引 |
| 实验指导生成出完整代码 | 违背教学设计 | prompt 硬约束 + 后校验（`def main`/完整函数体）+ 失败降级纯文字 |
| 六类分类误判 | 指标偏移 | 规则可审计（`behaviorSignals`）；提供 `teaching.behaviorClassifyLLM` 兜底；阈值可配置 |
| 删除阻断后 AI 代写变多 | 依赖度上升 | 软提示 + `ai_code_streak` + 教师端 `depIndex` 分档告警 |
| 指标切换导致历史曲线断裂 | 教师误读 | `metrics_schema` 标记 + 前端「旧口径」徽标 + 趋势图只连新口径点 |
| 日志搬到实验目录后旧提交找不到 | 报告/看板缺数据 | `logPathResolver` 优先级保证；提交包 meta 记录 `log_file` 绝对路径与 `experiment_id` |

---

## 11. 决策表（**2026-10-23 已全部裁定**）

| # | 问题 | 结论 |
|---|---|---|
| Q1 | 六类权重最终值 | **按推荐**：concept **0.25** / design **0.75** / error_help **1.0** / self_code **0** / ai_code **1.2** |
| Q2 | 伪代码算不算「助手编程」 | **算**（用户裁定，推翻原推荐）：逻辑完整、翻译后可直接运行的伪代码记 `ai_code`（`codeKind="pseudo_complete"`）；骨架/方向性伪代码仍记 `design`。理由见 §5.1 细则 4 |
| Q3 | 实验子目录命名 | **按推荐** `<workspace>/experiments/<assignmentId>/` |
| Q4 | 自由模式「3 次后给完整代码」的计数范围 | **按推荐**：同一会话累计，切换模式/新建任务清零 |
| Q5 | 实验模式是否也允许「多次要求后给完整代码」 | **按推荐**：不给完整实现；第 4 次起可给**伪代码**（完整逻辑记 `ai_code`） |
| Q6 | 历史数据是否重算 | **按推荐**：不重算，`metrics_schema='legacy'`，趋势图从切换点起新口径 |
| Q7 | 是否保留 `queryType` | **按推荐**：保留并按 `behaviorType` 映射 |
| Q8 | 干预文案是否仍由模型撰写 | **按推荐**：保留契约 + 模板兜底，只删阻断类型 |

---

## 附录 A：本次勘察的关键文件索引

| 主题 | 文件 |
|---|---|
| 周数 | `package.json:445-451`、`WikiWeekSelector.tsx`、`weekStateFile.ts`、`weekStatePath.ts`、`WikiMcpRegistrar.ts:54-78,238-247` |
| 检索 | `LLMWikiService.ts:188-260,329-378`、`wikiPrompt.ts:19-81`、`mcp-wiki-server.ts:31-88`、`wikiBackend.ts:45-56`、`teaching-server/src/wikiSearch.ts`+`server.ts:611-640` |
| 模式/任务 | `AssignmentTab.tsx:561-597,819-913,923-956`、`AssignmentManager.ts:1145-1386`、`FeedbackPanelProvider.ts`、`ThinkingQuestionsPanelProvider.ts` |
| 日志 | `StudentLogPersister.ts`、`task/index.ts:1054-1059,1297-1570`、`types.ts:77-148`、`RunTraceCollector.ts:22-38` |
| 干预 | `BehaviorMonitor.ts:38-73,380-590`、`TeachingInterventionManager.ts:43-44,82-166,290-387`、`rulePolicy.ts`、`InterventionMessageGenerator.ts:347-430`、`task/index.ts:3393-3452` |
| 指标 | `backend/src/analytics.js:106-192,257-443,460-519`、`teaching-server/src/server.ts:228-272`、`submission/metrics.ts:30-53`、`frontend/App.jsx:304-646`、`StudentReport.tsx:374-385` |

---

## 12. 实施记录（P1/P2，2026-10-24）

本节记录设计落地后的实际实现与偏差；数据来自最终闸门（命令 + 结果），与计划 §13 对应。

### 12.1 实现范围

- **P1**：会话模式（free / experiment）判定、实验子工作区、任务详情面板 + 附件正文、GUIDE 生成/校验/模板兜底、教学上下文装配（guide → attachments → template → recall，总预算 6000）、自由模式 3 次放行阶梯（计数持久化）。
- **P2**：六类行为分类（含 `pseudo_complete`）、行为加权依赖度指标 spec（三端镜像）、删除阻断 + 六条软提示、提交包 meta 透传、迁移 v3、报告/看板统一口径、全流程 E2E 脚本。

### 12.2 关键实现决定

1. 需求计数落盘 `<globalStorage>/tasks/<taskId>/teaching-demand.json`，未使用任务 `initialState`（state-keys 注册表不在 P1 写入范围）：按 taskId 隔离天然实现「新任务清零」，resume 时 load 恢复，mode 不匹配清零。
2. free 模式仍运行 `BehaviorMonitor`（纯被动），但干预注入与追问全部门控：保留概念护栏，避免自由模式完全失护。
3. 实验模式不注入教材 wiki 索引，只注入 GUIDE / 附件 / 模板 / recall。
4. 删除阻断后 `severity` 恒 `"gentle"`，`hint | question` 归 `InterventionStyle`（计划措辞不严格处按此实现）；历史日志的 `"blocking_template"` 字面量仅为读兼容保留（`noBlocking` ⑥ 守护，防误删）。
5. 三端指标：`ai_dependency` 别名保留但值 = `depIndex`；`codeEditRate` → `selfCodingRatio` 保留一版别名；前端同时接受 `behavior-weighted/v1` 与设计稿旧名 `weighted-v1`。
6. `guidanceEffect` 严格按契约 `round6(1 - ai_code / demands)`，`GUIDANCE_WINDOW_TURNS` 仅作为导出常量，不参与窗口筛选（契约 §2 无窗口项）。
7. 窗口距离 0（同 `turnIndex`、数组位置靠后）**计入**；`turnIndex` 倒退（差 < 0）不计入，三端一致。
8. 迁移 v3 只对 `metrics_schema IS NULL` 的历史行标 `'legacy'`（不覆写新口径）；`user_version` 最后推进，失败保持旧值。

### 12.3 最终闸门（2026-10-24 全部通过）

| 仓库 | 命令 | 结果 |
|---|---|---|
| cline | `npx tsc --noEmit` | exit 0 |
| cline/webview-ui | `npx tsc --noEmit` | exit 0 |
| cline | `npx mocha`（TS_NODE_PROJECT=./tsconfig.unit-test.json） | **1508 passing / 111 pending / 0 failing** |
| cline | `node esbuild.mjs` | ✓ |
| cline/webview-ui | `npm run build` | ✓ |
| cline | `node scripts/verify/mcp-wiki-server.mjs` | 17/17 |
| cline | `node scripts/verify/wiki-recall.mjs` | 14/14 |
| web/teaching-server | `npx tsc --noEmit` | 仅 11 条基线错误（无新增） |
| web/teaching-server | `npx tsx scripts/check-metrics-spec.ts` | **196/0** |
| web/teaching-server | `npx tsx scripts/check-submission-migration.ts` | **87/0** |
| web/teaching-server | `node scripts/contract-check.mjs` | **78/78** |
| web/teaching-server | `npx tsx scripts/check-dashboard-events.ts` | 30/30 |
| web/teaching-server | `npx tsx scripts/check-wiki-search.ts` | 37/37 |
| web/teaching-server | `node scripts/check-wiki-routes.mjs` | 26/26 |
| web/teaching-server | `npx tsx scripts/check-attachment-text.ts` | 29/29 |
| web/teaching-server | `node scripts/check-teaching-flow.mjs` | 末行 `总计 299 项断言：通过 299，失败 0` |
| web/backend | `node scripts/check-dashboard-source.mjs` | **131/0** |
| web/backend | `node scripts/check-bundles.mjs` | 37 passed / 0 failed |
| web/frontend | `npm run build` | ✓ |

### 12.4 已知限制与遗留风险

1. `adoption_infer` 与 CodeEditTracker 的 `code_edit` / `file_save` 事件 `turnIndex` 均写 `-1`；按契约「双方有限数才用 turnIndex 差」，距离恒为 0 → `adoptionDeepening` 退化为「adopted 后存在任意 self_code」（三端字面一致，语义偏宽）。建议后续写入端改真实 `turnIndex`，或三端统一「负值视为缺失」。
2. `run_trace` 只写 `.cline-logs/run_traces.jsonl`，未合并进 `student_interactions.log` → 合并前 `errorResolutionRate` 恒 `null`；`hasRecentError` 暂未接入分类器。
3. 真实库 `teaching_system.db` 仍是 v2；下次启动 server 自动迁 v3（10 行标 `legacy`），已备份 `teaching_system.db.pre-v3.bak`（sha256 `7bf86380…`）。
4. 走 legacy `POST /api/v1/submissions` 的新行 `metrics_schema` 保持 `NULL`（报告层映射 `"legacy"`），与新版 `POST /api/v1/bundles` 行为不同。
5. 前端无 TypeScript 类型检查，仅 `lint + build` 兜底。
6. 看板 `filterByDays` 用 `ts || 0`，缺 `ts` 的事件不进 days 窗口（不影响指标口径）。
7. 手工验收 M-70~M-79 需人工在 VS Code / 浏览器确认（DoD 第 4 条）。

### 12.5 新增文件索引（实施期）

- cline：`src/core/teaching/{TeachingContext,TeachingSessionMode,ExperimentWorkspace,experimentGuide,assignmentDetail}.ts`、`src/core/teaching/submission/attachmentText.ts`、`src/core/teaching/behavior/{metricsSpec,behaviorClassify}.ts`、`src/hosts/vscode/AssignmentDetailPanelProvider.ts`、`webview-ui/src/components/teaching/AssignmentDetailForm.tsx`、`scripts/verify/{mcp-wiki-server,wiki-recall}.mjs`。
- web-dashboard：`teaching-server/src/submission/metricsSpec.ts`、`backend/src/metricsSpec.js`、`teaching-server/scripts/{check-metrics-spec.ts,check-teaching-flow.mjs,check-wiki-search.ts,check-wiki-routes.mjs,check-attachment-text.ts}`。
- 文档：`docs/design/metrics-spec.md`（三端镜像契约）、`docs/design/teaching-modes-and-behavior-metrics-{design,plan}.md`、`docs/manual-test-plan.md` §8。
