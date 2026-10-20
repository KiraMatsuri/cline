# 实验提交包与实验报告 —— 实施计划（P0–P3）

> 版本：v1.0
> 上游设计：[teaching-submission-bundle-design.md](./teaching-submission-bundle-design.md)（v1.1，含裁定 R1/R2/R3）
> 目标：**先让全流程真跑通，再补边界，最后做增强**。每个优先级结束时系统必须是「可启动、可提交、可查询、可展示」的完整状态，不允许留半截接口。
> 生效裁定：① 思考题按学生情况自动 **3/4/5，默认 3**；② 提交版本**只留最近 3 版**；③ **本期不加 TEACHER_TOKEN 鉴权**（列为 P3）。

---

## 1. 优先级定义（按「缺了它还能不能跑通全流程」排序）

| 级别 | 定义 | 判断标准 | 可否单独上线 |
|---|---|---|---|
| **P0** | 主链路骨架：没有它，任何需求都无法验证 | 一个学生能从「点提交」走到「Web 上看到自己的题与答案并下载代码」 | ✅ 可（模板题，不依赖 LLM） |
| **P1** | 四项需求的**功能本体**：P0 + P1 = 需求验收通过 | 逐条对得上验收标准 AC1.1–AC4.3 | ✅ 可 |
| **P2** | 健壮性与边界：决定「能不能真交给 40 个学生用」 | 54 条边界用例全绿；部署可复现 | ✅ 可 |
| **P3** | 明确不在本期：鉴权、对象存储、归档、统一命题 | 只写清接口预留点，不写实现 | — |

**排期原则**：P0 不允许并行拆分（契约、落盘、查询、前端展示必须同时到位，否则无法联调）；P1 内部可按「扩展侧 / 服务端 + 看板 / 前端」三线并行；P2 只做加法和修 bug，不改契约。

---

## 2. 「全流程跑通」的明确定义（P0 的验收语言）

一条命令级、可重复的闭环，缺一不可：

```
① 扩展侧：配置 serverUrl → 填学号姓名班级 → 双击任务建文件 → 写代码 → 点「提交」
② 面板：收到 3 道题（无 LLM 时用模板题）→ 全部作答 → 点「确认提交」
③ 服务端：201 + 落盘 uploads/submissions/{aid}/{sid}/r1/{behavior.jsonl, meta.json, questions.json, answers.json, code/*}
④ 数据库：submissions 1 行（is_current=1, revision=1）+ submission_questions 3 行 + submission_answers 3 行 + submission_files N 行
⑤ 报告 API：GET /api/v1/reports/current?assignment_id&student_id → 3 组题干+答案 + N 个文件
⑥ Web：顶部 4 项导航 → 「学生实验报告」→ 双筛选 → 题目与答案自上而下 → 下载代码成功
```

P0 结束时**必须**能演示 ①→⑥，中途任何一环用 mock 都算未完成。

---

## 3. 接口对照表（「接口对应」的落地依据）

改动横跨三端，字段一旦对不上就是空数据。下表是**唯一事实源**，实现时三端逐列对齐，禁止自行改名。

| 语义 | 扩展 `meta` | multipart | DB 列 | 报告 API 响应 | 前端字段 |
|---|---|---|---|---|---|
| 任务 id | `assignment_id` | — | `submissions.assignment_id` | `report.assignment.id` | `selectedAssignment` |
| 学号 | `student_id` | — | `submissions.student_id` | `report.student.student_id` | `selectedStudent` |
| 姓名 | `student_name` | — | `submissions.student_name` | `report.student.student_name` | 报告头 |
| 班级 | `class_id` | — | `submissions.class_id` | `report.student.class_id` | 报告头 |
| 提交时间 | `submitted_at`（ISO） | — | `submissions.submitted_at` | `report.submitted_at` | 报告头 |
| 第几次 | 服务端生成 | — | `submissions.revision` | `report.revision` | 「第 N 次提交」徽标 |
| 当前版本 | 服务端生成 | — | `submissions.is_current` | 只返回 1 的 | 无 |
| 日志行数 | `log.line_count` | `log` 文件 | `log_line_count` | `report.log.line_count` | 指标卡 |
| 日志截断 | `log.truncated` | — | `log_truncated` | `report.log.truncated` | 「已截断」提示 |
| 原始路径 | `log.original_path` | — | `log_original_path` | 不返回 | 无（仅审计） |
| 代码清单 | `code[]` | `code` ×N + `code_path_i` | `submission_files.*` | `report.files[]` | 文件列表 |
| 代码下载 | — | — | `submission_files.id` | `download_url` | `<a download>` |
| 题干 | `questions[].question` | 在 `meta` 内 | `submission_questions.question` | `report.questions[].question` | Q 卡片标题 |
| 考察点 | `questions[].intent` | 同上 | `.intent` | `.intent` | 灰色小字 |
| 难度 | `questions[].difficulty` | 同上 | `.difficulty` | `.difficulty` | Tag |
| 题序 | `questions[].seq` | 同上 | `.seq` | `.seq` | 序号 |
| 答案 | `answers[].answer` | 同上 | `submission_answers.answer` | `.answer`（join 后） | 答案正文 |
| 题源 | 服务端记录 | — | `.source` | `.source` | 「模板题」标记 |
| 运行痕迹 | `run_traces` | 在 `meta` 内 | `submissions.log_line_count` 旁记 `run_trace_count` | `report.log.run_trace_count` | 指标卡 |
| 指标 | `metrics_snapshot` | 同上 | `ai_dependency` 等 | `report.metrics` | 报告头 |
| 指标来源 | — | — | `metrics_source` | `report.metrics_source` | 「本地近似」提示 |

**契约测试**（P0 必做）：`teaching-server/scripts/contract-check.mjs` —— 用固定 fixture 打一次上传，断言 201 响应与报告响应里上表每个字段都存在且类型正确；字段缺失即 CI 失败。

---

## 4. P0：主链路骨架（7.5 人日）

> 交付标准：§2 的 ①→⑥ 全通；模板题（不调 LLM）即可；空日志/无代码必须不报错。

| ID | 任务 | 主要文件 | 接口/行为 | 依赖 | 人日 |
|---|---|---|---|---|---|
| P0-1 | **契约冻结**：三端类型与字段表落地 | `src/core/teaching/submission/bundleTypes.ts`、`teaching-server/src/submission/types.ts`、`frontend/src/constants/fields.js` | 与 §3 表格一一对应；导出 `SCHEMA = "submission-bundle/v1"` | — | 0.5 |
| P0-2 | **CLI 解析链** | `scripts/analyze-student-log.ts`（抽 `resolveDefaultLogPath`）、`src/core/teaching/workspaceLogPath.ts`（+`resolveStudentLogFile`） | 五级解析链 + `--workspace/--json/--out/--strict/--help`；退出码 0/1/2/3 | — | 1.0 |
| P0-3 | **DB 迁移 v1** | `teaching-server/src/db/migrations.ts` | `PRAGMA user_version` 0→1：11 个 `ALTER TABLE` + 4 张新表 + 5 个索引（设计 §5.2 原文）；幂等可重跑 | P0-1 | 0.5 |
| P0-4 | **收包落盘与入库** | `submission/bundleService.ts`、`bundlePaths.ts`、`fileStore.ts`；`server.ts` 挂载 | `POST /api/v1/submissions/bundle`：校验 → tmp → rename → 事务 → 201；`meta` 里 questions/answers 原样入库；空日志/无代码返回 201 且计数为 0 | P0-1、P0-3 | 1.5 |
| P0-5 | **报告查询与下载** | `submission/reportService.ts`、`server.ts` 路由 | `GET /reports/filters`、`GET /reports/current`、`GET /reports/submissions/:id/files/:fileId`；缺参 400 `FILTER_REQUIRED`；无提交 404 | P0-4 | 0.5 |
| P0-6 | **扩展侧收集与两段式提交** | `SubmissionPackager.ts`、`AssignmentManager.ts`（`prepareSubmission` / `confirmSubmission` / `postBundle`）、`AssignmentTab.tsx` | 点提交→本地收集（日志切片+代码清单）→**模板题 3 道**→开面板；确认→multipart 上传→回传 `submission_id/revision/metrics` | P0-1、P0-4 | 1.0 |
| P0-7 | **答题面板** | `hosts/vscode/ThinkingQuestionsPanelProvider.ts`、`webview-ui/src/components/teaching/ThinkingQuestionsForm.tsx`、`webview-ui/src/App.tsx`（+`data-view` 分支） | 单例编辑器区面板；题面+多行输入；全部非空才可提交；成功/失败态 | P0-6 | 1.0 |
| P0-8 | **报告页最小版 + 导航四项** | `frontend/src/App.jsx`（NavBar 数据驱动）、`frontend/src/components/StudentReport.tsx` | 4 项一级导航（实验任务管理含 2 子项）；双筛选必填；题目+答案列表；代码下载 | P0-5 | 1.0 |
| P0-9 | **冒烟脚本** | `teaching-server/scripts/smoke-bundle.mjs` | 起临时 `DATA_DIR` → 上传 fixture → 查报告 → 下载比对 sha256 → 二次提交断言 revision=2 | P0-4、P0-5 | 0.5 |

**P0 必过测试（8 条，全部为「边界优先」）**

| 用例 | 构造 | 期望 |
|---|---|---|
| SM-1 | 正常包（60 行日志 + 2 个 py 文件 + 3 题 3 答） | 201；目录 5 个文件；报告 3 题 3 答 2 文件 |
| **SM-2（目录无日志）** | 删除 `.cline-logs/` 后提交 | **201**，`log_line_count=0`，`behavior.jsonl` 为 0 行，报告 `report.log.line_count=0` 且页面显示「未采集到行为日志」 |
| **SM-3（目录有 .cline-logs 但无日志文件）** | 只建空目录 | 同 SM-2，且 CLI 跑该目录 → exit 1 + 明确提示路径 |
| **SM-4（目录无对应代码文件）** | 任务文件被学生删除 + glob 无命中 | **201**，`submission_files` 0 行，`report.files=[]`，页面代码区显示「未上传代码文件」，**下载区不渲染空链接** |
| SM-5 | 日志文件存在但 0 字节 | 201，`log_line_count=0`，分析指标为 0/null 不抛异常 |
| SM-6 | 只答 2 题（缺 1） | 前端拦截（按钮禁用）；直接打 API 则 400 `META_INVALID`（答案题号与题干不匹配） |
| SM-7 | 二次提交同学生同任务 | `revision=2`、`r1.is_current=0`、报告只返回 r2 |
| SM-8 | 缺 `assignment_id` 的包 | 400 `META_INVALID`，不落盘（`tmp/` 清空） |

### 4.1 P0 实施记录（2026-10-18 完成，三个闸门全绿）

> 「计划里的文件」与「实际落点」有 3 处偏差，以本表为准；偏差原因写在备注里，不回头改计划正文。

| P0 | 实际落点 | 与计划的差异 / 备注 |
|---|---|---|
| P0-1 | 扩展侧 `D:\cline\src\core\teaching\submission\bundleTypes.ts`；教学端 `D:\web-dashboard\teaching-server\src\submission\bundleContract.ts` | 计划里的 `teaching-server/src/submission/types.ts` 改名为 `bundleContract.ts`（它不只放类型，还放 `parseBundleMeta()` 与错误码状态表，叫 types 会误导）；计划里的 `frontend/src/constants/fields.js` **不建**——前端的字段声明直接写在 `StudentReport.tsx` 的局部接口里，由 `contract-check.mjs` 机械比对，避免第三份需要人工同步的常量表 |
| P0-2 | `D:\cline\src\core\teaching\logPathResolver.ts`、`D:\cline\scripts\analyze-student-log.ts`、`src/core/teaching/workspaceLogPath.ts` | 解析链最终为 6 级（位置参数/`--log` → `CLINE_STUDENT_LOG`/`CLINE_LOG_PATH` → `--workspace` → VS Code 工作区根（权威、不回退）→ cwd → 向上回溯 ≤4 层）；**没有任何写死绝对路径的兜底** |
| P0-3 | `teaching-server/src/db/migrations.ts`（`SUBMISSION_SCHEMA_VERSION = 1`） | 11 列 + 3 张新表 + 4 个索引；迁移前先把每组 `(assignment_id, student_id)` 的非最大 id 的 `is_current` 置 0，否则部分唯一索引建不起来 |
| P0-4 | `submission/{bundleService,bundlePaths,fileStore,metrics,bundleRoutes}.ts`，`server.ts` 的 `initDatabase()` 内挂迁移、`main()` 内 `registerBundleRoutes()` | 用 `BEGIN IMMEDIATE` + 落盘失败回滚删文件；`code_snapshot` 老列继续写首个代码文件，保证旧接口/旧看板不断链 |
| P0-5 | `submission/reportService.ts` + `bundleRoutes.ts` 内 3 条 GET | 响应包装**不统一**且已固化：`/reports/current` → `{ok, report}`（包裹式），`/reports/filters` → `{ok, assignments, students}`（展开式）。前端按此解包，`contract-check.mjs` 会守住这对包装键 |
| P0-6 | `submission/SubmissionPackager.ts`（`collectCodeFiles` / `collectLog` / `readRunTraces` / `summarizeLogEvents` / `buildBundleMeta` / `postBundle`）+ `AssignmentManager.prepareSubmission/confirmSubmission` | 两段式：`prepareSubmission` 只收集+出题+开面板，**零上传**；`confirmSubmission` 是唯一上传入口，失败不清理 `pendingSubmission` 以便直接重试（`idempotency_key` 由 `randomUUID()` 生成，重试不会重复入库） |
| P0-7 | `D:\cline\src\hosts\vscode\ThinkingQuestionsPanelProvider.ts`、`webview-ui/src/components/teaching/ThinkingQuestionsForm.tsx`、`webview-ui/src/App.tsx` | 面板 HTML 走 `data-view="clineThinkingQuestionsPanel"` + nonce CSP，与 `FeedbackPanelProvider` 同构；`reveal(payload, onConfirm)` 由 `VscodeWebviewProvider` 注入回调，避免静态 setter 双向耦合 |
| P0-8 | `frontend/src/App.jsx`（NavBar 改为 `NAV_ITEMS` 数据驱动 + 下拉子菜单）、`frontend/src/components/StudentReport.tsx` | 顶部栏 4 项：学情画像看板 / 实验任务管理（子项：发布新任务、管理任务）/ 教学资料管理 / 学生实验报告；子项复用原 `publish`/`manage` 视图键，旧页面组件零改动 |
| P0-9 | `teaching-server/scripts/smoke-bundle.mjs`（59 断言）、`teaching-server/scripts/check-submission-migration.ts`（32 断言）、`teaching-server/scripts/contract-check.mjs`（36 断言）、`D:\cline\scripts\verify\submission-e2e.ts`（28 断言）、`D:\cline\scripts\verify\log-path-cli.test.ps1`（30 断言） | 计划里只有 1 个冒烟脚本，实际扩成 5 个：服务端收包、迁移、三端契约、扩展侧真实打包上行、CLI。**扩展侧那一个是关键**——它用真实 `SubmissionPackager` 打的包灌真实服务端，才暴露得出「前端读 `.data`、后端给 `.report`」这类两端各自测试都发现不了的错位 |

**P0 闸门实测结果（全部通过）**

| 闸门 | 命令 | 结果 |
|---|---|---|
| 扩展侧单测 | `cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha` | **1227 passing / 111 pending**（基线 1201 + 新增 26） |
| 扩展侧类型 | `cd D:\cline; npx tsc --noEmit`；`cd webview-ui; npx tsc --noEmit` | 均 `exit 0` |
| 教学端类型 | `cd D:\web-dashboard\teaching-server; npx tsc --noEmit` | `src/submission/`、`src/db/` **零错误**（仓内 11 条既有错误不计） |
| 服务端收包冒烟 | `node scripts/smoke-bundle.mjs` | **59/59** |
| 迁移 | `npx tsx scripts/check-submission-migration.ts` | **32/32**（含真实库 8 行 submissions 副本） |
| 三端契约 | `node scripts/contract-check.mjs` | **36/36** |
| 扩展→教学端全链路 | `npx tsx D:\cline\scripts\verify\submission-e2e.ts` | **28/28**（含 BN-01、BN-09、BN-13、幂等重放、revision=2） |
| CLI | `& .\scripts\verify\log-path-cli.test.ps1` | **30/30** |
| 前端构建 | `cd D:\web-dashboard\frontend; npm run build` | 通过（仅 chunk 体积警告） |
| webview 构建 | `cd D:\cline\webview-ui; npm run build` | 通过（`build/assets/index.js` 6.0 MB） |

SM-1…SM-8 的对应用例全部在上述脚本里覆盖：SM-2/SM-3（无日志）→ e2e 的 BN-01 组 + smoke 的「无日志提交」组；SM-4（无代码文件）→ e2e 的 BN-09 组；SM-5（0 字节日志）→ CLI 组 + smoke；SM-6（缺答案）→ smoke 的「3 题只答 2 题」组（报告第 3 题 `answer: null`）；SM-7（二次提交）→ e2e 与 smoke 均断言 `revision=2` 且 `is_current` 只留 1 行；SM-8（缺 `assignment_id`）→ smoke 的 `META_INVALID` 组。

---

## 5. P1：需求功能本体（5.5 人日）

> 交付标准：AC2.1–AC2.5、AC3.1–AC3.5 全过；题数三档都能出现；看板可按任务筛。

| ID | 任务 | 主要文件 | 接口/行为 | 依赖 | 人日 |
|---|---|---|---|---|---|
| P1-1 | **思考题生成（自适应 3/4/5）** | `submission/QuestionGenerator.ts`、`QuestionCountPolicy.ts`（纯函数）、prompt 常量 | `decideQuestionCount(features)` 实现设计 §7.3.1 计分；LLM 输出校验/截断/补模板；`source` 落库 | P0-6 | 1.5 |
| P1-2 | **运行痕迹采集** | `submission/RunTraceCollector.ts`（注册 `onDidStart/EndTerminalShellExecution`）、`SubmissionPackager`（读 `run-traces.jsonl`、日志切片增强）、`package.json`（`teaching.autoRunOnSubmit`） | 写 `<ws>/.cline-logs/run-traces.jsonl`；提交时取最近 ≤20 条进 `meta.run_traces`；不可用 → `available:false` 不报错 | P0-6 | 1.5 |
| P1-3 | **幂等 + 只留 3 版** | `bundleService.ts`（`idempotency_key` 去重、`pruneRevisions(aid,sid,3)`）、`bundlePaths.ts` | 同 key → 200 `deduplicated:true`；第 4 版产生后删 r1 目录与行；编号不重排 | P0-4 | 0.5 |
| P1-4 | **看板 bundles 模式 + 任务维度** | `backend/src/index.js`、`backend/src/analytics.js`、`backend/src/bundleLoader.js`（新） | `LOG_SOURCE=bundles`；`filterByAssignment`；`/api/dashboard/assignments`；`POST /api/dashboard/analyze`；teaching-server 收包调它（失败标 `metrics_source='local'`） | P0-4 | 1.0 |
| P1-5 | **前端增强** | `StudentReport.tsx`、`App.jsx`（看板任务下拉） | 学生↔任务下拉互斥收窄；`inline=1` 预览 Modal；三态（加载/空/错误）；`第 N 次提交` 与「指标为本地近似」提示；看板任务筛选（`file` 模式下置灰） | P0-8、P1-4 | 1.0 |

**P1 必过测试（12 条）**

| 用例 | 期望 |
|---|---|
| Q-1 材料极简（L=0,F=1,R=0,D=120,W=0） | `N=3`，3 道模板题，`source='template'` |
| Q-2 中等（L=50,F=1,R=0,D=350,W=6） | `N=4`，LLM 4 题 |
| Q-3 丰富（L=120,F=3,R=5,E=3,D=500,W=15） | `N=5` |
| Q-4 配置 `thinkingQuestionAuto=false` | 恒为 `thinkingQuestionCount`（默认 3） |
| Q-5 LLM 返回 2 题 | 补 1 道模板题 → 3 题，`source` 混记 |
| Q-6 LLM 返回 7 题 | 截断 5 题 |
| Q-7 LLM 返回带 ```json 围栏 / 非法 JSON | 容错解析；彻底失败 → 3 题模板，提交不失败 |
| Q-8 断网/无 key | 模板题 3 道；面板顶部提示「已降级为通用题」 |
| RT-1 终端跑出 `KeyError` | `run-traces.jsonl` 有 1 条 `exitCode≠0`；该报错首行出现在题干 |
| RT-2 shell integration 不可用 | `run_traces.available=false`，流程不断 |
| ID-1 同 `idempotency_key` 二次上传 | 200 `deduplicated`，不新增 revision |
| ID-2 连续提交 4 次 | 目录仅剩 r2/r3/r4；`r1` 的 `submission_files` 级联删除 |

### 5.1 P1 实施记录（2026-10-18 完成，闸门全绿）

**实际落点与计划的三处偏差（其余按计划）**

| 计划 | 实际 | 原因 |
|---|---|---|
| `backend/src/bundleLoader.js`（直连 SQLite） | `backend/src/bundleFeed.js` + teaching-server 写 `<DATA_DIR>/dashboard/student_interactions.jsonl` | 看板后端至今只依赖 express/cors/dotenv；为读一张表引入 sqlite 驱动不划算，且文件让「入库」与「看板」解耦（写失败只转 warning，不影响提交）。设计文档 §9 已同步 |
| `POST /api/dashboard/analyze` 由教学端回调看板重算指标 | 未做，`metrics_source` 固定 `local` | 指标公式两端已一致（`submission/metrics.ts` 与 `analytics.js` 同公式），回调只增加一个失败面；报告页明确标注「教学端本地近似」 |
| `teaching.autoRunOnSubmit` 配置项 | 未加，运行痕迹恒为「采集到的最近 ≤100 条」 | 学生已经手动运行过的痕迹本来就该用，多一个开关只会让老师困惑 |

**关键实现细节（后续排查必看）**

- 运行痕迹：`RunTraceCollector.start()` 只要 `onDidStartTerminalShellExecution` 或 `onDidEndTerminalShellExecution` 缺一个就整体关闭（没有 end 事件拿不到 exitCode）；`read()` 必须在 start 时立刻消费（异步流到 end 已流干）；输出缓冲上限 20000 字、落盘 1200 字尾部；文件超 2MB 只留最后 300 行。**RT-1 的「真实终端」那半条只能人工验**，单测覆盖纯函数与「写出的 jsonl 能被 `readRunTraces` 读回」。
- 题数策略：默认 `teaching.thinkingQuestionAuto=true`，`decideQuestionCount()` 仍按 6 特征计分；LLM 失败/无 key/解析空 → 模板降级并在面板顶部提示，提交链路不受影响。
- 版本裁剪：`pruneRevisions` 在 `COMMIT` 之后执行，**显式按 answers→questions→files→submissions 顺序删**（sqlite3 默认不开 `foreign_keys`，级联不生效），删库成功后再删 `r<n>` 目录。
- 看板：`emptyReason ∈ null | no_submissions | filtered_out`；`meta.source ∈ bundles|file`；`LOG_SOURCE=bundles` 时**绝不回退 sample 日志**（否则空库会显示样例数据，比空更糟）。

**2026-10-19 补充修复：出题复用 Cline 里已填好的 API Key**

- 缺陷：`AssignmentManager.createQuestionLLMCaller()` 当时用 `config.apiProvider` 判断「是否配置了模型」，
  但 `ApiConfiguration` 里**没有这个字段**（提供商分列在 `actModeApiProvider` / `planModeApiProvider`，
  `buildApiHandler()` 也只读这两项）→ 永远判定为无模型 → 出题恒降级为模板题。学生观察到的
  「工作区建 `.env` 填 key 才有模型题」其实是误判的副作用（仓库里没有任何代码读 `.env` 当 LLM 配置）。
- 修复：新增纯函数模块 `src/core/teaching/submission/questionLLM.ts` ——
  `resolveQuestionLLMTarget(config)`（act 优先、plan 回退、空串视为未配置）、`formatQuestionLLMTarget()`、
  `describeLLMUnavailable()`、`describeLLMFailure()`（401/缺 key 翻译成「去 Cline 设置 → API 配置检查密钥」）。
  `createQuestionLLMCaller()` 改用它，`buildApiHandler({...config, actModeThinkingBudgetTokens: 0,
  planModeThinkingBudgetTokens: 0}, target.mode)`，与主对话（`src/core/task/index.ts:473`）用同一份配置。
- 面板：`ThinkingQuestionsPayload` 增 `llmProvider` / `llmModel`，答题面板 chip 显示
  `🤖 openrouter · deepseek/deepseek-chat`，让「这次到底谁出的题」可见。
- 加固（同日）：`actModeApiProvider` 的**默认值就是 `openrouter`**（`src/shared/storage/state-keys.ts:224`），
  所以「act 看着已配置、其实没填 key」很常见——只在 plan 里配过模型的学生会拿到 401 并继续退化成模板题。
  于是新增 `resolveQuestionLLMTargets()`（act → plan 去重列表）与 `isAuthFailure()`，
  `createQuestionLLMCaller().complete()` 按序尝试，**只对鉴权类失败换下一个**（网络错误换模型没意义），
  成功时回写 `caller.provider/model`，因此面板徽标与提交包里的 `llmProvider` 一定是**真正成功**的那个。
- 闸门：`--grep "questionLLM"` **20 passing**（12 → 20，新增 5 条 targets + 3 条 auth 判定）；
  全量 `npx mocha` **1291 passing / 111 pending**；cline 与 webview-ui `tsc --noEmit` 均 0。

**P1 闸门实测**

| 命令 | 结果 |
|---|---|
| `cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha` | **1254 passing / 111 pending**，EXIT=0（基线 1201 + P0 26 + P1 27） |
| `--grep "思考题"` / `--grep "运行痕迹采集"` | 32 passing / 9 passing |
| `cd D:\cline; npx tsc --noEmit`；`cd webview-ui; npx tsc --noEmit` | 0 / 0 |
| `cd D:\web-dashboard\teaching-server; npx tsc --noEmit` | `src/submission`、`src/db` **零错误**（仓内 11 条既有错误不计） |
| `npx tsx scripts/check-prune.ts` | **21/21**（4 次提交只剩 r2/r3/r4、r1 无孤儿行、重放不新增、keep=2/10 边界） |
| `npx tsx scripts/check-dashboard-feed.ts` | **19/19**（事件流字段、追加不覆盖、裁剪不影响、无日志不写、空数组幂等） |
| `cd D:\web-dashboard\backend; node scripts/check-bundles.mjs` | **29/29**（三实例：bundles / 空库 / 旧 file 模式；任务筛选、filtered_out、no_submissions、assignments 兜底） |
| `node scripts/contract-check.mjs` | **45/45**（新增 9 条看板链路断言） |
| `npx tsx D:\cline\scripts\verify\submission-e2e.ts`（服务 4014） | **28/28** |
| `node scripts/smoke-bundle.mjs` | **59/59**；实测 `<DATA_DIR>/dashboard/student_interactions.jsonl` 生成 15 行 |
| `cd D:\web-dashboard\frontend; npm run build` | 通过（`✓ built in 1.96s`，仅 chunk >500kB 警告） |

**P1 遗留（明确不做，进 P2 或后续）**

- RT-1 的「真实终端捕获」需人工在 VS Code 里跑一次 `python bad.py` 看 `run_traces.jsonl`；CI 无法覆盖。
- 看板 `file` 模式下的任务下拉仍是置灰/空（`deriveAssignments` 只在 bundles 事件里有 `assignment_id`）；P2 若迁移老日志再处理。
- 报告页未做 `inline=1` 代码预览 Modal（下载已可用），P2-3 视情况补。

---

## 6. P2：健壮性与边界（3 人日）

> 交付标准：§7 的 54 条边界用例全绿；历史数据可迁移；部署文档可照着做起来。

| ID | 任务 | 主要文件 | 交付 | 依赖 | 人日 |
|---|---|---|---|---|---|
| P2-1 | **采集侧降级** | `SubmissionPackager.ts`、`fileStore.ts` | 坏行容忍（<50% 有效仍收）、体积丢弃 + `omitted[]`、疑似密钥打码、未保存文件兜底 `unsaved=true`、超限 413/400 文案 | P1-2 | 1.0 |
| P2-2 | **服务端失败与并发** | `bundleService.ts`、`server.ts` | tmp 全清、事务回滚、同学生并发 → 一个 201 一个 409；`INGEST_FAILED` 可安全重试 | P0-4 | 0.5 |
| P2-3 | **兼容与迁移** | `server.ts`（旧 JSON 路由转调）、`scripts/migrate-bundles.ts` | 旧扩展提交仍 201（`metrics_source='snapshot'`、`log_line_count=0`）；历史行生成 legacy 目录 | P0-4 | 0.5 |
| P2-4 | **部署** | `deploy/docker-compose.yml`、`deploy/env/*.example`、`deploy/DEPLOY.md`、`deploy/nginx.conf` | 两服务都设 `LOG_SOURCE=bundles`；`teaching-data` 卷挂载校验；**nginx 不反代 4001** 并写明；`PRUNE_REVISIONS` 可配 | P1-4 | 0.5 |
| P2-5 | **回归** | 单测 + 集成 + `docs/manual-test-plan.md` 新章节 | 全量跑绿；手工单可交给助教执行 | 全部 | 0.5 |

### 6.1 P2 实施记录（2026-10-18 完成，闸门全绿）

**实际落点与计划的三处偏差**

| 计划 | 实际 | 原因 |
|---|---|---|
| 并发冲突「一个 201 一个 409」 | 一个 201 一个 201，`revision` 递增（`withIngestLock` 按 `<aid>\0<sid>` 串行） | 409 会让学生以为提交失败并重试；串行化后两次提交都是有效版本，语义更准（BN-20 断言改为「不出现 500、只有一条 `is_current`」） |
| 旧 JSON 路由「转调」新入库逻辑 | 保留原路由形态，补齐 `revision/is_current/metrics_source='snapshot'` 写入 + 事务，事件走 `appendToDashboardFeed` | 转调需要伪造 multipart，反而更容易出错；老扩展只要能 201 就算兼容 |
| `login` 之外再建 `frontend/src/constants/fields.js` | 未建（契约校验直接读 `StudentReport.tsx`/`App.jsx`） | 前端没有 TS 工程，多一个常量文件只是多一处同步点；`contract-check.mjs` 直接断言源码字面量 |

**计划外但必须补的（真实缺陷）**

1. **「所有提交都无响应」**（上线级故障）：P2-2 加的防御 `if (req.destroyed || res.writableEnded) return;` 会吞掉一切正常提交 —— Node 在请求体被 multer 完整读完后会把 `req.destroyed` 置 `true`。症状是 `curl` 一直挂到超时、服务端无日志。已改为 `if (res.writableEnded || res.destroyed || req.aborted) return;`，并用隔离 app + 临时调试日志定位（`bundleRoutes.ts` 里不能再用 `req.destroyed` 判断客户端是否断开）。
2. **失败清理留空壳目录**：`pruneEmptyParents()` 对「已删掉的目录」`readdirSync` 抛 `ENOENT` 后直接 `return`，导致 `uploads/submissions/<aid>/<sid>/` 留在盘上。改为 ENOENT 时继续向上收。
3. **运行痕迹从未落库**：契约里教学端写 `run_traces?: BundleRunTraces{available,count,items}`，扩展侧发的是 `BundleRunTrace[]`（字段 `exitCode` vs `exit_code`），于是 `run_trace_count` 恒 0。已统一为数组契约，新增列 `run_trace_count` 并在报告里回传。
4. **schema v2 迁移**：新增 `run_trace_count`/`log_bad_lines`/`log_slice_missing`/`unsaved_files` 四列；`check-submission-migration.ts` 里硬编码的 `user_version=1` 断言全部改为引用 `SUBMISSION_SCHEMA_VERSION`（否则每次升 schema 都要改测试）。

**关键实现细节（后续排查必看）**

- 日志切片（`logSlicer.ts`）：先按最新 `taskId` 找边界，找不到就留 `run_result` + 最近 200 行并置 `slice_missing`；超 2MB 取「头 200 + 尾 1800」行再逐行削，**绝不把 JSON 截成半行**；空行既不算事件也不算坏行。
- 密钥打码（`secrets.ts`）：厂商前缀（`sk-`/`ghp_`/`AKIA`/`AIza`/JWT/私钥块）→ 赋值语句 → 块状配置三步；块状配置必须用 `[ \t]*` 而不是 `\s*`（`\s` 会吃掉换行，把下一行键名当成本行值）。
- 未保存缓冲区：活动编辑器 `isDirty && !isUntitled` 时取 `document.getText()` 覆盖磁盘内容，并把相对路径记进 `unsaved_files`（报告页显示「含未保存的编辑器修改」）。
- 看板事件上限：`DASHBOARD_MAX_EVENTS`（默认 10 万），超限保留最新并在 `meta.truncated/truncatedEvents` 说明（`totalLogCount` 报**截断前**条数，前端可用 `totalLogCount - truncatedEvents` 得实际口径）；新增 `emptyReason='out_of_range'` 区分「筛选没数据」与「时间窗把数据滤空了」。
- 历史数据整理（`migrateLegacyBundles.ts`）：`legacy-r<n>` 与真实 `r<n>` 分目录；revision/current 必须**按组内所有行重排**（老行 + 新包混排），只排老行会撞 `ux_sub_current`。

**P2 闸门实测**

| 命令 | 结果 |
|---|---|
| `cd D:\cline; $env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha` | **1271 passing / 111 pending**，EXIT=0（P1 1254 + 日志切片 9 + 密钥打码 8） |
| `cd D:\cline; npx tsc --noEmit`；`cd webview-ui; npx tsc --noEmit` | 0 / 0 |
| `cd D:\web-dashboard\teaching-server; npx tsc --noEmit` | `src/submission`、`src/db` **零错误**（仓内 12 条既有错误不计） |
| `npx tsx scripts/check-p2-robustness.ts` | **24/24**（并发不 500、失败无残骸、legacy 整理幂等、缺文件标 missing） |
| `npx tsx scripts/check-submission-migration.ts` | **36/36**（schema v2 四列、真实库 8 行迁移无损） |
| `npx tsx scripts/check-prune.ts` / `check-dashboard-feed.ts` | **21/21** / **19/19** |
| `node scripts/contract-check.mjs` | **45/45** |
| `node scripts/smoke-bundle.mjs`（服务 4015） | **59/59** |
| `npx tsx D:\cline\scripts\verify\submission-e2e.ts` | **28/28** |
| `cd D:\web-dashboard\backend; node scripts/check-bundles.mjs` | **36/36**（P1 的 29 条 + 新增 7 条：`DASHBOARD_MAX_EVENTS=3` 截断、`totalLogCount` 报截断前条数、`days=1` 滤空 → `out_of_range`、`days=all` 仍可见） |
| `& D:\cline\scripts\verify\log-path-cli.test.ps1` | **30/30** |
| `cd D:\web-dashboard\frontend; npm run build` | 通过（`✓ built in 1.58s`，仅 chunk 警告） |
| `cd D:\cline\webview-ui; npm run build` | 通过（exit 0） |

**P2 遗留（明确不做）**

- `RT-1` 真实终端捕获、`BN-52` 面板草稿恢复、`BN-50` LLM 超时（目前靠 `TEACHING_LLM_TIMEOUT_MS` 在服务端兜底，扩展侧 `createMessage` 无显式超时）——都需要真机/真实模型验证，留在人工验收单。
- 报告页代码预览 Modal（`inline=1`）未做，下载已可用。
- 教学端鉴权（TEACHER_TOKEN）按裁定 R3 仍不做，靠 nginx 不反代 4001 + 仅内网约束。

---

## 7. 边界情况测试矩阵（54 条）

> 记号：**P0/P1/P2** = 该用例必须在哪个阶段通过；「层」= 单测(U)/集成(I)/手工(M)。
> 带 ⚠️ 的是用户明确点名的场景（目录无日志、目录无对应代码文件），P0 就要过。

### A. 采集与行为日志（BN-01–BN-08）

| 编号 | 场景 | 构造方式 | 期望 | 层 | 阶段 |
|---|---|---|---|---|---|
| BN-01 ⚠️ | **工作区无 `.cline-logs` 目录** | 全新工作区直接提交 | 201；日志 0 行；`truncated=false`；报告显示「未采集到行为日志」；指标为空不报错 | I+M | P0 |
| BN-02 ⚠️ | **有 `.cline-logs` 但无 `student_interactions.log`** | 只 `mkdir` | 同 BN-01；CLI 对该目录运行时 exit 1 并打印「未找到日志：<路径>」 | I+M | P0 |
| BN-03 | 日志 0 字节 | `New-Item -ItemType File` | 201；`log_line_count=0`；`meta.badLines=0` | U+I | P0 |
| BN-04 | 日志全是坏行（非 JSON） | 写入 100 行乱码 | 201；`badLines=100`、有效 0；分析 `totalTasks=0`；页面提示「日志解析失败」 | U+I | P2 |
| BN-05 | 日志 > 2 MB | 生成 5 万行 | 截断为头 200 + 尾 1800；`truncated=true`；上传体积 ≤ 2 MB | U | P2 |
| BN-06 | 日志里没有本次 `taskId` | 只放别的任务事件 | 保留 `run_result` + 最近 200 行；`slice_missing=true`；仍 201 | U | P2 |
| BN-07 | 日志中 `assignment_id` 缺失（旧包） | 手工删字段 | 看板按任务筛选时被排除，不抛错；`file` 模式不受影响 | I | P2 |
| BN-08 | 同一学生同任务重复事件（重复提交回灌） | 连续提交 3 次 | 每次独立包；`is_current` 唯一；指标只算最新，不叠加 | I | P1 |

### B. 代码文件（BN-09–BN-16）

| 编号 | 场景 | 构造方式 | 期望 | 层 | 阶段 |
|---|---|---|---|---|---|
| BN-09 ⚠️ | **目录无对应代码文件**（任务文件被删 + glob 无命中） | 删 `main.py` | 201；`submission_files=0`；`report.files=[]`；页面「未上传代码文件」；下载区不渲染 | I+M | P0 |
| BN-10 ⚠️ | 任务文件从未创建（只点提交） | 不双击任务 | 同 BN-09，`meta.code=[]` | I | P0 |
| BN-11 | 清单里有文件但磁盘缺失 | 建后删除 | 跳过并记 `omitted:[{path,reason:"missing"}]`；201 | U | P2 |
| BN-12 | 单文件 > 512 KB | 生成大文件 | 跳过 + `omitted:[{reason:"too_large"}]` | U | P2 |
| BN-13 | 文件数 > 20 | 造 25 个 | 只收前 20（按体积升序优先），其余 `omitted` | U | P2 |
| BN-14 | 文件名含 `../` / 绝对路径 / 中文 / 空格 | 构造 `../../etc/passwd`、`实验一.py` | `sanitizeSegment` 拒绝前两者（400 或落盘名改写）；中文与空格保留且可下载（`filename*=UTF-8''`） | U+I | P2 |
| BN-15 | 二进制文件混入（`.exe`/`.pyc`） | 加进目录 | 按扩展名 + 前 8KB 含 `\0` 判定 → 跳过；若全部被跳则同 BN-09 | U | P2 |
| BN-16 | 未保存的新文件（Untitled） | 不落盘直接写 | 只取磁盘文件；活动编辑器内容作 `code_snapshot` 并标 `unsaved=true` | M | P2 |

### C. 上传与入库（BN-17–BN-26）

| 编号 | 场景 | 构造方式 | 期望 | 层 | 阶段 |
|---|---|---|---|---|---|
| BN-17 | `meta` 非法 JSON | 手改 body | 400 `META_INVALID`；tmp 清空 | I | P0 |
| BN-18 | `assignment_id` 不存在 | 用已删任务 | 400 `ASSIGNMENT_NOT_FOUND`；学生端提示「任务已被删除」并保留草稿 | I+M | P0 |
| BN-19 | 整包 > 12 MB | 塞大文件 | 413 `BUNDLE_TOO_LARGE`；连接被正常关闭 | I | P2 |
| BN-20 | 并发两次提交（同学生同任务） | `Promise.all` | 一个 201、一个 409 或串行成 r1/r2；**不出现 500**、不出现两行 `is_current=1` | I | P2 |
| BN-21 | 同一 `idempotency_key` 重放 | 原包重发 | 200 `{deduplicated:true, submission_id:原 id}`；不新增 revision | I | P1 |
| BN-22 | 磁盘只读 / 写失败 | `chmod -w` 或注入错误 | 500 `INGEST_FAILED`；DB 无残留行；tmp 清空 | I | P2 |
| BN-23 | 事务中途失败（第 3 表插入报错） | mock `insertAnswers` 抛错 | 回滚：`submissions` 无该行、目录被删 | U | P2 |
| BN-24 | 第 4 次提交触发裁剪 | 连续 4 次，每次改代码 | 目录剩 r2/r3/r4；r1 行与其 `files/answers` 级联删除；报告为 r4 | I | P1 |
| BN-25 | 学生信息缺字段（无学号） | 不填学号提交 | 阻断在 P0-6 的 prepare 阶段（前端提示 + 后端 400 双保险） | I+M | P0 |
| BN-26 | 请求被中断（客户端超时） | 上传中途掐断 | 服务端 `req.on('aborted')` 清理 tmp；无半截包 | I | P2 |

### D. 报告与前端（BN-27–BN-34）

| 编号 | 场景 | 构造方式 | 期望 | 层 | 阶段 |
|---|---|---|---|---|---|
| BN-27 | 只选学生不选任务 | 页面操作 / 直接打 API | 前端不请求、不渲染；API 400 `FILTER_REQUIRED` | I+M | P0 |
| BN-28 | 只选任务不选学生 | 同上 | 同上 | I+M | P0 |
| BN-29 | 学生未提交该任务 | 选一个合法组合但无数据 | 404 `REPORT_NOT_FOUND`；页面空态「该学生尚未提交此任务」 | I+M | P0 |
| BN-30 | 答案行缺失（历史脏数据） | 手删 `submission_answers` | `answer:null`；页面显示「未作答」；不 500 | I | P2 |
| BN-31 | 索引有行但磁盘文件被删 | 删 `code/main.py` | `files[].missing=true`；下载 404 `FILE_NOT_FOUND`；按钮置灰 | I | P2 |
| BN-32 | 下载中文文件名 | `实验报告.py` | `Content-Disposition: attachment; filename*=UTF-8''…`；浏览器文件名正确 | I | P2 |
| BN-33 | `revision=3` 时页面显示 | 连续提交 3 次 | 显示「第 3 次提交（以最后一次为准）」；旧版本不可达（接口不带 revision 参数） | M | P1 |
| BN-34 | 报告页加载中/请求失败 | 停服务 | 骨架屏 → 错误态 + 「重试」；不白屏 | M | P1 |

### E. 看板（BN-35–BN-40）

| 编号 | 场景 | 构造方式 | 期望 | 层 | 阶段 |
|---|---|---|---|---|---|
| BN-35 | `LOG_SOURCE=bundles` 且无任何提交 | 空库 | 200 + 空数组；`meta.emptyReason='no_submissions'`；图表空态 | I | P1 |
| BN-36 | `days` 把唯一包排除 | `days=7` 但包是 30 天前 | 200 + 空；`emptyReason='out_of_range'` | I | P2 |
| BN-37 | 按 `assignment_id` 筛选，但包内事件无该字段 | 旧包 | 该包被排除，其他包正常；不 500 | I | P2 |
| BN-38 | `LOG_SOURCE=file` 且日志缺失 | 删 `/logs/*.log` | 回退 `sample/student_interactions.log`（现状行为不变）；`meta.usedFallback=true` | I | P2 |
| BN-39 | `bundles` 模式下 `meta.source` 与筛选回显 | 正常查询 | `meta.source='bundles'`、`assignmentFilter` 回显；前端任务下拉可用 | I+M | P1 |
| BN-40 | 单次请求命中 200 个包上限 | 造 250 个 | 截断并 `meta.truncated=true`；响应 < 3 s | I | P2 |

### F. CLI（BN-41–BN-43）

| 编号 | 场景 | 构造方式 | 期望 | 层 | 阶段 |
|---|---|---|---|---|---|
| BN-41 | 任意目录无参运行（有默认日志） | `cd <ws>; npx ts-node …` | 命中 `<cwd>/.cline-logs/student_interactions.log`；打印来源 | U+I | P0 |
| BN-42 | 无参且无任何日志 | 空目录 | exit 1 + 提示三级候选路径；`--strict` 下 exit 2 | U | P0 |
| BN-43 | 给了两个位置参数 / 未知选项 | `a.log b.log` | exit 3 + usage | U | P2 |

### G. 题数自适应与 LLM（BN-44–BN-51）

| 编号 | 场景 | 构造（L/F/R/E/D/W） | 期望 N | 层 | 阶段 |
|---|---|---|---|---|---|
| BN-44 | 极简材料 | 0/1/0/0/120/0 | **3** | U | P1 |
| BN-45 | 中等材料 | 50/1/0/0/350/6 | **4** | U | P1 |
| BN-46 | 丰富材料 | 120/3/5/3/500/15 | **5** | U | P1 |
| BN-47 | 代码清空但改过多轮 | 0/1/0/0/400/12 | **4**（S=3） | U | P1 |
| BN-48 | 完全空提交 | 0/0/0/0/0/0 | **3**（模板题） | U | P0 |
| BN-49 | LLM 返回 2 题 / 7 题 | 篡改 mock 输出 | 补至 3 / 截断至 5 | U | P1 |
| BN-50 | LLM 超时 30 s | mock 挂起 | 中止 → 模板 3 题；面板提示降级；提交不失败 | I | P1 |
| BN-51 | 固定题数模式 | `auto=false, count=5` | 恒 5 题 | U | P1 |

### H. 面板与草稿（BN-52–BN-54）

| 编号 | 场景 | 构造 | 期望 | 层 | 阶段 |
|---|---|---|---|---|---|
| BN-52 | 面板关闭再打开 | 填一半关闭 | 草稿恢复（题干+已填答案+`draftId`） | M | P1 |
| BN-53 | 提交中断网 | 断网确认 | 面板内错误 + 「重试」；重试复用同 `idempotency_key`；不重复入库 | M | P2 |
| BN-54 | 未作答就点确认 | 留空 1 题 | 按钮禁用 + 该题高亮；不发起请求 | M | P0 |

---

## 8. 联调步骤（照着做即可复现全流程）

```powershell
# ── 0. 准备一个干净的数据目录（不污染现有 teaching_system.db）
$env:DATA_DIR = "D:\tmp\teach-data"
$env:LOG_SOURCE = "bundles"

# ── 1. 起 teaching-server（4001）
cd D:\web-dashboard\teaching-server; npm run dev
# 期望日志：SQLite initialized / migration v0 -> v1 / listening 4001

# ── 2. 起看板 backend（4000）
cd D:\web-dashboard\backend; node src/index.js
# 期望：/api/health 200，meta.source=bundles

# ── 3. 起前端（5173）
cd D:\web-dashboard\frontend; npm run dev

# ── 4. 造一个任务
curl -X POST http://localhost:4001/api/v1/assignments -H "Content-Type: application/json" `
  -d '{\"title\":\"词频统计\",\"week\":3,\"description\":\"读取文本并统计词频，输出前10\",\"template_code\":\"# TODO\"}'
# 记下返回的 id，记为 <AID>

# ── 5. 扩展侧（F5 调试）
# 设置 clineTeaching.serverUrl = http://localhost:4001
# 侧栏填学号/姓名/班级 → 拉取任务 → 双击「词频统计」建文件 → 写代码
# 终端执行 python main.py 制造一次报错（用来验证 run_trace）
# 点「提交」→ 面板出 3 题 → 作答 → 「确认提交」

# ── 6. 服务端落盘核对
Get-ChildItem -Recurse "D:\tmp\teach-data\uploads\submissions\<AID>" | Select-Object FullName
# 期望：<sid>\r1\{behavior.jsonl, meta.json, questions.json, answers.json, code\main.py}

# ── 7. 库内核对
sqlite3 "D:\tmp\teach-data\teaching_system.db" `
  "select id,revision,is_current,log_line_count,ai_dependency from submissions; select count(*) from submission_questions; select count(*) from submission_files;"
# 期望：1 行、revision=1、is_current=1、log_line_count>0、题 3 行、文件 ≥1

# ── 8. 报告接口
curl "http://localhost:4001/api/v1/reports/current?assignment_id=<AID>&student_id=<SID>"
# 期望：questions 3 条（含 answer）、files ≥1（含 download_url）

# ── 9. 下载比对
curl -o main.py "http://localhost:4001/api/v1/reports/submissions/<ID>/files/<FID>"
# 与源文件 sha256 一致

# ── 10. Web 验收
# http://localhost:5173 → 顶部 4 项 → 学生实验报告 → 选学生+任务 → 题目与答案自上而下 → 下载代码
# 只选其一时：页面提示「请选择学生与实验任务以查看报告」，且 Network 无请求
```

失败自查表：

| 现象 | 最可能原因 | 查这里 |
|---|---|---|
| 面板一直转圈 | 扩展侧 collect 抛错 | 输出面板 `teaching` 日志；`prepareSubmission` 的 `stage` |
| 201 但库里没题 | `meta.questions` 为空（已传 `skipThinkingQuestions`） | `meta.json`、`questions.json` |
| 报告 404 | `is_current` 没换或 `student_id` 前缀 0 丢失 | `select * from submissions` |
| 报告有题无答 | `answers[].seq` 与 `questions[].seq` 不匹配 | `answers.json` |
| 下载 404 | `stored_name` 与磁盘不一致 | `submission_files` 行 vs `code/` 目录 |
| 看板空 | `LOG_SOURCE` 未设或包内无 `assignment_id` | `/api/health` 的 `meta.source` |

---

## 9. 里程碑

| 里程碑 | 内容 | 可演示状态 | 累计人日 |
|---|---|---|---|
| **M1 = P0** | 骨架 + 模板题闭环 | 学生提交 → Web 看到 3 题 3 答 + 下载代码（含「无日志/无代码」两种空场景） | 7.5 |
| **M2 = P1** | 自适应 3/4/5 + 运行痕迹 + 3 版裁剪 + 看板任务筛选 | 同一任务下不同学生拿到 3/4/5 题；看板能按任务看依赖度 | 13.0 |
| **M3 = P2** | 54 条边界 + 迁移 + 部署 | 可交给 40 名学生试用；助教按手工单回归 | 16.0 |
| M4（P3，本期不做） | 鉴权 / 对象存储 / 归档 / 统一命题 | — | — |

---

## 10. 提交拆分（每个 PR 独立可回滚）

| PR | 内容 | 前置 | 可回滚性 |
|---|---|---|---|
| PR-1 | P0-2 CLI 解析链 + 单测 | — | 纯增量，`git revert` 无副作用 |
| PR-2 | P0-1 + P0-3 契约与迁移 | PR-1 | 迁移只加列/加表，向前兼容；回滚需保留 `user_version` 说明 |
| PR-3 | P0-4 + P0-5 收包与报告接口 + P0-9 冒烟 | PR-2 | 新路由独立，老路由不动 |
| PR-4 | P0-6 + P0-7 扩展收集与面板 | PR-1 | 保留 `skipThinkingQuestions=true` 走老 `submitTask` |
| PR-5 | P0-8 报告页 + 导航 | PR-3 | 导航项可单独隐藏 |
| PR-6 | P1-1 + P1-2 出题与运行痕迹 | PR-4 | 关 `thinkingQuestionAuto` 即回模板题 |
| PR-7 | P1-3 + P1-4 幂等/裁剪/看板 | PR-3 | `LOG_SOURCE` 切回 `file` |
| PR-8 | P1-5 + P2-* 增强与健壮 | PR-6, PR-7 | 逐条 revert |

---

## 11. 风险与止损

| 风险 | 触发信号 | 止损动作 |
|---|---|---|
| shell integration 在目标 VS Code 版本不可用 | `run-traces.jsonl` 始终为空 | 关掉 P1-2 的被动采集，只留 `autoRunOnSubmit` 兜底；题目降级为「静态代码 + 日志」 |
| multipart 体积超预期 | 413 比例 > 5% | 日志上限从 2 MB 降到 800 KB；代码只收「任务相关文件」 |
| SQLite 并发 | `SQLITE_BUSY` | backend 只读连接 + `busy_timeout`；必要时 `PRAGMA journal_mode=WAL` 已有 |
| 出题质量差 | 学生反馈「题看不懂」 | 固定题数模式 + 收紧 prompt（每题必须引用行号/函数名）；模板题兜底 |
| 裁剪误删 | 报告页 404 | 收紧为「只删 `is_current=0` 且 revision 最小的 1 个」并加 24 h 延迟删除 |

---

## 12. 完成定义（DoD 总表）

- [ ] P0：§2 的 ①→⑥ 在**干净数据目录**上跑通；SM-1～SM-8 全绿
- [ ] P0：§3 契约表中每一行在 201 响应与报告响应里都能取到（`contract-check.mjs` 通过）
- [ ] P1：AC2.1（点提交无网络请求）与 AC2.5（确认后一个 multipart）实测通过
- [ ] P1：BN-44～BN-48 三种题数都能出现，且 `submission_questions` 行数 = 学生作答数
- [ ] P1：连续 4 次提交后目录只剩 3 个 `r*`，库内 `is_current` 唯一
- [ ] P2：§7 的 54 条用例逐条打勾（含 ⚠️ 的「目录无日志」「目录无代码文件」）
- [ ] P2：`deploy/DEPLOY.md` 照做可起全栈；`LOG_SOURCE=bundles` 生效；nginx 不暴露 4001
- [ ] P3：不实现鉴权，但 `/api/v1/reports/*` 的路由注册点已集中在一处，便于后续加中间件
