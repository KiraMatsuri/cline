# 实验提交包（Submission Bundle）与实验报告 —— 跨端设计方案

> 版本：v1.0（设计方案，不含实现）
> 范围：`D:\cline`（VS Code 扩展 + 终端分析脚本） × `D:\web-dashboard`（teaching-server + 学情看板 backend + React 前端）
> 对应需求：① 依赖度分析不再读固定路径；② 代码/运行痕迹采集 + LLM 生成思考题 + 一次性提交；③ Web「学生实验报告」页；④ 顶部导航四项重构
> 文末附：接口契约全文、DDL、prompt 模板、验收清单、排期与人日估算

---

## 0. 一句话方案

把「提交」从**传一个路径字符串**改成**上传一个自包含的提交包（Bundle）**：
学生点「提交」→ 扩展在本地收集 `行为日志 + 代码文件 + 运行痕迹`，调用学生本地 LLM 生成 3~5 道思考题并在编辑器面板中让学生作答 → 学生确认后，**一次 multipart 请求**把「日志 + 代码 + 题目 + 答案 + 元数据」上传到 teaching-server → teaching-server 以 `提交包文件 + SQLite 索引` 落库（**不为日志内容建表**），并按 `assignment_id / student_id` 建立索引 → 看板 backend 切换为「按提交包聚合」的数据源，前端新增「学生实验报告」页与四项导航。

---

## 1. 现状与问题（有据可查的部分）

| # | 现状 | 证据 |
|---|---|---|
| P1 | 终端分析脚本默认日志路径**硬编码** `D:\cline-test\.cline-logs\student_interactions.log` | `D:\cline\scripts\analyze-student-log.ts:638-649`，`main()` 用 `process.argv.slice(2).filter(a => !a.startsWith("-"))` 取位置参数，无参时用写死路径 |
| P2 | 提交只传**服务器本地路径**，不传内容 | `AssignmentManager.ts` 的 `SubmissionPayload.log_file_path`；`handleSubmitTask` 第 835-928 行 |
| P3 | teaching-server 收到提交后**去读自己的磁盘**该路径 | `server.ts` `POST /api/v1/submissions`（约 896-1015 行）里调用 `readJsonlLogFile(log_file_path)`，部署态必然 `ENOENT` |
| P4 | 想让看板读到日志的旁路也没打通 | `dashboardAppender.ts` 读 `DASHBOARD_LOG_PATH`，未配置时回退硬编码 `D:/cline-test/...`；`deploy/docker-compose.yml` 只给 backend 配了 `CLINE_LOG_PATH=/logs/...`，teaching-server **既无该变量也无共享卷** → 写入落在容器内临时路径，无人读取 |
| P5 | 指标是两套口径 | teaching-server 用 `analyzeLogs()` 简化启发式（日志占比），看板用 `backend/src/analytics.js` 的 `computeProfile()`（6 维能力）；两者数值不一致 |
| P6 | 看板的任务维度是 Cline 内部 `taskId`，**不是** `assignment_id` | `analytics.js` 中 `new Set(logs.map(l => l.taskId))`，无法回答「某次实验任务的依赖度」 |
| P7 | 代码文件、思考题答案完全没落库 | `submissions` 表只有 `code_snapshot`（单文件全文） |
| P8 | 前端导航 4 项里有 2 项是同一件事的两个动作 | `frontend/src/App.jsx` NavBar（约 1-131 行），`publish` / `manage` 平级 |

**结论**：需求 1 的根因不是「路径写死」，而是**跨机器传递了一个只在本机有意义的引用**。修法必然是「传内容 + 服务端按标识落库」，路径只保留为审计元数据。

---

## 2. 目标与非目标

### 目标
- G1 终端分析：无参 → 按**解析链**定位默认日志；带参 → 分析指定文件；解析失败给出可操作的提示而非堆栈。
- G2 提交：日志**内容**随提交上传；上传后按 `assignment_id + student_id` 可检索；同一学生对同一任务**以最后一次为准**。
- G3 提交前：本地收集代码 + 运行痕迹 → LLM 生成 **3~5 题（按学生情况自适应，默认 3 道）** → 面板作答 → 确认后才上传（未确认不产生任何网络请求）。
- G4 Web：`学生实验报告` 页；学生 + 任务**双筛选必填**；问题-答案纵向排列；底部可下载代码文件。
- G5 导航：4 项一级；`实验任务管理` 下 `发布新任务` / `管理任务` 两个子项。
- G6 看板可按 `assignment_id` 过滤，且指标与 teaching-server 同源。

### 非目标
- 不做逐行日志表（见 D2 的成本论证）。
- 不做对象存储（MinIO/OSS）——留出适配接口，本期用本地卷。
- 不做学生代码的**服务端执行**（安全红线，见 §12）。
- 不改变 `teaching.apiBase` / `clineTeaching.serverUrl` 的既有配置语义。

---

## 3. 总体架构

### 3.1 提交流程（改造后）

```
 VS Code 扩展（学生机）
 ┌──────────────────────────────────────────────────────────────────┐
 │ ① 学生点「提交」→ 不联网，先进入 prepare 阶段                     │
 │    SubmissionPackager.collect()                                   │
 │      ├─ 行为日志  <ws>/.cline-logs/student_interactions.log       │
 │      │    └─ 过滤 taskId==本次 + 全部 run_result + 头尾截断        │
 │      ├─ 代码文件  task_metadata.json 里的文件清单 + includeGlobs   │
 │      └─ 运行痕迹  <ws>/.cline-logs/run-traces.jsonl（新增）        │
 │ ② QuestionGenerator：本地 LLM 一次性 completion                   │
 │      prompt = 任务描述 + 指导书摘录 + 代码 + 报错/运行结果          │
 │      → 3~5 题 JSON（question/intent/difficulty/hint）             │
 │ ③ 打开编辑器区面板 ThinkingQuestionsPanel（单例）                  │
 │      学生填答 → 草稿自动存 workspaceState → 点「确认提交」         │
 │ ④ 一次 multipart POST /api/v1/submissions/bundle                  │
 └──────────────────────────────────────────────────────────────────┘
                                  │
 teaching-server（容器）           ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │ ⑤ BundleService.ingest()                                          │
 │    a. 字段校验 + 体积/类型白名单 + sanitizeSegment（防穿越）        │
 │    b. 落盘 DATA_DIR/uploads/submissions/{aid}/{sid}/r{n}/...      │
 │       文件名强制携带 {assignment_id}__{student_id}__r{n}          │
 │    c. SQLite：submissions（索引行，is_current 唯一）+ 三张明细表    │
 │    d. 指标：调 backend POST /api/dashboard/analyze（同源），        │
 │       超时/失败 → 本地 analyzeLogs() 兜底并标记 metrics_source     │
 └──────────────────────────────────────────────────────────────────┘
                    │ SQLite 索引           │ 文件卷 teaching-data
                    ▼                       ▼
   看板 backend（LOG_SOURCE=bundles）   前端「学生实验报告」页
   读 bundles 聚合 / 支持 assignment_id  双筛选 → 题目+答案 + 下载
```

### 3.2 三个数据面

| 面 | 载体 | 谁写 | 谁读 |
|---|---|---|---|
| 行为日志原文 | `uploads/submissions/.../behavior.jsonl`（每包一份） | teaching-server 收包时落盘 | backend 聚合、报告页统计卡 |
| 结构化索引 | SQLite `submissions` + `submission_questions/answers/files` | teaching-server | 报告页、看板筛选器 |
| 代码文件 | `uploads/submissions/.../code/*` | teaching-server | 报告页下载 |

> **关键点**：日志**不再**追加到一个全局 JSONL。这一条推翻了 `D:\web-dashboard\docs\modification-plan-v2.3.md` 里的 3.C/3.D 决策（「teaching-server 收到提交后 append 到共享 JSONL」），理由见 D2。

---

## 4. 关键决策与取舍

### D1 用「内容上传」取代「路径传递」（需求 1 的核心）
- 扩展在提交时读取日志文件内容，并做**任务切片**：只保留 `event.taskId === 本次 taskId` 的事件 + 所有 `run_result` 事件 + 首 200 / 尾 1800 行兜底，输出 `behavior.jsonl`。
- `meta.log.original_path` 仍上传，但只作审计字段（`submissions.log_original_path`），**任何服务端逻辑不得读它**。
- 收益：彻底消除 P2/P3/P4；日志大小从「未知」变成可控（含 `truncated` 标记）。

### D2 不建日志表：文件为事实源 + SQLite 只存索引（回答「能否不用数据库」）
| 方案 | 写法 | 写入成本 | 「仅保留最后一次」 | 看板改造 | 结论 |
|---|---|---|---|---|---|
| A 纯文件树 + 目录当索引 | 每包一个目录 | 最低 | 靠目录名排序，需全扫 | 重写数据源 | 可行但检索慢（学期上万包时列表页要扫全盘） |
| B **文件存原文 + SQLite 存索引**（推荐） | 见 §5 | 低（一次 `writeFile` + 4 行 `INSERT`） | `is_current` 唯一索引天然实现 | 新增 `bundles` 模式，30 行 | ✅ |
| C 逐行日志入表（`log_events` 表） | 每行一条 `INSERT` | 高：1 包 2000 行 → 40 学生 × 10 任务 × 2000 = 80 万行/轮次，SQLite 单文件 + WAL 需定期 VACUUM，备份变慢 | 需 `DELETE ... WHERE` 或版本列 | 需 SQL 聚合重写 | ❌ 开销大、收益为零（我们从不按行查询） |
| D 对象存储 | MinIO/OSS | 中 | 同上 | 同上 | 过度设计，留接口 |

**结论**：采用 B。日志原文用文件（可 `grep`、可直接喂给现有 `analytics.js`），SQLite 只承担「谁在什么时候交了哪个任务的第几版」这种**结构化、小体积、需要唯一约束**的信息。同时因为 `teaching_system.db` **已存在**，方案 B 的增量成本只是「加 4 张表 + 1 个目录约定」，没有引入新组件。

### D3 幂等与「最后一次为准」
- `submissions` 增列 `revision INTEGER NOT NULL DEFAULT 1`、`is_current INTEGER NOT NULL DEFAULT 1`、`bundle_dir TEXT`。
- 部分唯一索引：`CREATE UNIQUE INDEX ux_sub_current ON submissions(assignment_id, student_id) WHERE is_current = 1;`
- 收包事务：`UPDATE submissions SET is_current = 0 WHERE assignment_id=? AND student_id=? AND is_current=1` → `INSERT ... revision = 旧值+1, is_current=1`。
- 报告页只查 `is_current=1`；旧版本目录保留（可审计），由 `PRUNE_REVISIONS=true` 时保留最近 3 版。

### D4 代码文件采集用「清单制」而不是「整工作区」
- 来源（去重后按优先级）：
  1. `task_metadata.json` 中该任务创建的文件（双击任务时 `createOneFile` 已落盘，天然带 `assignment_id`）；
  2. 扩展配置 `teaching.includeGlobs`（默认 `["**/*.py","**/*.ipynb","**/*.java","**/*.c","**/*.cpp","**/*.js","**/*.ts","**/*.sql"]` 在 `teaching.experimentDir` 内）；
  3. 当前活动编辑器文件（`code_snapshot` 升级为文件包）。
- 排除：`.git`、`node_modules`、`dist`、`.cline-logs`、`*.vsix`、二进制（按扩展名 + 前 8KB 是否含 `\0` 判定）。
- 上限：单文件 512 KB、单包 5 MB、文件数 ≤ 20；超限丢最小价值文件并写 `meta.code.omitted[]`。

### D5 运行痕迹：两级采集，绝不阻塞提交
1. **主路径（被动）**：监听 VS Code shell integration。`VscodeTerminalManager` 已在构造函数里注册 `onDidStartTerminalShellExecution`（`src/hosts/vscode/terminal/VscodeTerminalManager.ts:112-121`，注意 `onDidEndTerminalShellExecution` 目前被注释掉、`read()` 结果被丢弃），新增独立 `RunTraceCollector` 注册 `onDidStartTerminalShellExecution`（拿 `commandLine.value` + `execution.read()` 流）与 `onDidEndTerminalShellExecution`（拿 `exitCode`），过滤命令里出现当前实验文件名的执行，写入 `<ws>/.cline-logs/run-traces.jsonl`。
   - 事件：`{ts, taskId, eventType:"run_result", command, exitCode, durationMs, stdoutTail(≤2KB), stderrTail(≤2KB), detectedErrorType, fileHint}`
   - 不可用（VS Code < 1.93 / shell integration 未启用 / Cursor 差异）→ 静默降级，`meta.run_traces.available=false`。
2. **兜底（主动，opt-in）**：配置 `teaching.autoRunOnSubmit`（默认 `false`）。为 `true` 时，提交 prepare 阶段在**扩展侧沙箱式执行**入口文件（`child_process.spawn` 对应解释器，cwd=实验目录，`timeout=15000`，`maxBuffer=256KB`，无 stdin，环境变量裁掉 `*_KEY/*_TOKEN`），把结果作为 `run_result(source:"submit_probe")` 加入分析输入。**只在学生机执行，永不上服务器执行。**

> D5 的意义：需求 2 的「如果调试运行过就记录报错和运行结果」在被动路径下**学生什么都不用做**；兜底路径保证「从没跑过」时也有至少一次运行证据可分析。

### D6 思考题生成放在扩展侧，不放服务端
| 考量 | 扩展侧（推荐） | 服务端 |
|---|---|---|
| 与「确认前不上传」一致 | ✅ 代码不出本机 | ❌ 必然先上传 |
| LLM Key | 复用学生已配置的 provider（`buildApiHandler`，参考 `explainChangesShared.ts:123` 的一次性调用写法） | 教师 Key（v2.11 起归教师） |
| 成本 | 学生本地额度 | 教师付费，40 人 × 10 次 = 400 次生成 |
| 失败兜底 | 本地模板题（基于 `stderr` 首行 + 指标）立即可用 | 网络依赖 |

选扩展侧。副作用：不同学生会得到不同题目 → **可接受**（报告页展示「学生实际看到的题」，教学端不需要题目全局一致）。若教师要求统一命题，后续加 `assignment.questions_fixed` 覆盖。

> **【裁定 · 题数】** 本期不做统一命题；题数按学生材料丰富度自动取 **3 / 4 / 5，默认 3**，判定规则见 §7.3.1（纯本地、确定性、可单测）。

### D7 一次 multipart 提交，不做「先传文件再传 JSON」
- 原子性：一个请求要么全成要么全败，避免「日志进了库、代码没进」的悬挂态。
- 体积：日志/代码 base64 进 JSON 会膨胀 33% 且撑爆 Express 默认 `json` limit（现 `express.json()` 默认 100 KB，`raw_behavior_logs` 已经接近临界）。
- 幂等键：`meta.idempotency_key = sha256(assignment_id|student_id|log.sha256|code.hashSet)`，重复提交同内容直接返回上次 `submission_id`。

### D8 看板数据源双模式 + 任务维度
- `LOG_SOURCE=file|bundles`（默认 `file` 保持兼容；`bundles` 为新部署默认）。
- `bundles` 模式：`loadBundleLogs({student_id, assignment_id, days})` 遍历 `uploads/submissions/**/behavior.jsonl`（用 SQLite 索引先筛 `is_current=1` 得到路径列表，**避免全盘扫描**）→ 读文件 → 注入 `assignment_id`/`submission_id` → 复用现有 `computeSummary/computeDistributions/computeProfile/computeInterventionInsights`。
- `analytics.js` 新增 `filterByAssignment(logs, assignmentId)`，`getScopedLogs()` 增加 `assignment_id` 参数；`/api/dashboard/students` 增加 `assignments` 维度返回。

### D9 指标单一事实源：`POST /api/dashboard/analyze`
- teaching-server 收包后不自己算，改调 backend：`POST http://backend:4000/api/dashboard/analyze`，body `{logs:[...], options:{}}`，返回 `{summary, profile}`。
- 超时 3 s / 失败 → 用 teaching-server 现有 `analyzeLogs()` 兜底，`submissions.metrics_source = 'local'`（成功为 `'canonical'`）。
- 收益：修掉 P5，前端两个页面同一次提交的 AI 依赖度必然一致。

---

## 5. 数据模型

### 5.1 磁盘布局（`DATA_DIR`，容器内 `/app/data`）

```
DATA_DIR/
└─ uploads/
   └─ submissions/
      └─ {assignment_id}/                 # 例：a3f2c1d4
         └─ {student_id}/                 # 例：20231011
            ├─ r1/                        # 第 1 次提交（保留审计）
            │  ├─ behavior.jsonl          # ← 日志原文（事件已注入 assignment_id）
            │  ├─ meta.json               # 原样保留的 meta（含 original_path）
            │  ├─ questions.json          # 学生实际看到的题（含 generation 元信息）
            │  ├─ answers.json            # 学生答案
            │  └─ code/
            │     ├─ main.py
            │     └─ utils.py
            └─ r2/ ...                    # 第 2 次提交
```

**文件名规则（需求 1 要求「重命名/标记带上任务 id + 学号」）**：目录已承载两段 id，另在**落盘的每个文件头**与 `submissions.bundle_dir` 中冗余记录；同时 `behavior.jsonl` 每行注入 `assignment_id/student_id/submission_id`。三重标记保证「脱离目录单独拷走一个文件也知道是谁的哪个任务」。

**版本保留（裁定：只留最近 3 版）**：`PRUNE_REVISIONS=3`（默认）。收包事务提交后，若同一 `(assignment_id, student_id)` 的 revision 数 > 3，按 revision 升序删除最旧的目录（`r1`、`r2`…）与其 `submissions` 行（`ON DELETE CASCADE` 连带 `submission_questions / submission_answers / submission_files`）。`r` 编号**不重排**（删掉 r1 后新提交仍是 r4），保证审计可追溯。报告页只引用 `is_current=1`，裁剪对用户不可见。

### 5.2 DDL（增量，SQLite `ALTER TABLE` + 新表）

```sql
-- ① 扩展既有表
ALTER TABLE submissions ADD COLUMN revision        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE submissions ADD COLUMN is_current      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE submissions ADD COLUMN bundle_dir      TEXT;              -- 相对 DATA_DIR
ALTER TABLE submissions ADD COLUMN log_line_count  INTEGER DEFAULT 0;
ALTER TABLE submissions ADD COLUMN log_sha256      TEXT;
ALTER TABLE submissions ADD COLUMN log_truncated   INTEGER DEFAULT 0;
ALTER TABLE submissions ADD COLUMN log_original_path TEXT;            -- 仅审计
ALTER TABLE submissions ADD COLUMN metrics_source  TEXT DEFAULT 'local';  -- canonical|local
ALTER TABLE submissions ADD COLUMN task_id         TEXT;              -- Cline 内部 taskId
ALTER TABLE submissions ADD COLUMN idempotency_key TEXT;
ALTER TABLE submissions ADD COLUMN client_version  TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_current
  ON submissions(assignment_id, student_id) WHERE is_current = 1;
CREATE UNIQUE INDEX IF NOT EXISTS ux_sub_idem
  ON submissions(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sub_assignment ON submissions(assignment_id, is_current);
CREATE INDEX IF NOT EXISTS ix_sub_student    ON submissions(student_id, is_current);

-- ② 思考题（学生实际看到的题面快照）
CREATE TABLE IF NOT EXISTS submission_questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  seq           INTEGER NOT NULL,          -- 1..5
  question      TEXT NOT NULL,
  intent        TEXT,                      -- 考察点
  difficulty    TEXT,                      -- easy|medium|hard
  hint          TEXT,
  source        TEXT NOT NULL DEFAULT 'llm',  -- llm|template
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_sq_sub ON submission_questions(submission_id, seq);

-- ③ 答案
CREATE TABLE IF NOT EXISTS submission_answers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  question_id   INTEGER NOT NULL,
  answer        TEXT NOT NULL,
  answered_at   TEXT,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id)   REFERENCES submission_questions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_sa_sub ON submission_answers(submission_id);

-- ④ 代码文件索引（文件本体在 code/ 目录）
CREATE TABLE IF NOT EXISTS submission_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL,
  rel_path      TEXT NOT NULL,
  stored_name   TEXT NOT NULL,   -- 落盘名（含 id 前缀，防同名）
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT,
  language      TEXT,
  line_count    INTEGER,
  FOREIGN KEY (submission_id) REFERENCES submissions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_sf_sub ON submission_files(submission_id);
```

> 为什么 `submissions` 不复用老字段：老 `code_snapshot`（单文件）继续写（=首文件全文），保持向后兼容；新的多文件信息进 `submission_files`。

### 5.3 一个提交包在库里的样子

```
submissions:
  id=812  assignment_id=a3f2c1d4  student_id=20231011  student_name=王小明
  class_id=人工智能2023  submitted_at=2026-10-20T14:33:10Z
  revision=2  is_current=1  bundle_dir=uploads/submissions/a3f2c1d4/20231011/r2
  ai_dependency=0.62  metric_gaming_score=0.18  user_edit_count=7
  log_line_count=1487  log_sha256=9f3c…  log_truncated=0  metrics_source=canonical
```

---

## 6. 接口契约

### 6.1 终端分析脚本（需求 1 前半）

```
node scripts/analyze-student-log.ts [logPath] [options]          # Node ≥ 22 原生跑 .ts
npx ts-node scripts/analyze-student-log.ts [logPath] [options]

位置参数
  logPath            省略时按「默认解析链」定位；传了则**只**分析该文件，不存在即失败

选项
  --workspace, -w <dir>  指定工作区根
  --log, -l <file>       日志文件路径（与位置参数等价，二者互斥）
  --json, -j             额外导出 JSON 报告
  --out, -o <file>       指定 JSON 输出路径（默认 <log>_analysis.json）
  --strict               日志不存在或 0 条事件时 exit 2
  --help, -h             用法

默认解析链（首个命中即用；`--workspace` 与日志路径互斥）
  1. 位置参数 / --log <file>                                          → 命令行参数
  2. 环境变量 CLINE_STUDENT_LOG（兼容 CLINE_LOG_PATH）                 → 环境变量
  3. <--workspace>/.cline-logs/student_interactions.log               → --workspace 参数
  4. <VS Code 工作区根>/.cline-logs/student_interactions.log           → VS Code 工作区
     —— 扩展侧传入，属**权威信号**：该工作区没有日志就报错，绝不回退到别的工作区
  5. <cwd>/.cline-logs/student_interactions.log                       → 当前工作目录
  6. 从 cwd 向上回溯 ≤ 4 层目录的同一相对路径                           → 当前目录的上级工作区

  ⚠️ 整条链**没有任何写死的绝对路径兜底**：历史固定路径 D:\cline-test\... 已移除
     （这是需求 1 的核心，源码守卫测试会断言 CLI 与解析器里不再出现它）。
  命中后打印「（路径来源：<中文来源>）」，JSON 报告落 logPath / logSource / logPathCandidates，
  便于教学端把「分析结果 ↔ 具体日志文件」对上账。

退出码：0 成功 / 1 日志不存在或读取失败 / 2 --strict 下日志不存在或 0 条事件 / 3 参数错误
```

实现落点：`src/core/teaching/logPathResolver.ts`（纯函数、零 vscode 依赖，`resolveLogPath()` 即上表）+
`src/core/teaching/workspaceLogPath.ts:resolveStudentLogFile()`（扩展侧复用同一套规则）。
单测 `src/core/teaching/__tests__/logPathResolver.test.ts`，CLI 闸门 `scripts/verify/log-path-cli.test.ps1`。


### 6.2 扩展 → 教学端：提交包（新增主接口）

```
POST /api/v1/submissions/bundle
Content-Type: multipart/form-data; boundary=...
上限：单请求 12 MB（multer limits: fileSize 6MB, files 30）

表单字段
  meta         (text, 必填，JSON 字符串)  ← 见下
  log          (file, 必填，behavior.jsonl，≤ 2 MB)
  code         (file, 可重复，字段名固定为 code，≤ 20 个)
  code_path_i  (text, 与 code 顺序对应的相对路径，可省略则用文件名)

meta = {
  "schema": "submission-bundle/v1",
  "assignment_id": "a3f2c1d4",
  "student_id": "20231011",
  "student_name": "王小明",
  "class_id": "人工智能2023",
  "task_id": "01J8…",                       // Cline 内部 taskId（审计/关联 run_traces）
  "submitted_at": "2026-10-20T14:33:10Z",
  "client_version": "2.14.0",
  "idempotency_key": "sha256:…",
  "log":   { "line_count": 1487, "sha256": "9f3c…", "truncated": false,
             "original_path": "D:\\lab\\ws\\.cline-logs\\student_interactions.log" },
  "code":  [ { "path": "main.py", "size": 2143, "sha256": "aa01…", "language": "python" } ],
  "run_traces": { "available": true, "count": 3,
                  "items": [ { "command": "python main.py", "exitCode": 1,
                               "stderr_tail": "KeyError: 'name'", "ts": "…" } ] },
  "questions": [ { "seq": 1, "question": "…", "intent": "…", "difficulty": "medium", "hint": "…" } ],
  "answers":   [ { "seq": 1, "answer": "…" } ],
  "metrics_snapshot": { "ai_dependency": 0.62 }   // 学生端粗算，仅对账
}

201 Created
{
  "ok": true,
  "submission_id": 812,
  "revision": 2,
  "stored": { "bundle_dir": "uploads/submissions/a3f2c1d4/20231011/r2",
              "log_object": "…/behavior.jsonl", "code_count": 2 },
  "metrics": { "ai_dependency": 0.62, "metric_gaming_score": 0.18,
               "user_edit_count": 7, "metrics_source": "canonical" },
  "indexed_events": 1487
}
```

幂等：`idempotency_key` 命中 → `200` + 原 `submission_id` + `"deduplicated": true`。

错误码：

| HTTP | code | 含义 / 前端提示 |
|---|---|---|
| 400 | `META_INVALID` | meta 解析失败或缺字段 |
| 400 | `ASSIGNMENT_NOT_FOUND` | 任务不存在（提示刷新任务列表） |
| 400 | `CODE_TOO_LARGE` | 代码超限（提示精简文件后重试） |
| 413 | `BUNDLE_TOO_LARGE` | 整包超限 |
| 415 | `UNSUPPORTED_FILE` | 二进制/不支持的扩展名 |
| 409 | `NOT_CURRENT_CONFLICT` | 并发同学生同任务（重试一次即可） |
| 500 | `INGEST_FAILED` | 落盘/入库失败（**已回滚**，可安全重试） |

### 6.3 报告查询（需求 3）

```
GET /api/v1/reports/filters
200 { ok, assignments:[{id,title,week}], students:[{student_id,student_name,class_id}] }
    —— 仅来自 submissions WHERE is_current=1，保证「有报告才可选」

GET /api/v1/reports/current?assignment_id=<aid>&student_id=<sid>
200 {
  ok, report: {
    submission_id, revision, submitted_at, metrics:{...},
    student:{student_id,student_name,class_id},
    assignment:{id,title,week},
    log:{line_count, truncated, run_trace_count},
    questions:[{seq,question,intent,difficulty,answer,answered_at}],   // 已 join 答案
    files:[{file_id,name,size_bytes,language,line_count,download_url}]
  }
}
400 FILTER_REQUIRED   —— 任一参数缺失（**对应「缺一不显示」**）
404 REPORT_NOT_FOUND  —— 该学生未提交该任务
```

```
GET /api/v1/reports/submissions/:submissionId/files/:fileId[?inline=1]
200 → 文本文件 text/plain; charset=utf-8（inline=1）或 application/octet-stream + attachment
      Content-Disposition: attachment; filename*=UTF-8''main.py
404 FILE_NOT_FOUND
```

```
GET /api/v1/reports/submissions/:submissionId/log        # 教师侧排查用（可选，P3）
POST /api/dashboard/analyze                              # D9：指标同源
  body { logs:[...], options:{ } }
  200  { ok, summary:{...}, profile:{...} }
```

### 6.4 看板接口扩展（需求 1「便于前端按学生/任务检索依赖度」）

```
GET /api/dashboard/summary?days=30&student_id=20231011&assignment_id=a3f2c1d4
GET /api/dashboard/profile?…同上
GET /api/dashboard/distributions?…同上
GET /api/dashboard/students?days=all[&assignment_id=…]
GET /api/dashboard/assignments            # 新增：可筛选的任务列表（id/title/week/提交人次）
```

`meta` 增加：`{ source: "bundles"|"file", logFiles: 12, assignmentFilter: "a3f2c1d4", emptyReason }`。
`emptyReason` 用于前端给出「该学生该任务暂无日志」而不是空图表。

### 6.5 扩展内部 IPC（webview ↔ extension）

```ts
// AssignmentTab → Extension
{ type:"assignment_command", command:"prepareSubmission", payload:{ assignmentId } }
{ type:"assignment_command", command:"confirmSubmission", payload:{ draftId } }
{ type:"assignment_command", command:"cancelSubmission", payload:{ draftId } }

// Extension → AssignmentTab
{ command:"prepareSubmission", success:true,
  data:{ draftId, questions:[...], analysis:{ codeSummary, runTraces, weakPoints }, expiresAt } }
{ command:"prepareSubmission", success:false, error, stage:"collect|generate|panel" }
{ command:"confirmSubmission", success:true, data:{ submission_id, revision, metrics } }

// Extension → ThinkingQuestionsPanel（新 data-view）
{ command:"questionsReady", data:{ draftId, assignmentTitle, questions, studentInfo } }
{ command:"submitResult", success, data|error }
```

---

## 7. 学生端（D:\cline）改造清单

### 7.1 新增文件

| 文件 | 职责 | 关键签名 |
|---|---|---|
| `src/core/teaching/submission/bundleTypes.ts` | 契约类型（与 §6.2 同构） | `export interface SubmissionBundleMeta { … }` |
| `src/core/teaching/submission/SubmissionPackager.ts` | 收集日志切片/代码文件/运行痕迹、算哈希、体积累加与丢弃策略 | `collect(input: {workspaceRoot, assignment, taskId, studentInfo, cfg}): Promise<PackagedDraft>`；`toMultipart(draft): FormData` |
| `src/core/teaching/submission/RunTraceCollector.ts` | 注册 shell integration 监听、过滤、落盘 `run-traces.jsonl`、读最近 N 条 | `start(): Disposable`；`snapshot(taskId: string, limit = 20): RunTrace[]` |
| `src/core/teaching/submission/QuestionGenerator.ts` | 组 prompt、调 LLM、校验/裁剪 3~5 题、模板兜底 | `generate(ctx: {assignment, code, runTraces, profile}): Promise<{questions: Question[], source: "llm"\|"template"}>` |
| `src/core/teaching/submission/SubmissionDraftStore.ts` | 草稿（含作答）持久化，防面板关闭丢失 | `save(draft)`, `load(draftId)`, `clear(draftId)`（`context.workspaceState`，键 `teaching.draft.<aid>.<sid>`） |
| `src/hosts/vscode/ThinkingQuestionsPanelProvider.ts` | 编辑器区面板宿主（照 `FeedbackPanelProvider.ts` 单例 + nonce + `data-view` 模式） | `reveal(draft)`；`viewId = "clineThinkingQuestions"` |
| `webview-ui/src/components/teaching/ThinkingQuestionsForm.tsx` | 表单（照 `FeedbackForm.tsx` 交互：题干卡片 + 多行输入 + 字数统计 + 提交态） | props `{ questions, onSubmit, onCancel, submitting }` |

### 7.2 修改文件

| 文件 | 改动 |
|---|---|
| `src/core/teaching/AssignmentManager.ts` | ① `handleSubmitTask` 拆成 `handlePrepareSubmission` + `handleConfirmSubmission`（原 `submitTask` 保留为「跳过思考题直接提交」的兼容分支，配置 `teaching.skipThinkingQuestions` 控制，默认 false）；② 新增 `postBundle()`（multipart，复用 `fetchWithRetry`，超时 60 s）；③ `SUPPORTED_COMMANDS` 增加 3 个命令；④ 成功提示改为「第 N 次提交 · AI 依赖度 X%」 |
| `webview-ui/src/components/teaching/AssignmentTab.tsx` | 「一键提交」按钮 → 发 `prepareSubmission`；成功后展示「已生成 3 道思考题，正在打开答题面板…」；`submitting` 文案分两段（分析中 / 上传中） |
| `webview-ui/src/App.tsx` | 第 40 行附近增加 `if (currentView === "clineThinkingQuestions") return <ThinkingQuestionsForm …/>` |
| `package.json` | 新增配置：`teaching.includeGlobs`（array）、`teaching.autoRunOnSubmit`（boolean，default false）、`teaching.skipThinkingQuestions`（bool，false）、`teaching.thinkingQuestionAuto`（bool，**default true** = 按 §7.3.1 自适应）、`teaching.thinkingQuestionCount`（`{type:"number", default:3, minimum:3, maximum:5}`，仅 `thinkingQuestionAuto=false` 时固定题数）、`teaching.bundleMaxBytes`（default 5242880） |
| `scripts/analyze-student-log.ts` | 抽 `resolveDefaultLogPath()`（纯函数）+ 新 CLI 选项（§6.1）；退出码语义化 |
| `src/core/teaching/workspaceLogPath.ts` | 增加 `resolveStudentLogFile(): string`（只解析不创建），供 packager 与 CLI 共享同一套规则 |

### 7.3 思考题生成：prompt 与输出契约

```
system:
你是《<课程名>》实验课助教。你在阅读一名学生刚完成的实验代码与其调试记录。
只能基于给定材料提问：不要假设学生用了未出现的库，不要出与任务无关的题。
输出严格 JSON，不要 markdown 代码块。

user:
[任务] 第 3 周 · 词频统计
[任务描述] <assignments.description，截断 2000 字>
[实验指导书摘录] <attachments 中 .md/.txt 的正文，截断 3000 字；无则空>
[学生代码] <最多 3 个文件，各截断 4000 字，带文件路径标题>
[运行/报错记录] <最近 5 条 run_trace：命令 / exitCode / stderr 尾 500 字 / stdout 尾 500 字>
[行为特征] AI 依赖度 0.62（偏高）；自主修改率 0.35；调试 4 次

要求：
1. 出 {N} 道题（N 由 §7.3.1 规则算出，默认 3），覆盖三类：
   - 归因类：代码里某个具体写法的原因（引用行号或函数名）
   - 排错类：针对真实出现过的报错，问根因与验证方式
   - 迁移类：换一个输入/边界条件会怎样
2. 每题 ≤ 60 字，避免「请谈谈你的理解」这类空题。
3. 不要出选择题；不要问「你用了什么 AI 工具」。
4. 每题给 intent（考察点，≤20 字）与 difficulty（easy|medium|hard）。

输出 JSON：
{"questions":[{"question":"…","intent":"…","difficulty":"medium","hint":"…"}]}
```

校验：`Array.isArray`、1..5 条、每题 `question` 长度 5..200、`difficulty ∈ {easy,medium,hard}`；不足 3 条或解析失败 → 模板题（示例：「你的代码在第 X 行对 `dict` 直接取键，若输入缺少该键会发生什么？你会如何改？」由 `stderr` 首行 `KeyError: 'name'` 直接生成）。

失败再兜底（离线/LLM 不可用）：3 道固定结构化题（实现思路 / 遇到的最大问题及定位过程 / 若数据量扩大 100 倍会改哪里），`source="template"` 落库，报告页可见但不影响提交。

> **【实现 · 模型来源】**（2026-10-19 修订）出题调用**直接复用 Cline 自带设置里的 provider / API Key / 模型**：
> 从 `StateManager.getApiConfiguration()` 取 `actModeApiProvider` + `actModeApiModelId`（未配置时回退 `planMode*`），
> 交给 `buildApiHandler(config, mode)` —— 与主对话（`src/core/task/index.ts:473-519`）用同一份配置，学生配一次即可。
> **不使用工作区 `.env`，也没有插件侧独立的 key 输入框**；401 / 缺 key 的错误在面板上翻译成「设置 → API 配置检查密钥」。
> 早期实现误用 `config.apiProvider`（该字段在 `ApiConfiguration` 中不存在）导致出题恒降级为模板题，已修复，见实施计划 §5.1。

### 7.3.1 题数自适应规则（默认 3，自动 3/4/5）

**为什么不用「任务难度」**：难度是老师侧的粗标签（现有 `assignments` 表没有难度列），而学生**实际写出来的东西**才是出题能用的料。因此题数只由「该学生这次提交的材料丰富度」决定——同一任务，写得多的学生被问得多，写得少的不会被硬凑题。

纯本地、零网络、确定性计算（可单测，无 LLM 参与），输入 6 个特征：

| 特征 | 含义 | 取值方式 |
|---|---|---|
| `L` | 代码有效行数（去空行/注释） | packager 统计 |
| `F` | 代码文件数 | packager 统计 |
| `R` | `run_result` 条数 | RunTraceCollector |
| `E` | 其中 `exitCode != 0` 的条数 | 同上 |
| `D` | 任务描述字符数（指导书正文也计入 `D`） | `assignments.description` |
| `W` | 本次 taskId 的 `code_edit` 事件数 | 日志切片 |

计分：

```
S = 0
S += 2 if L >= 80 else 1 if L >= 40 else 0
S += 1 if F >= 3 else 0
S += 1 if R >= 1 else 0
S += 1 if R >= 4 else 0
S += 1 if E >= 1 else 0
S += 1 if E >= 3 else 0
S += 1 if D >= 300 else 0
S += 1 if W >= 10 else 0          // 最多 9 分

N = 5 if S >= 5 else 4 if S >= 2 else 3
// 强制上限：材料确实不够时不给 4/5，避免"无料硬问"
if (L < 10 && R == 0) N = 3
// 配置覆盖：teaching.thinkingQuestionAuto=false → N = teaching.thinkingQuestionCount
```

典型取值（同时是单测用例）：

| 场景 | L | F | R/E | D | W | S | N |
|---|---|---|---|---|---|---|---|
| 只建了文件没写代码，没跑过 | 0 | 1 | 0/0 | 120 | 0 | 0 | **3** |
| 写了 50 行单文件，未运行 | 50 | 1 | 0/0 | 350 | 6 | 3 | **4** |
| 3 文件 120 行，跑过 5 次含 3 次报错 | 120 | 3 | 5/3 | 500 | 15 | 9 | **5** |
| 代码被清空但日志里改过 12 次 | 0 | 1 | 0/0 | 400 | 12 | 3 | **4** |
| 空提交（无代码无日志） | 0 | 0 | 0/0 | 0 | 0 | 0 | **3**（模板题） |

`N` 会写进 `submission_questions` 的行数与 `questions.json` 的 `count`，报告页题数即学生实际作答数——**不做「补足到固定题数」**，只做「不足 3 道时补模板题、超过 5 道时截断」。



### 7.4 面板 UI 契约（对照 FeedbackForm 的实现方式）

- 单例编辑器区面板（`ViewColumn.Active`），`retainContextWhenHidden: true`；
- 顶部：任务名 + 学生信息 + 「本次分析要点」折叠块（代码行数 / 运行次数 / 最后一次报错首行）；
- 每题：序号 + 题干 + `intent` 作为灰色小字 + 多行输入（`maxLength 2000`，实时字数）+ 本地草稿标记；
- 底部：`取消`（`cancelSubmission`，草稿保留 24 h）/ `确认提交`（全部题非空才可点）；
- 提交后：面板内进度条（上传中）→ 成功显示「提交成功 · 第 2 次提交」+ 自动 2 s 后关闭并 `reveal` 主侧栏；
- 断网：错误留在面板内，`重试` 按钮复用同一草稿（`idempotency_key` 不变，服务端去重）。

---

## 8. 教学端（teaching-server）改造清单

### 8.1 新增模块

| 文件 | 职责 |
|---|---|
| `src/submission/bundleService.ts` | 校验 + 落盘 + 事务入库 + 指标获取（D9）+ 幂等 |
| `src/submission/bundlePaths.ts` | `sanitizeSegment()`、`bundleDirFor(aid,sid,rev)`、`safeJoin()`（防 `..`） |
| `src/submission/fileStore.ts` | multer 落盘、sha256、语言识别、行数统计、`omitted[]` 记录 |
| `src/submission/reportService.ts` | `getCurrentReport()`、`getFileStream()`、`listFilters()` |
| `src/db/migrations.ts` | `PRAGMA user_version` 驱动的增量迁移（当前库为 v0 → 目标 v1） |

### 8.2 `POST /api/v1/submissions/bundle` 处理流程（伪代码）

```ts
router.post("/submissions/bundle", upload.any(), async (req, res) => {
  const meta = parseMeta(req.body.meta)                       // 400 META_INVALID
  assertAssignmentExists(meta.assignment_id)                   // 400 ASSIGNMENT_NOT_FOUND
  const idem = findByKey(meta.idempotency_key)
  if (idem) return res.status(200).json({ ok:true, deduplicated:true, submission_id:idem.id })

  const tmp = await stageToTmp(req.files)                      // 先写 DATA_DIR/tmp/<uuid>
  try {
    const events = parseJsonl(tmp.log)                         // 坏行计数，<50% 有效则 400
    const enriched = events.map(e => ({ ...e,
      assignment_id: meta.assignment_id, student_id: meta.student_id,
      submission_id: null, student_meta: pickMeta(meta) }))    // 注入 → 看板可按任务检索
    const dir = bundleDirFor(meta.assignment_id, meta.student_id, nextRevision(meta))
    await finalizeBundle(tmp, dir, { events: enriched, meta }) // 落盘 behavior.jsonl/meta.json/code/
    const metrics = await fetchCanonicalMetrics(enriched)      // D9，失败 → analyzeLogs()
    const id = db.transaction(() => {
      db.run("UPDATE submissions SET is_current=0 WHERE assignment_id=? AND student_id=? AND is_current=1", …)
      const r = insertSubmission({ ...meta, revision, is_current:1, bundle_dir:rel(dir), metrics })
      insertQuestions(r.lastID, meta.questions); insertAnswers(…); insertFiles(…)
      return r.lastID
    })
    await pruneRevisions(meta.assignment_id, meta.student_id, 3)   // 只留最近 3 版，删最早目录+行
    res.status(201).json({ ok:true, submission_id:id, revision, stored:{…}, metrics, indexed_events:enriched.length })
  } catch (e) {
    await rm(dir, {recursive:true, force:true}); await rm(tmp, {recursive:true, force:true})
    throw e                                                    // 500 INGEST_FAILED，全量回滚
  }
})
```

要点：
- **先写 tmp 再 rename**，避免半截包被报告页读到（`rename` 同盘原子）。
- `multer` 的 `dest` 指向 `DATA_DIR/tmp`，`limits: { fileSize: 6*1024*1024, files: 30, fields: 40 }`。
- 保留旧 `POST /api/v1/submissions`（JSON）**不删**，内部转调新逻辑并将 `ai_dependency` 兼容返回；用于灰度期老版本扩展（`client_version < 2.14`）。
- 附件名修复复用现成 `fixMojibakeFilename()`。

### 8.3 报告与筛选器

- `listFilters()`：`SELECT DISTINCT assignment_id, student_id … WHERE is_current=1 JOIN assignments`；`students` 去重按 `student_id` 取最新 `student_name/class_id`。
- `getCurrentReport()`：一次 JOIN `submissions × submission_questions × submission_answers × submission_files`，按 `seq` 排序；`questions` 与 `answers` 按 `question_id` 对齐；缺失答案的题（历史异常）返回 `answer: null` 让前端显示「未作答」。
- 下载：流式 `fs.createReadStream`，`Content-Type` 按扩展名映射（`.py → text/x-python`，`.ipynb → application/json`），`inline=1` 时包一层 `<pre>` 便于浏览器直接看。

---

## 9. 看板后端（backend）改造

```js
// src/index.js
const SOURCE = process.env.LOG_SOURCE || 'file'
app.get('/api/dashboard/summary', wrap(async (req,res) => {
  const logs = await loadScopedLogs(req)           // ← 唯一改动入口
  res.json({ ok:true, summary: computeSummary(logs), meta: buildMeta(logs, req) })
}))

async function loadScopedLogs(req) {
  let logs = SOURCE === 'bundles' ? await loadBundleLogs(req.query) : readJsonlLogs(LOG_PATH)
  logs = filterByDays(logs, parseDaysParam(req.query.days))
  logs = filterByStudentMeta(logs, req.query)
  logs = filterByAssignment(logs, req.query.assignment_id)     // 新增
  return logs
}
```

`loadBundleLogs()`：
1. 用 SQLite 只读连接查 `submissions`（`better-sqlite3` 或 `sqlite3` 只读打开；**不写**，避免与 teaching-server 抢写锁）；
2. 取 `bundle_dir` 列表 → 读 `behavior.jsonl`（`fs.promises.readFile` + 逐行 `JSON.parse`，坏行计入 `meta.badLines`）；
3. 内存缓存：`Map<bundle_dir, {mtimeMs, logs}>`，TTL 30 s，命中率在「同一筛选反复请求」场景下接近 100%；
4. 上限保护：单次请求最多读 200 个包 / 20 万行，超出截断并在 `meta.truncated=true`。

`file` 模式保持原行为（含 `usedFallback` 与 sample 回退），用于「只有一份导出日志」的旧环境。

---

## 10. Web 前端改造

### 10.1 导航（需求 4）

```
学情画像看板 │ 实验任务管理 ▾ │ 教学资料管理 │ 学生实验报告
                ├ 发布新任务   → view='publish'
                └ 管理任务     → view='manage'
```

- `App.jsx` 的 NavBar 改为数据驱动：
  ```js
  const NAV = [
    { key:'dashboard', label:'📊 学情画像看板' },
    { key:'assignment', label:'🗂 实验任务管理', children:[
        { key:'publish', label:'发布新任务' },
        { key:'manage',  label:'管理任务' } ] },
    { key:'wiki',   label:'📚 教学资料管理' },
    { key:'report', label:'📝 学生实验报告' },
  ]
  ```
- `view` 内部值**保持 `'publish' | 'manage'` 不变**（组件 props 与主题色不动），仅外层分组变化——把改造面压到 NavBar 与分组高亮逻辑（`activeGroup = view==='publish'||view==='manage' ? 'assignment' : view`）。
- 子项交互：桌面端 hover/点击展开（AntD `Dropdown` + `menu`），移动端折叠为分组标题 + 两项；键盘可达（`Tab`/`Enter`/`Esc`）。
- 顶部栏仍 4 项，`dev-feedback` 隐藏页不受影响（hash 路由优先级不变）。

### 10.2 学生实验报告页（需求 3）`src/components/StudentReport.tsx`

```
┌ 筛选栏 ────────────────────────────────────────────────┐
│ 学生 [Select showSearch 按学号/姓名]  实验任务 [Select]  │
│ （未同时选中时：下方显示「请选择学生与实验任务以查看报告」）│
└────────────────────────────────────────────────────────┘
┌ 报告头 ───────────────────────────────────────────────┐
│ 王小明 · 20231011 · 人工智能2023  第3周 词频统计        │
│ 提交时间 2026-10-20 14:33 · 第 2 次提交 · AI依赖度 62%  │
└────────────────────────────────────────────────────────┘
┌ 思考题 ───────────────────────────────────────────────┐
│ Q1 你的代码在第 12 行直接 dict['name']，若输入缺该键…   │
│ 考察点：异常处理         难度：medium                  │
│ 答：我会先 get() 再判空……                              │
│ ────────────────────────────────────────────────────  │
│ Q2 …                                                   │
└────────────────────────────────────────────────────────┘
┌ 代码文件 ─────────────────────────────────────────────┐
│ main.py  2.1 KB  128 行   [下载] [预览]                │
│ utils.py 0.8 KB   42 行   [下载] [预览]                │
└────────────────────────────────────────────────────────┘
```

行为：
- 两个 `Select` 均 `required`；只选一个 → 不发请求（前端直接短路，**同时**后端返回 `FILTER_REQUIRED`，双保险）。
- 学生下拉选项来自 `/api/v1/reports/filters`（只列有 `is_current=1` 提交的学生）；选中学生后任务下拉收窄为「该学生提交过的任务」；反之亦然（互斥收窄，避免空查）。
- 下载：`<a href={download_url} download>` 直连；「预览」用 `Modal` + `inline=1` 文本。
- 空态/加载/错误三态齐全；`revision>1` 时显示「第 N 次提交（以最后一次为准）」。
- 顶部小字兜底提示：`metrics_source==='local'` 时标注「指标为本地近似值」。

### 10.3 看板页增强（配合 G6）

- 筛选栏增加 `实验任务` 下拉（来自 `/api/dashboard/assignments`），与 `days/学生` 组合生效；
- 实现时**不置灰**：`file` 模式下事件里没有 `assignment_id`，下拉只剩「全部任务」，由后端 `emptyReason=filtered_out` 给出提示——置灰会让 `file` 模式用户以为功能坏了；
- 空态分两档：`emptyReason='no_submissions'` → 「还没有学生提交记录」；`'filtered_out'` → 「当前筛选下没有匹配事件（共 N 条），请放宽筛选」。

---

## 11. 兼容与迁移

| 场景 | 处理 |
|---|---|
| 老版本扩展（< 2.14）仍发 JSON 提交 | 保留 `POST /api/v1/submissions`，内部转调 bundle 逻辑；无日志内容 → `log_line_count=0`, `log_sha256=NULL`, `metrics_source='snapshot'`，报告页显示「无日志（旧版提交）」 |
| 历史 `submissions` 行 | 迁移脚本 `scripts/migrate-bundles.ts`：为每行生成 `bundle_dir=uploads/submissions/{aid}/{sid}/legacy-r{n}`，写 `meta.json` + `code_snapshot`→`code/snapshot.txt`，`is_current` 按 `submitted_at` 取最新；无日志不造数据 |
| 看板旧部署（单一 JSONL） | `LOG_SOURCE=file` 默认值不变；新部署在 `deploy/docker-compose.yml` 把 backend 设为 `LOG_SOURCE=bundles` + `TEACHING_LOG_PATH=/teaching-data/dashboard/student_interactions.jsonl`，并只读挂载 `teaching-data:/teaching-data:ro`（事件流由教学端入库后写入，见 `submission/dashboardFeed.ts`） |
| 想回滚 | 仅改环境变量 + 保留旧 JSONL 写入旁路（`DASHBOARD_LOG_PATH` 兼容保留 1 个版本，标记 deprecated） |
| 版本裁剪 | 默认只留最近 3 版（`PRUNE_REVISIONS=3`）：收包后删最旧目录与其库行；`r` 编号不重排，故可能出现「有 r4 无 r1」 |
| 数据库备份 | 文件卷 `teaching-data` + `teaching_system.db` 需一起备份；`deploy/DEPLOY.md` 补一条 `pg_dump` 等价说明（SQLite 用 `sqlite3 .backup`） |

---

## 12. 隐私与安全

| 风险 | 处置 |
|---|---|
| 学号/姓名/答案属个人信息 | 上传前在面板底部显示「本次将上传：行为日志 N 行、代码 M 个文件、你的答案 K 条」明确告知；`teaching.uploadConsent` 首次弹确认 |
| 教师路由无鉴权（现状） | **本期不加鉴权（已裁定，列为后续开发）**：`/api/v1/reports/*`、`/api/v1/submissions/bundle` 与现有 teacher 路由一致，仅靠「内网 / nginx 反代不对外暴露 4001」保护。落地时在 `deploy/nginx.conf` 中明确 **不** 反代 `4001`，并在 DEPLOY.md 写一条「生产必须仅内网可达」。`TEACHER_TOKEN` 方案见实施计划 P3 |
| 路径穿越 | `sanitizeSegment()` 只允许 `[A-Za-z0-9._-]`，拒绝 `.`/`..`/绝对路径；所有拼接走 `safeJoin(root, rel)` 并校验 `resolve(rel).startsWith(root)` |
| 上传文件被执行 | 服务端**永不** `require`/`exec` 学生代码；`code/` 目录在静态服务下禁用 `index` 与脚本 MIME（nginx `default_type application/octet-stream`） |
| 日志注入 HTML | 报告页所有文本走 React 默认转义；`inline=1` 预览用 `text/plain` + `X-Content-Type-Options: nosniff` |
| 恶意超大包 | multer `limits` + nginx `client_max_body_size 12m`；解压炸弹无关（不接收压缩包） |
| 学生代码含密钥 | packager 对 `*.env`、`*key*`、`*secret*` 文件名做默认排除；内容正则命中 `sk-[A-Za-z0-9]{20,}` 时**打码**并在 `meta.code.redacted[]` 记录 |

---

## 13. 性能与成本估算

| 项 | 估算 |
|---|---|
| 单包体积 | 日志 ≤ 2 MB（典型 150–400 KB）+ 代码 ≤ 5 MB（典型 20–80 KB）+ meta 10 KB |
| 一学期存储 | 40 学生 × 10 任务 × 2 次提交 × 300 KB ≈ **240 MB**，SQLite 索引 < 5 MB |
| 收包耗时 | 落盘 + 4 表插入 + 指标 HTTP：本机实测目标 < 300 ms（不含网络） |
| 看板读包 | 单次筛选 ≤ 200 包 × 平均 1500 行 = 30 万行 JSON 解析 ≈ 1.2 s，30 s 缓存后 ≈ 0 ms |
| LLM 成本 | 单次生成 ≈ 4k 入 / 0.5k 出 tokens；400 次 ≈ 1.6M 入 tokens（按学生自带额度计，教师不付费） |
| 带宽 | 一次提交 ≈ 400 KB 上传，校园网无压力 |

---

## 14. 验收标准（逐条对应需求）

### 需求 1
- [ ] AC1.1 在**任意**工作区执行 `npx ts-node scripts/analyze-student-log.ts`（不带参），能解析到 `<cwd>/.cline-logs/student_interactions.log` 并输出指标；不再依赖 `D:\cline-test`。
- [ ] AC1.2 带参 `analyze-student-log.ts D:\some\other.log` 分析该文件；文件不存在 → 友好提示 + exit 1（`--strict` 下 exit 2）。
- [ ] AC1.3 扩展提交后，teaching-server 落盘出现 `uploads/submissions/{aid}/{sid}/r1/behavior.jsonl`，行数 = 提交的 `log.line_count`。
- [ ] AC1.4 报告页/看板能按 `assignment_id + student_id` 组合检索到该包；`meta.log.original_path` 是学生机路径且不影响任何分析。
- [ ] AC1.5 同一学生同任务二次提交 → 目录出现 `r2`，库中 `r1.is_current=0`，`r2.is_current=1`，看板数值只反映 `r2`。
- [ ] AC1.6 断言：把 `behavior.jsonl` 里的 `assignment_id` 删掉后，按任务筛选查不到（证明标记确实来自注入而非推断）。

### 需求 2
- [ ] AC2.1 点「提交」后**无任何网络请求**（Charles/代理观察），面板出现 3–5 题；`prepareSubmission` 前后 teaching-server 访问日志为空。
- [ ] AC2.2 代码文件全部出现在包内 `code/`，`submission_files` 行数与之一致，下载后可正常打开。
- [ ] AC2.3 学生在终端跑出 `KeyError: 'name'` 后，`run-traces.jsonl` 出现一条 `exitCode != 0` 记录，且该报错首行出现在生成的思考题题干里。
- [ ] AC2.4 LLM 不可用（断网/无 key）时，面板仍出 3 道模板题，提交成功且 `submission_questions.source='template'`。
- [ ] AC2.5 关闭面板再打开，已填答案不丢（草稿）；「确认提交」后全部内容一次上传（抓包只有 1 个 multipart 请求）。

### 需求 3
- [ ] AC3.1 顶部栏出现「学生实验报告」；只选学生不选任务 → 不显示任何报告（`FILTER_REQUIRED`）。
- [ ] AC3.2 两者都选 → 自上而下依次：报告头 → Q1..Qn（题干 + 考察点 + 答案）→ 代码文件区（含下载）。
- [ ] AC3.3 同学生同任务提交两次 → 页面显示第 2 次内容（`第 2 次提交` 标记），第 1 次不可见。
- [ ] AC3.4 下载 `main.py` 内容与提交前一致（sha256 相符）。
- [ ] AC3.5 未提交该任务的学生不出现在学生下拉中。

### 需求 4
- [ ] AC4.1 顶部栏恰为 4 项：学情画像看板 / 实验任务管理 / 教学资料管理 / 学生实验报告。
- [ ] AC4.2 「实验任务管理」下有且仅有「发布新任务」「管理任务」，点击分别到达原 `AssignmentPublish` 与原 `AssignmentManage`，功能与样式无回归。
- [ ] AC4.3 当前视图在分组下的子项高亮正确；`#/dev-feedback` 隐藏页仍可用。

---

## 15. 测试计划

| 层 | 用例 | 方式 |
|---|---|---|
| 单测 | `resolveDefaultLogPath()` 的 5 级解析链（含旧路径兼容、`--strict`） | vitest，`D:\cline\scripts\__tests__\` |
| 单测 | `SubmissionPackager` 的切片（taskId 过滤/头尾截断/体积丢弃/哈希稳定） | vitest，fixture 造 3000 行 JSONL |
| 单测 | `bundlePaths.sanitizeSegment()` 对抗用例（`../`、`C:\`、`%2e%2e`、中文、超长） | vitest |
| 单测 | `QuestionGenerator` 的 JSON 解析容错（带 ```json 围栏、多余字段、2 条题） | mock LLM |
| 集成 | 上传 → 库 → 报告 API → 下载 全链路 | supertest + 临时 `DATA_DIR`（`fs.mkdtemp`） |
| 集成 | 幂等：同 key 二次上传返回 200 + 同 id，且不新增 revision | supertest |
| 集成 | 并发同学生同任务（`Promise.all` 2 个）→ 一个 201、一个 409 或串行成 r1/r2 | supertest |
| 集成 | 超限：6 MB 日志 / 21 个代码文件 / `.exe` | supertest 断言 413/400/415 |
| 看板 | `LOG_SOURCE=bundles` 下 summary/profile 与 `LOG_SOURCE=file` 指向同一包时数值一致 | node 脚本对比 |
| 手工 | 断网提交、面板中途关闭、重启 VS Code 后草稿恢复 | `manual-test-plan.md` 新增章节 |
| 手工 | 无 shell integration 的旧 VS Code → `run_traces.available=false`，流程不断 | 手工 |

---

## 16. 实施排期

| 阶段 | 内容 | 对应实施计划 | 人日 |
|---|---|---|---|
| S0 骨架 | 契约冻结 + CLI 解析链 + DB 迁移 + `bundleService` + 报告接口 + 扩展 packager/面板（模板题，不依赖 LLM）+ 报告页最小版 + 导航重构 | **P0** | 7.5 |
| S1 本体 | LLM 自适应出题（3/4/5）+ `RunTraceCollector` + 看板 `bundles`/任务筛选 + 幂等与保留 3 版 + 前端增强 | **P1** | 5.5 |
| S2 健壮 | 边界/降级全量（40 条用例）+ 历史迁移脚本 + 部署 env/文档 + 全链路回归 | **P2** | 3 |
| S3 后续 | `TEACHER_TOKEN` 鉴权、对象存储、学期归档、统一命题 | **P3（本期不做）** | — |

依赖：P2 依赖 P1 的「日志定位」语义；P3 依赖 P2 的契约（可先按 §6.2 冻结契约并行）；P4 依赖 P2 的报告接口。
灰度：P2 完成后旧版扩展仍能提交（兼容分支）；P3 只对新版本生效；P5 前 `LOG_SOURCE` 保持 `file`。

---

## 17. 风险与备选

| 风险 | 影响 | 缓解 |
|---|---|---|
| `onDidEndTerminalShellExecution` 在部分环境不可用（现有代码里该监听被注释掉，见 `VscodeTerminalManager.ts:112-121`） | 拿不到 exitCode | 只用 `onDidStart…` + `read()` 流做「有输出即记录」的弱版本；再叠加 opt-in 的提交时执行兜底（D5-2） |
| 学生 LLM 未配置 → 生成失败 | 无题 | 模板题兜底（AC2.4），配置检查前置到「提交」按钮点击时提示 |
| multipart 在弱网下超时 | 提交失败 | `fetchWithRetry` + 60 s 超时 + `idempotency_key` 重试去重 |
| SQLite 并发（teaching-server 写 / backend 读） | `SQLITE_BUSY` | backend 只读连接 + `busy_timeout=5000` + 读文件而非读表；WAL 已开 |
| 老师要求「统一命题」 | D6 的副作用 | 预留 `assignments.fixed_questions`（JSON），存在时跳过生成直接展示 |
| 存储增长 | 卷满 | `PRUNE_REVISIONS=keep3` + 学期末归档脚本（tar 后删目录，索引置 `archived=1`） |

**备选方案（若不允许改数据库）**：完全按 D2 的 A 方案落地——目录树即索引，`reports/filters` 用 `fs.readdir` + 内存 Map（启动时扫一次、写入后增量更新）。功能等价，代价是冷启动扫描与「最新版本」判定靠 mtime 排序（时钟漂移风险）。若日后要上对象存储，只需替换 `fileStore` 与 `bundlePaths`，接口不变。

---

## 18. 附录 A：事件 schema 变更（向后兼容）

```diff
 {
   "ts": "2026-10-20T14:20:03Z",
   "taskId": "01J8…",
   "eventType": "run_result",          // 新增枚举值
   "role": "assistant",
   "category": "debug",
+  "assignment_id": "a3f2c1d4",
+  "student_id": "20231011",
+  "submission_id": 812,
+  "student_meta": { "student_id": "20231011", "student_name": "王小明",
+                    "class_id": "人工智能2023", "assignment_id": "a3f2c1d4" },
+  "run": { "command": "python main.py", "exitCode": 1, "durationMs": 820,
+           "stderrTail": "KeyError: 'name'", "source": "shell_integration" }
 }
```

`analytics.js` 的所有 `switch` 必须对未知 `eventType` 静默忽略（现状已如此，需补一条回归测试）。

## 19. 附录 B：新增/修改文件总览

```
D:\cline
  docs\design\teaching-submission-bundle-design.md      ← 本文
  scripts\analyze-student-log.ts                        M 解析链 + CLI 选项
  src\core\teaching\workspaceLogPath.ts                 M + resolveStudentLogFile()
  src\core\teaching\AssignmentManager.ts                M 拆 prepare/confirm + postBundle
  src\core\teaching\submission\bundleTypes.ts           A
  src\core\teaching\submission\SubmissionPackager.ts    A
  src\core\teaching\submission\RunTraceCollector.ts     A
  src\core\teaching\submission\QuestionGenerator.ts     A
  src\core\teaching\submission\SubmissionDraftStore.ts  A
  src\hosts\vscode\ThinkingQuestionsPanelProvider.ts    A
  webview-ui\src\components\teaching\ThinkingQuestionsForm.tsx  A
  webview-ui\src\components\teaching\AssignmentTab.tsx  M 提交流程两段式
  webview-ui\src\App.tsx                                M 新增 data-view 分支
  package.json                                          M 5 个配置项

D:\web-dashboard
  teaching-server\src\server.ts                         M 挂载 bundle/report 路由 + 迁移调用
  teaching-server\src\submission\bundleService.ts       A
  teaching-server\src\submission\bundlePaths.ts         A
  teaching-server\src\submission\fileStore.ts           A
  teaching-server\src\submission\reportService.ts       A
  teaching-server\src\db\migrations.ts                  A
  teaching-server\scripts\migrate-bundles.ts            A
  backend\src\index.js                                  M LOG_SOURCE 双模式 + assignment_id 筛选 + /analyze
  backend\src\analytics.js                              M + filterByAssignment、run_result 容错
  frontend\src\App.jsx                                  M 导航数据驱动 + report 视图
  frontend\src\components\StudentReport.tsx             A 报告页
  deploy\docker-compose.yml                             M env + 卷（LOG_SOURCE/TEACHER_TOKEN）
  deploy\env\teaching-server.env.example                M 新变量
  docs\design\student-report-design.md                  A 本文镜像/索引（可选）
```

## 20. 已裁定事项（v1.1 变更记录）

| # | 事项 | 裁定 | 落点 |
|---|---|---|---|
| R1 | 思考题数量 | **按学生情况自动 3/4/5，默认 3**；不做统一命题 | §7.3.1 规则、§7.2 配置项 `thinkingQuestionAuto` |
| R2 | 旧版本保留 | **只留最近 3 版**（`PRUNE_REVISIONS=3`），更早目录与库行一并删除，编号不重排 | §5.1、§8.2 `pruneRevisions` |
| R3 | 鉴权 | **本期不加 `TEACHER_TOKEN`**，列为后续（P3）；本期靠「仅内网可达 + nginx 不反代 4001」 | §12、实施计划 P3 |

> 裁定的直接后果：设计里所有「可配置 3~5」的位置统一收敛为「默认 3、自动升到 4/5、上限 5」；测试用例必须覆盖 **3 / 4 / 5 三档都能生成**（判据见实施计划 BN-44~BN-48）。

## 21. 文档版本

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-10-18 | 初版方案（含 A/B/C 三种落库方案对比、契约、验收） |
| v1.1 | 2026-10-18 | 按裁定修订：题数自适应规则（新增 §7.3.1）、保留 3 版、本期不加鉴权；§16 排期改为对应 P0–P3；新增本文档 §20 裁定表 |
| v1.2 | 2026-10-18 | **P0 实现回填**（以代码为准的三处修正）：①§6.1 解析链按实际 6 级重写，删掉「旧固定路径兼容兜底」；②报告接口包装键固化为 `/reports/current → {ok, report}`、`/reports/filters → {ok, assignments, students}`（前端曾误读 `.data` 导致报告永远空）；③前端顶部栏实际用「数据驱动 + 下拉子菜单」实现 4 项，子项复用 `publish`/`manage` 视图键。里程碑与闸门实测见实施计划 §4.1 |
| v1.3 | 2026-10-18 | **P1 实现回填**：①看板数据源改为 **teaching-server 写 `<DATA_DIR>/dashboard/student_interactions.jsonl` + backend `LOG_SOURCE=bundles` 只读该文件**（否决让 backend 直连 SQLite：多一个驱动依赖、且需在容器间共享库文件）；②`meta` 新增 `source`/`emptyReason`/`assignmentFilter`/`totalLogCount`，bundles 模式**不回退 sample 日志**；③运行痕迹落 `.cline-logs/run_traces.jsonl`（非设计稿的 `run-traces.jsonl`），且缺 `onDidEndTerminalShellExecution` 时整体不采集；④版本裁剪在 `COMMIT` 后执行并显式按子表删（sqlite3 默认不开 `foreign_keys`）；⑤教学端新增 `dashboardFeed.ts`、`revisionPruner.ts`，前端看板新增任务下拉与两态空态。闸门实测见实施计划 §5.1 |
| v1.4 | 2026-10-18 | **P2 实现回填**：①`req.destroyed` 不能用来判断「客户端已断开」（Node 在请求体读完后就置 true，曾导致**所有提交无响应**），改用 `res.writableEnded \|\| res.destroyed \|\| req.aborted`；②契约 v2：`run_traces` 统一为数组（原教学端写 `{available,count,items}` 导致运行次数恒 0），`log` 增 `bad_lines`/`slice_missing`，报告增 `unsaved_files` 与 `files[].missing`；③schema v2 新增 4 列；④采集侧新增 `logSlicer.ts`（2MB 切片、保留最新 taskId、绝不切半行）与 `secrets.ts`（三类密钥打码）；⑤并发改为**同学生同任务串行**（不再 409）；⑥看板新增 `DASHBOARD_MAX_EVENTS` 与 `emptyReason=out_of_range`；⑦部署补 `PRUNE_REVISIONS`/`DASHBOARD_MAX_EVENTS`、`env/teaching-server.env.example`、`DEPLOY.md` §3.3.1 与端口暴露告警；⑧新增人工验收单 `docs/manual-test-plan.md`（M-01~M-65） |
| v1.5 | 2026-10-19 | **出题模型来源修正**：§7.3 增「模型来源」裁定——直接复用 Cline 自带设置的 `actModeApiProvider` / `actModeApiModelId` 与对应 API Key（经 `StateManager.getApiConfiguration()` + `buildApiHandler`），**不需要工作区 `.env`、也不再有独立 key 输入框**；早期代码误读不存在的 `config.apiProvider` 导致出题恒降级为模板题，已修复（`submission/questionLLM.ts` + 12 条单测） |

实施顺序、任务拆解、边界测试矩阵见 **[teaching-submission-implementation-plan.md](./teaching-submission-implementation-plan.md)**。
