# 教学提交包功能 — 人工验收手册

> 适用版本：提交包 v1（schema `submission-bundle/v1`），含 P0/P1/P2 全部交付物。
> 覆盖：日志路径解析、两段式提交（先出题后上传）、思考题作答、教学端入库与报告、看板接入、健壮性降级。
> 自动化闸门见 `D:\cline\docs\design\teaching-submission-implementation-plan.md` §4.1/§5.1/§6.1，本手册只写**必须人看**的部分。

## 0. 环境准备

```powershell
# 1) 起教学端（用独立数据目录，避免污染真实库）
cd D:\web-dashboard\teaching-server
$env:DATA_DIR='D:\web-dashboard\teaching-server\.manual-data'
$env:PORT='4001'
npx tsx src/server.ts

# 2) 起看板后端（bundles 模式，指向同一个数据目录）
cd D:\web-dashboard\backend
$env:LOG_SOURCE='bundles'
$env:TEACHING_LOG_PATH='D:\web-dashboard\teaching-server\.manual-data\dashboard\student_interactions.jsonl'
$env:TEACHING_API_BASE='http://127.0.0.1:4001'
$env:PORT='4000'
node src/index.js

# 3) 起前端（开发态，反代走 vite 代理或直连 4001/4000）
cd D:\web-dashboard\frontend
npm run dev
```

准备一个学生工作区（例如 `D:\manual-ws`），里面有：
- `main.py`（≥40 行，能跑）
- `.cline-logs\student_interactions.log`（用真实 Cline 会话产生，或从 `D:\cline-test\.cline-logs\student_interactions.log` 拷一份）
- 一个 `.env`（含 `API_KEY=sk-test-xxx`，用于验打码）

在 VS Code 里**打开该工作区**（不是 `D:\cline`），按 `F1` → `Cline: 打开实验任务`，先填学生信息（学号/姓名/班级）。

---

## 1. 采集侧（扩展）

| 编号 | 用例 | 步骤 | 期望 |
|---|---|---|---|
| M-01 | 日志按工作区找 | 在 `D:\manual-ws` 打开 Cline 面板，点「提交实验任务」 | 提示里日志行数 > 0；面板 chips 显示「日志 N 行」；**不是** `D:\cline-test` 的数据 |
| M-02 | 目录无日志 | 删掉 `D:\manual-ws\.cline-logs\student_interactions.log`，再提交 | 面板照常打开，warning 提示「未找到行为日志，本次只上传代码与答案」；**不报错、不中断**（BN-01） |
| M-03 | 目录无代码文件 | 工作区只留 `.png`/`.bin`，提交 | 面板 chips 代码文件 0；上传成功；报告页 `files` 为空且有「本次未上传代码文件」文案（BN-09） |
| M-04 | 代码过大 | 造一个 1.5 MB 的 `.py` | 该文件被跳过；面板 chips 无它；报告页文件列表不含它（BN-10） |
| M-05 | 密钥打码 | `.env` 里写 `API_KEY=sk-live-abcdefgh12345678`；`main.py` 里写 `token = "ghp_aaaaaaaaaaaaaaaaaaaa"` | 面板 chips 显示「🔒 已打码 N 处」；下载回去的两个文件里对应值是 `***REDACTED***`，**键名保留**（BN-16） |
| M-06 | 未保存缓冲区 | 在 `main.py` 里改一行**不保存**，直接提交 | 面板 chips 显示「💾 未保存 1 个」；下载回去的文件含这行未保存的改动（BN-14） |
| M-07 | 日志切片 | 把日志手工撑到 > 2 MB（复制事件行） | 上传成功；报告页「日志行数」明显小于原始行数但含最近事件；`log.truncated=true`（BN-11） |
| M-08 | 运行痕迹 | 在 VS Code 终端跑 `python main.py`（先让它报错），再跑一次成功；然后提交 | 面板 chips「运行痕迹 ≥ 2」；报告页有运行次数；LLM 出的题里会提到具体报错（BN-12，需 `teaching.thinkingQuestionAuto` 开） |

## 2. 两段式与出题

| 编号 | 用例 | 步骤 | 期望 |
|---|---|---|---|
| M-10 | 先出题后上传 | 点提交后**先看网络**（教学端日志应无 POST） | 面板打开前教学端无 `/submissions/bundle` 请求；**只有点确认才上传**（G1 核心约束） |
| M-11 | LLM 出题 | 正常提交（配了 LLM key） | 面板 chips 显示「🧠 模型出题」；3~5 题，题目引用了学生代码里的标识符/报错（Q-1~Q-3） |
| M-12 | 无模型回退 | 清空 `TEACHING_LLM_API_KEY` 或断网后提交 | chips「🧩 通用题」+ 提示「当前没有可用的模型配置，已使用通用思考题」；面板**仍可用**（Q-8） |
| M-13 | 题数自适应 | ①只写 5 行且没运行 → 3 题；②120 行、3 文件、跑 5 次、错 3 次 → 5 题；③`teaching.thinkingQuestionCount=4` 且 `thinkingQuestionAuto=false` → 恒 4 题 | 与设计文档 §7.3.1 一致（Q-1~Q-4） |
| M-14 | 缺答案不能交 | 只填 1 题就点确认 | 按钮置灰或提示「第 N 题还没作答」；**不发请求**（BN-05） |
| M-15 | 取消 | 面板里点取消/关面板 | 不上传；pending 清空；再点提交能重新走一遍（M-10 可复现） |
| M-16 | 网络失败可重试 | 停掉教学端，点确认 | 提示「无法连接教师端…」；pending **不丢**；重启服务后再点确认成功（P2-2） |

## 3. 教学端入库

| 编号 | 用例 | 步骤 | 期望 |
|---|---|---|---|
| M-20 | 落盘结构 | 提交一次后看 `DATA_DIR\uploads\submissions\<任务id>\<学号>\r1\` | 有 `behavior.jsonl`、`manifest.json`、`code\01__main.py`；目录名带任务 id 与学号（需求 1 核心） |
| M-21 | 重复提交 | 同一学生同一任务再提交一次 | `r2` 新增；`submissions` 里只有 `r2` 的 `is_current=1`；报告页只显示最新（BN-06/BN-07） |
| M-22 | 版本裁剪 | 连提 4 次（`PRUNE_REVISIONS=3`） | 磁盘只剩 `r2/r3/r4`；库里只剩 3 行；响应 `warnings` 含「只保留最近 3 版」（BN-24） |
| M-23 | 幂等 | 直接重放同一个 `idempotency_key`（用 `scripts/smoke-bundle.mjs` 的模式） | 返回 `deduplicated=true`，不新增 revision（ID-1） |
| M-24 | 并发 | 同一学生同一任务两个终端同时提交 | 两条都 201，revision 分别为 N+1/N+2，**不出现 500 / 只有一条 current**（BN-20） |
| M-25 | 入库失败回滚 | 把 `DATA_DIR` 设成只读目录后提交 | 返回 `INGEST_FAILED`；`uploads` 下**不留** `r<N>` 空壳；库里无行（BN-23） |
| M-26 | 老库升级 | 用一份 P0 之前的库（9 列 submissions）启动 | 启动日志出现「迁移：submissions schema v0 → v2」；老行有 `revision=1`，同组只留最新 `is_current=1` |

## 4. 前端（教学端页面）

| 编号 | 用例 | 步骤 | 期望 |
|---|---|---|---|
| M-30 | 顶部栏四项 | 打开首页 | 正好 4 项：「📊 学情画像看板」「🧪 实验任务管理」「📚 教学资料管理」「📄 学生实验报告」；前两项之外无多余入口 |
| M-31 | 子菜单 | 点「🧪 实验任务管理」 | 展开「📝 发布新任务」「🗂 管理任务」；点父项本身也能进第一个子项；子项高亮时父项也高亮 |
| M-32 | 发布/管理仍可用 | 分别进两个子项 | 页面与改版前一致（零回归） |
| M-33 | 必须双筛 | 进「学生实验报告」，只选学生 | **不显示**任何报告，只有提示「请同时选择学生与实验任务」 |
| M-34 | 报告内容 | 同时选学生 + 任务 | 从上到下：基本信息（含「第 N 版（最新）」）→ 思考题（题面 + 学生答案原文 + 难度标签）→ 代码文件列表 + 下载按钮 |
| M-35 | 未作答 | 某题没答就提交（用 M-14 绕过或直接调接口） | 该题显示「（学生未作答）」灰字，不崩（BN-06） |
| M-36 | 无提交 | 选一个没提交过的学生+任务 | Empty 提示「该学生尚未提交该实验任务…」，**不是**错误弹窗（BN-13/BN-33） |
| M-37 | 下载 | 点代码文件「下载」 | 文件名是原始名（无 `NN__` 前缀）、内容与工作区一致、中文名不乱码（BN-08） |
| M-38 | 文件缺失 | 手工删掉 `r<N>\code\01__main.py` 后刷新报告 | 该行显示红色「文件缺失」且**隐藏下载按钮**，其它内容照常（BN-38） |
| M-39 | 坏日志行 | 日志里掺 2 行乱码后提交 | 基本信息出现橙色「2 行无法解析」提示；报告其余部分正常（BN-04） |
| M-40 | 未保存标记 | 用 M-06 的提交 | 报告页出现「含未保存的编辑器修改」提示（BN-14） |

## 5. 看板接入

| 编号 | 用例 | 步骤 | 期望 |
|---|---|---|---|
| M-50 | bundles 数据源 | 提交后进「学情画像看板」 | 有数据；`meta.source === "bundles"`（F12 看 `/api/dashboard/summary` 响应） |
| M-51 | 空库 | 全部清空 `DATA_DIR\dashboard` 后刷新 | 显示「还没有任何提交」而不是「日志有 0 行」；`emptyReason=no_submissions`（BN-35） |
| M-52 | 按任务筛 | 看板任务下拉选某个任务 | 只统计该任务的提交；meta 里 `assignmentFilter` 正确 |
| M-53 | 筛选过空 | 选一个学生+一个他没提交的任务 | `emptyReason=filtered_out`，前端有区分文案（BN-39） |
| M-54 | 时间过滤过空 | 不选学生，`days=1` 但没有今天的提交 | `emptyReason=out_of_range`（P2-5 新增） |
| M-55 | 事件上限 | `DASHBOARD_MAX_EVENTS=10` 起 backend，提交 30 条事件 | 看板提示「统计基于最近 10 条」；`meta.truncated=true` |
| M-56 | file 模式不坏 | `LOG_SOURCE=file` + 指向旧 jsonl | 旧行为完全不变（回归保护） |

## 6. CLI（需求 1 前半）

| 编号 | 用例 | 命令 | 期望 |
|---|---|---|---|
| M-60 | 默认路径 | `cd D:\manual-ws; node D:\cline\scripts\analyze-student-log.ts` | 「路径来源：当前工作目录」，分析该工作区日志，exit 0 |
| M-61 | 显式路径 | 同上 + `--log D:\cline-test\.cline-logs\student_interactions.log` | 「路径来源：命令行参数」，exit 0 |
| M-62 | 子目录回溯 | `cd D:\manual-ws\src; node ...` | 「路径来源：当前目录的上级工作区」，exit 0 |
| M-63 | 无日志 | 在空目录跑 | exit 1，打印缺失路径 |
| M-64 | 空日志严格模式 | 0 字节日志 + `--strict` | exit 2 |
| M-65 | 参数错 | `--bogus` | exit 3 + 用法提示 |

---

## 7. 通过标准

- 上表 **M-10、M-20、M-21、M-33、M-34、M-37** 任一失败即视为不可上线（核心链路）。
- M-02 / M-03 / M-13 / M-36 / M-52 失败可降级发布，但需在实施计划 §11 风险表登记。
- 自动化闸门必须先全绿，再跑本手册；本手册结果记到 `docs/manual-test-plan-results.md`（含日期、执行人、截图路径）。
