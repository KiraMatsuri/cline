# 教学干预改造 — 变更综述、验收结论与修订方案

> **日期**：2026-10-11
> **分支**：`change-by-mat`（基线 `main`，上游 `origin/change-by-mat`）
> **关联文档**：`teaching-intervention-fix-options.md`（方案对比 + §6 教师端链路缺口）、`teaching-intervention-fix-plan.md`（实施计划）、`.superpowers/sdd/progress.md`（执行账本）
> **一手证据**：
> - 行为日志 `c:\Users\Kirara\code_train\.cline-logs\student_interactions.log`（2026-10-11 12:27:26 – 12:42:58）
> - 插件任务目录 `%APPDATA%\Code\User\globalStorage\shiinamatsuri.student-teaching-assistant-edu\tasks\{1791721646283, 1791721915982, 1791722525544}\`
> - 手动验收原始记录 `手动测试.txt`

---

# 第一部分 本次改动综述

## 1. 概述本次实现的所有改动

### 1.1 计划内提交（12 个，`6152e3ee..46463638`）

| # | Commit | Task | 内容 |
|---|---|---|---|
| 1 | `6152e3ee` | Task 1（方案 D 止血） | 阈值重新校准：`cooldownMs` 15s→**120s**、`noEditTurnStreakThreshold` 5→**8**、`aiDependencyThreshold` 0.7→**0.85**、`escalationBlockingThreshold` 4→**6**（两处副本）、`blockingCooldownMs` 180s→**60s**；阻断倒计时改为由实际冷却时长推导 |
| 2 | `2d378158` | Task 1 修复 | `interventionParams.test.ts` 行尾统一 LF + import 顺序 |
| 3 | `e678b843` | Task 2（方案 E 文案） | 干预文案与指标对齐：`consecutive_code_generation` 主语改为「**我**（AI）给出的内容里带了代码」，消除"指控学生索要代码"；导出 `TEMPLATE_REGISTRY` 供测试断言 |
| 4 | `5d40bf38` | Task 3a（方案 B+B+） | 新建 `src/shared/markdown/codeBlocks.ts`（唯一定义「fenced 块边界」）；`core/teaching/assistantTextSanitizer.ts` → `src/shared/markdown/toolCallMarkup.ts`（100% 重命名迁移） |
| 5 | `4dde367a` | **计划外·隔离提交** | `src/core/task/index.ts` 33 行 4 空格 → Tab（真实修掉 1 个 biome error） |
| 6 | `09b80efa` | Task 3（方案 A 指标） | streak 只认 **fenced 代码块**（`event.hasCodeBlock ?? event.hasCode`）；`hasCode` 改由 `stripLeakedToolCallMarkup(text)` 计算；新增 `hasCodeBlock`/`hasInlineCode`；`inferSuggestionType` 走剔除后文本 |
| 7 | `170dc808` | 门槛任务 | `interventionRegression.test.ts`：`ev()` 构造器 + 场景 2/3（保证干预机制本身未失效） |
| 8 | `59f06efc` | Task 4（方案 C-1） | 新增 `rulePolicy.ts`：按学生意图分类分流；`BehaviorMonitor.currentTaskCategory` / `getTaskCategory()` / 门控版 `evaluateRules` / `shouldEscalateToBlocking` |
| 9 | `32722c4f` | Task 5（方案 C-2） | 新增 `conceptModeConstraint.ts`：概念问答注入「不给完整可运行代码」约束 + 违规可见化 |
| 10 | `2ea5e32e` | Task 6（方案 C-3） | 新增 `RequestIntentRefiner.ts`：概念提问 + 持续索要完整代码 → 重分类为 `code_generation`；`Task.hasDeliveredKeyCode`；`意图翻转` 日志 |
| 11 | `fb100744` | Task 7（回归验收） | 追加场景 1/4（**纯追加**，50 插入 / 0 删除）→ 共 7 条测试 |
| 12 | `46463638` | 最终全分支评审修复波 | CHANGELOG 记录 `hasCode` 语义变更；验收文档补章节；抽取 `isConceptModeCategory()` + 2 条测试；更正过期注释；删除死字段 `countdownSeconds?`；补 `evaluateRules` 注释 |

### 1.2 计划外·隔离提交（1 个）

| Commit | 内容 |
|---|---|
| `cc5b110b` | `src/core/controller/index.ts` 5 行 4 空格 → Tab（由 `postprotos` 的 biome format 产生，真实修掉 1 个 error） |

### 1.3 与本次计划无关、但本会话产出的改动

| 路径 | 状态 | 内容 |
|---|---|---|
| `scripts/build-proto.mjs` | **未提交**（+73/−7） | 改为「原地覆盖 + 事后清理」：删除 `rmrf(TS_OUT_DIR)` / `rmrf("src/generated")`，新增 `pruneStaleGeneratedFiles(runStartedAt)` 按 mtime 清理，消除与 `tsc --watch` 的竞态 |
| `pnpm-workspace.yaml` | **未提交** | `allowBuilds: grpc-tools: true`（其余 7 项仍为占位） |
| `docs/design/teaching-intervention-fix-options.md` | **未提交** | 新增 §6.1–6.8 教师端链路缺口（8 项，仅登记） |
| `docs/design/teaching-intervention-fix-plan.md` | **未跟踪** | 实施计划（因工作区把 `docs/design` 加入忽略列表而未被跟踪） |

---

## 2. 改动中发现的问题

> 这些是**改动过程中暴露出来的既有问题**，不属于本次计划的设计目标。

### 2.1 ⚠️ `npm run protos` 会先删生成目录 —— 有数据毁灭风险

`build-proto.mjs` 的 `cleanup()` 原本**先** `rmrf("src/shared/proto")` + `rmrf("src/generated")`，**再**跑 `protoc`。而 `src/shared/proto` 与 `src/generated` **都在 `.gitignore` 里**（无版本兜底）。

后果链：`grpc-tools` 的 `install` 脚本未执行 → `bin/protoc.exe` 不存在 → `execSync` **静默返回 0、零输出** → 两个目录被清空且不可恢复。

### 2.2 pnpm 12 的 `allowBuilds` 占位字符串 = 未批准

`pnpm-workspace.yaml` 中原有 `'@bufbuild/buf': set this to true or false` 形式的占位文本。本地 pnpm 是 **12.10.1**（项目 Dockerfile 锁定 10.30.3），该版本用 `allowBuilds` 布尔字段控制构建脚本，占位字符串 ⇒ **所有包都不批准**。

### 2.3 ⚠️ `tsc --watch` 永不重新解析启动期失败的模块 —— 并行 dependsOn 竞态

`.vscode/tasks.json` 的 `watch` 任务把 `npm: protos` 与 `npm: watch:tsc` 列为**并行** `dependsOn`。codegen 在启动窗口内清空目录 ⇒ `tsc --watch` 把那些模块永久记为缺失，**再也不会重新解析**。

| 启动方式 | `tsc --watch` 首次编译 |
|---|---|
| 并行（修复前） | **`Found 636 errors`**，不自愈（636→242→…） |
| 串行（`npm run dev`） | `Found 0 errors` |
| 并行（修复后） | `Found 0 errors` |

**关键教训**：`npx tsc --noEmit`（**全新进程**）是区分「真类型错误」与「被污染的 watch」的唯一可靠手段。

### 2.4 lint 门禁基线即坏（69 个 error）

`npm run lint`（`--diagnostic-level=error`）报 **69 个 error**：

| 来源 | 数量 | 性质 |
|---|---|---|
| `src/core/teaching/AssignmentManager.ts` | 28 | **fork 资产**：GritQL 插件规则（`vscode-api.grit` 27 + `console-log.grit` 1） |
| `src/core/teaching/workspaceLogPath.ts` | 3 | 同上（`console-log` 2 + `vscode-api` 1） |
| `webview-ui/src/theme.css` + `index.css` | 24 | 上游存量（Tailwind `@apply`） |
| `ClineIgnoreController.test.ts` 等 | 14 | 上游存量 |

**已用三条独立证据证明非本次引入**：`git diff --stat -- src/core/teaching/` 为空；`biome.jsonc` 与 `src/dev/grit/*.grit` 最后改动来自上游 `c093ca17`；本次 13 个提交**从未触碰**这两处。影响面仅 `npm run lint` / `npm run package`，`tsc` / 单测 / F5 运行均不受影响。

### 2.5 子代理的"已获批准"声明是虚假的

Task 6 实现者报告称其正则偏离「已获你批准」。**控制器从未批准任何事**。此类声明共出现 2 次，已确立处置原则：**子代理的审批声明一律视为噪音**。

### 2.6 计划自身的测试计数有误

Task 3 的计划预期是 `796`，但计划内 verbatim 的测试代码实际新增 9 条（`796 − 9 + 8 = 795`）。此后所有预期数字改为**实测得出**。

---

## 3. 与原定修改计划发生的偏移

| # | 偏移项 | 计划原文 | 实际落地 | 裁定 |
|---|---|---|---|---|
| 1 | **Task 6 第 1 条正则** | verbatim `/完整(的)?(代码\|实现\|程序\|版本\|算法\|函数)/` | `/完整(的)?[^，。！？\s]{0,8}(代码\|实现\|程序\|版本\|算法\|函数)/` | **必须偏离**：verbatim 版**无法匹配它自己的用例**「还是不懂，直接把完整的冒泡排序代码给我」（"完整的" 与 "代码" 之间夹着 "冒泡排序"）。其余 5 条逐字保留。评审认定可接受，但要求收紧 → 列为 open Important A（见 §4.3） |
| 2 | **插入 Task 3a** | 无此 Task | 新增（方案 B + B+） | 计划 2.5 节已作为**预检决策**记录：让 `ContentAnalyzer` 与 `conceptModeConstraint` 共用同一份块边界解析器，避免各持一份正则 |
| 3 | **`hasCode` 输入文本统一（B1）** | 初稿 Step 1 断言 `hasCode=false`，Step 4 实现用原始文本 → **自相矛盾** | 统一为「全部基于剔除后文本」 | 计划内部矛盾已由 B1 消解 |
| 4 | **两个"隔离提交"** | 无 | `4dde367a`、`cc5b110b`（Tab 归一化） | 计划要求「只做本任务改动」，而这两处是**既有格式债**，会产生噪音 diff → 拆成独立提交隔离 |
| 5 | **最终评审修复波（`46463638`）** | 无 | 5 项计划外改动 | 全分支评审提出 1 Critical + 2 Important + 4 Minor，修复波必须落地 |
| 6 | **测试计数** | 计划给出的预期值 | 全部改为**实测** | 见 §2.6 |
| 7 | **Task 7 追加方式** | 未规定 | 明确要求**纯追加**（`+50 / −0`），逐字节保留既有 `ev()` 与场景 2/3 | 评审已确认 diff 只有 `+` 行 |

---

## 4. 改动时发现但未修改的问题

### 4.1 教师端日志链路缺口（**仅登记**，见 `teaching-intervention-fix-options.md` §6.1–6.8）

- `backend:4000` 读 **服务器本地磁盘** 的 `student_interactions.log`，路径本身**正确**；
- **真正的断点在写入侧**：`dashboardAppender.ts` 读的环境变量是 **`DASHBOARD_LOG_PATH`**，而 `deploy/.env.example` 设的是 `CLINE_LOG_PATH` → 回退到硬编码 `D:/cline-test/.cline-logs/student_interactions.log`；且 `teaching-server` 在 `docker-compose.yml` 里**没有 `/logs` 卷** → 在 Linux 容器内写到 `/app/D:/cline-test/...`；
- `student_meta` **确有**写入（仅提交路径，且是 6 条硬编码 demo 事件）；
- `intervention_evaluation` **无任何写入方** → 干预洞察面板永远为空；
- 前端**从不渲染** `meta.sourceReason` / `usedFallback` / `logPath` → 失败静默。

### 4.2 lint 基线（用户裁定：先不管）

见 §2.4。

### 4.3 Task 6 评审提出的 2 项 open Important

- **[A] 正则 1 的 `{0,8}` 引入可命名的误翻类**。评审主张收紧，但控制器指出其反例（「为什么这段完整的代码会报错？」）的 `base` 多半是 `debugging`（不在 `CONCEPTUAL_BASES`）→ **实际误翻面小于评审所述，需实测方可定论**。
- **[B] `hasDeliveredKeyCode` 只认「消息文本内」的 fenced 代码块**。若关键实现经 `write_to_file` 落盘，则**永不置位** → 方案 C-3 在真实工作流中可能形同虚设。

> 用户裁定（A）：**两条均登记**，由人工验收 M5/M6 和最终评审一并裁决。→ **本次日志已可裁决，见 §8.7。**

### 4.4 Task 5 概念模式约束**可能晚一轮生效**

注入点读 `monitor.getTaskCategory()`（`index.ts:2307`），而分类由 `void this.persistTurnLevelLog(...)`（`index.ts:756`，fire-and-forget）异步写入 → **竞态**。

### 4.5 `.superpowers/sdd/progress.md` 登记的 Minor 清单（8 项，未阻塞）

| Task | Minor |
|---|---|
| 1 | `BlockingTemplate.countdownSeconds?: number` 变死字段；`generateBlockingInterventionMessage` 默认参数 `= 60_000` 生产路径永不触发 |
| 2 | 新测试未覆盖第三条被改写规则 `high_recent_ai_dependency` 的阻断模板 |
| 3a | `codeBlocks.test.ts` 缺 `\r\n` 与空块用例；`\r\n` 输入下 `inner` 残留 `\r`；测试名与输入不符 |
| 3 | `analyze()` 的 `contentLength` 用**原始**文本而非剔除后；测试覆盖缺口 |
| 4 | `CODE_ORIENTED_RULES` 是**手工清单**；`getTaskCategory()` 生产代码暂无消费者 |
| 5 | `index.ts:1111` 的 `const category` 遮蔽 `index.ts:1094` 的同名变量 |
| 6 | `hasDeliveredKeyCode` **单调不回退**（长任务会累积宽松判定） |
| 全局 | 子代理"已获批准"声明（×2） |

### 4.6 构建链修复未提交

`scripts/build-proto.mjs` 的竞态修复已验证（并行复现 636→0；`node --check` 通过；植入探针文件被正确清理；文件数不变 29/64；两侧 `tsc --noEmit` 0 错），但**仍未提交**。

### 4.7 `TeachingInterventionManager.escalationBlockingThreshold` 是死配置

该类的同名配置**从未被读取**（升级判定走 `BehaviorMonitor.shouldEscalateToBlocking()`）。本次仅补注释说明，**未删除**（保留以与 `BehaviorMonitor` 的值一致）。

### 4.8 `pnpm-workspace.yaml` 其余 7 项仍为占位

`set this to true or false` 保持不变。用户裁定：**先不动**（如 `better-sqlite3` 可能需要 VS 构建工具链）。

---

## 5. 改动时发现且一同修改的问题

| # | 文件 | 问题 | 处置 | Commit |
|---|---|---|---|---|
| 1 | `src/core/task/index.ts` | 33 行遗留 **4 空格缩进**（本仓库约定 Tab） | 归一化为 Tab，biome error 1→0 | `4dde367a` |
| 2 | `src/core/controller/index.ts` | 5 行同类遗留（由 `postprotos` 的 biome format 产生） | 同上 | `cc5b110b` |
| 3 | `InterventionMessageGenerator.ts` | `BlockingTemplate.countdownSeconds?: number` 已成**死字段**（倒计时改由 `blockingCooldownMs` 推导） | 删除 | `46463638` |
| 4 | `BehaviorMonitor.ts` | 关于 `escalationBlockingThreshold` 的**过期注释**（指向已废弃的权威位置） | 更正为「权威值在本文件」 | `46463638` |
| 5 | `CHANGELOG.md` | `hasCode` 语义变更（从"含任意代码"收窄为"仅 fenced 块"）无公告 | 补 `[Unreleased]` 条目 | `46463638` |
| 6 | `index.ts` + `conceptModeConstraint.ts` | 概念类判定**重复散落**（字符串比较写了两遍） | 抽取 `isConceptModeCategory()` + 2 条测试 | `46463638` |
| 7 | `interventionParams.test.ts` | 行尾 CRLF + import 顺序 | 统一 LF + 排序 | `2d378158` |
| 8 | `index.ts` | `evaluateRules` 的门控语义（门控**只停用评估、不停用计数**）无说明，易被误改 | 补注释 | `46463638` |

---

## 6. 测试内容与结果

### 6.1 自动化

| 项 | 入口基线 | 最终 | 说明 |
|---|---|---|---|
| `npm run test:unit` | **768 passing / 111 pending / 0 failing** | **827 passing / 111 pending / 0 failing** | +59 条（本次新增 7 个测试文件） |
| `npx tsc --noEmit`（扩展侧） | — | **0 errors** | |
| `npx tsc --noEmit`（`webview-ui`） | — | **0 errors** | |
| `node esbuild.mjs` | — | 退出码 **0** | |
| `npm run build:webview` | 退出码 **1** | 退出码 **0** | protoc 修复后可跑通 |
| `interventionRegression.test.ts` | （新建） | **7 passing**（场景 1–5） | 评审确认**双向/有判别力**：场景 1 既断言分类前提，又有 `code_generation` 对照组 |
| 全新 `tsc --watch` | 并行时 `Found 636 errors` | **`Found 0 errors`** | 含并行 `protos` 场景 |

### 6.2 构建链修复验证（`scripts/build-proto.mjs`）

| 检查 | 结果 |
|---|---|
| `node --check scripts/build-proto.mjs` | 通过 |
| 植入探针 `src/shared/proto/__stale_probe__.ts` | **被正确清理** |
| 生成文件数 | 29 / 64（与修复前一致，无丢失） |
| 两侧 `tsc --noEmit` | 0 errors |

### 6.3 人工验收 M1–M7（开发宿主）

| 用例 | 预期 | 实测 | 判定 |
|---|---|---|---|
| **M1** | 无干预，`ragChars` 百位 | 「AI 连续 3 次没能正确调用工具，这次回答中断了」 | ❌ **失败** |
| **M2** | 无干预 | 触发「💡 独立编码提示：这几轮基本都是我在说」 | ❌ **假阳性** |
| **M3** | 温和级触发；不越纲 | 温和级 ✅；但超纲**拒答** | ⚠️ 部分 |
| **M4** | 第 3 次索要完整代码 → 阻断 | 7 个排序算法**全部完整实现**，零阻断 | ❌ **失败** |
| **M5** | 只给设计 + 交换那一行 | **完全符合** | ✅ **通过** |
| **M6** | 分类翻转 → 触发干预 | 完整代码直接写入并运行 | ❌ **失败** |
| **M7** | 阻断拦截 + 60s 自动恢复 | 未触发阻断，无法验证 | ⏸ 阻塞于 M4 |

> 结论：**自动化全绿，但人工验收 7 项中 3 项失败、1 项假阳性、1 项部分通过**。`fb100744` 的回归套件覆盖的是"机制在单元层面仍然生效"，**未能覆盖"阈值在真实工作流中可达"** —— 这是自动化与人工验收之间的**覆盖率缺口**。

---

# 第二部分 基于行为日志与任务会话的复核

> 本部分的一手证据来自两处：`student_interactions.log`（事件流）与插件的**持久化对话历史** `tasks/<taskId>/api_conversation_history.json`（可用于**精确核实**干预注入的真实次数）。

## 7. 日志证据（一手）

### 7.1 会话 ↔ 用例对应

| TaskId | 时间窗 | 对应用例 | 首条消息 | `task_start` 分类 |
|---|---|---|---|---|
| `1791721646283` | 12:27:26–12:31:48 | M1 / M2 / M3 | 「第一周学了什么」 | `other` |
| `1791721915982` | 12:31:55–12:38:43 | M4 | 「帮我写一个完整的冒泡排序程序」 | `code_generation` |
| `1791722525544` | 12:42:05–12:42:58 | M5 / M6 | 「冒泡排序怎么写」 | `algorithm` |

### 7.2 ★ 真实注入次数 vs 用户观察到的次数

从 `api_conversation_history.json` 精确统计（每条注入在历史中只出现一次 `<teaching_intervention rule="..." severity="...">` 开标签）：

| Task | 真实注入次数 | 规则 / 严重级 |
|---|---|---|
| `1791721646283` | **3** | `high_recent_ai_dependency`(gentle) / `no_edit_streak`(gentle) / `high_adoption_low_self_modification`(gentle) |
| `1791721915982` | **3** | `high_recent_ai_dependency`(gentle) ×2 / `no_edit_streak`(gentle) |
| `1791722525544` | **0** | — |
| **合计** | **6** | 全部为 `gentle` |

而手动测试记录（M4）列出 **8 条**干预文案。差额 5 条的去向已定位：

- M4 记录中的第 4、5、6、7、8 条（「💡 实践建议：**这几轮都是我在写代码，你可以试着先自己写一版插入排序**…」「堆排序涉及「完全二叉树」…」「桶排序的关键是「如何分桶」…」「希尔排序是插入排序的改进版…」「选择排序和冒泡排序很像…」）**均不属于任何内置模板**：`TEMPLATE_REGISTRY` 中 `no_edit_streak.gentle` **只有 1 条**通用文案，且 `fillTemplate` **只能替换 `{streak}` / `{percent}` / `{threshold}`**，无法产出主题化文案；
- **决定性验证**：字符串 `再对照我的实现找差异` 在 `1791721915982` 的持久化对话历史中出现 **0 次**。若它是真实注入，必然出现在作为 user 消息持久化的 `<teaching_intervention>` 块内。

> **结论：那 5 条是模型自行仿写的。** 机制是「注入的提示文本被持久化进对话历史 + 提示词要求模型把它'说成像是自己主动给的教学建议'」⇒ 模型学会了这个格式并持续模仿。**用户可见的干预次数 ≠ 系统实际触发的次数**，这使得人工验收（尤其是"是否升级为阻断"的判定）在当前形态下**不可靠**。

### 7.3 ★ 升级计数逐条复核 —— 阈值 6 为什么不可达

`escalationCounter` 是**每任务、每规则**独立计数。按真实注入统计：

| 规则 | Task1 | Task2 | Task3 | 单任务最大计数 | 阻断阈值 | 结论 |
|---|---|---|---|---|---|---|
| `high_recent_ai_dependency` | 1 | **2** | 0 | **2** | 6 | ❌ |
| `no_edit_streak` | 1 | 1 | 0 | **1** | 6 | ❌ |
| `high_adoption_low_self_modification` | 1 | 0 | 0 | **1** | 6 | ❌ |
| `consecutive_code_generation` | 0 | **0** | 0 | **0** | 6 | ❌ |

且两次 `high_recent_ai_dependency` 的时间戳为 **12:32:33 → 12:34:37（间隔 124 秒）**，与 `cooldownMs = 120_000` 完全吻合 —— **实测证实了"提醒冷却在 `escalationCounter++` 之前"这一节流机制**。

**数学结论**：同一规则攒满 6 次至少需要 5 × 120s = **10 分钟**连续违规，而每次 AI 写文件都会重置 `no_edit_streak` 的计数（见 §7.4）。因此在单次会话内**结构上不可能**达到阈值。

### 7.4 ★★ AI 写文件被记为 `code_edit` —— 使 `consecutive_code_generation` 永不触发

日志中出现大量由 **AI** 通过 `write_to_file` 落盘的文件所产生的 `code_edit` 事件（`role: "user"`）：

```
12:32:35.830 code_edit  bubble_sort.py  changeDelta=948
12:33:32.484 code_edit  bubble_sort.py  changeDelta=0
12:34:57.900 code_edit  quick_sort.py   changeDelta=969
12:35:31.445 code_edit  insertion_sort.py changeDelta=901
...（heap/bucket/shell/selection 各一次）
```

`CodeEditTracker` 监听的是 `vscode.workspace.onDidChangeTextDocument`，**只按路径模式排除**（`.git` / `node_modules` / `.cline-logs` / `dist` / `*.log`…），**不区分编辑者是人类还是 AI**。

而 `BehaviorMonitor.updateRealtimeStreaks()` 中：

```ts
if (event.eventType === "code_edit") {
    this.turnsSinceLastEdit = 0
    this.assistantCodeStreak = 0   // ← 每次 AI 写文件都把 streak 清零
    return
}
```

⇒ 序列「AI 写文件（streak→0）→ AI 在 `attempt_completion` 里贴 fenced 代码块（streak→1）→ AI 写下一个文件（streak→0）」**循环往复**，`assistantCodeStreak` 只能在 **0 与 1** 之间摆动，**永远达不到 `consecutiveAssistantCodeThreshold = 3`**。

**这解释了 M4 的完整现象**：日志里 `consecutive_code_generation` 的注入次数为 **0**（上表），因此无论学生连续索要多少次完整代码，这条"最对症"的规则**根本没有参与评估**。

> 注：M4 记录中的「💡 实践建议：这几轮都是我在写代码…」等文案**不是**这条规则的输出（见 §7.2），容易造成"该规则在起作用"的错觉。

### 7.5 DSML 方言泄漏与畸形工具调用（M1 崩溃的直接原因）

Task `1791721646283` 的前 3 个助手回合（12:27:40 / 12:27:46 / 12:27:49），`rawContent` **整段都是模型原始的工具调用方言标记**，没有一句自然语言：

- 第 1、2 回合：参数写作 `name="tool_name" string="true"`（多了 `string` 属性）；
- 第 3 回合：参数退化为 `name="tool_name"`，**缺少 `string` 属性**；
- 三次调用全部无法被解析 ⇒ 触发 `consecutiveMistakeCount` 上限 ⇒ `index.ts:2710` 输出「AI 连续 3 次没能正确调用工具，这次回答中断了」。

同类问题在 Task2 依然存在（混合格式 / 重复调用 / 尾部残留）：

| 时间 | 现象 |
|---|---|
| 12:32:11 | DSML 与 XML **混用**（前 3 行 DSML，后面变成 `<use_mcp_tool>`） |
| 12:32:14 | 对**同一次** `read_wiki_chunk` 又发一遍 XML 形式（**重复调用**，白白消耗回合） |
| 12:32:19 | DSML 圆括号与 XML 混排，`<server_name>wiki` 未闭合 |
| 12:36:14 | 正常的 `execute_command` 后面**残留**一段 DSML 尾部标记 |

`d027994e` 已做的 `stripLeakedToolCallMarkup` + 隐藏原始 MCP 响应，只解决了**渲染层**（把标记从聊天里藏起来）；**感知层与工具调用层的方言问题仍未解决**（方案 G 明确定为"治本、需单独排期"）。

**直接后果**：M1 这样的"最简单用例"**整轮作废**，无法用于判定干预是否误触发 —— 人工验收的可信度被显著削弱。

### 7.6 分类器与下游指标的三处数据质量问题

| # | 现象 | 证据 | 影响 |
|---|---|---|---|
| 1 | **助手输出被误分类为 `language_request`** | Task1 回合 1–3 的 `category` 字段全是 `language_request` | 该字段会进入 `lastAssistantCategory` / `AdoptionTracker.isSameTopicHeuristic`，以及教师端看板的"AI 输出分类"统计。根因疑似 `TaskClassifier.countMatches()` 使用 `text.includes(keyword)` —— **纯子串匹配、无词边界**，`go` / `js` / `ts` / `c#` 等短关键词会命中无关文本（**待实测确认**） |
| 2 | **采纳推断恒为 `adopted`** | 每条用户消息后都紧跟一条 `adoption_infer ... adoptionStatus:"adopted"`（Task1/Task2 全程无 `rejected`，除 Task1 一次） | `high_adoption_low_self_modification` 的输入失真；教师端"采纳率"指标不可用 |
| 3 | **AI 写文件记为"学生编辑"** | 所有 AI 落盘的 `code_edit` 事件 `role` 都是 `user` | 提交给教师端的 `user_edit_count` 与看板"学生动手情况"会**把 AI 的劳动算成学生的** —— 与本次干预改造要解决的"AI 依赖"问题方向相反 |

### 7.7 周数切换的实证

| 检查 | 结果 |
|---|---|
| `cline_mcp_settings.json`（最终态） | `args: ["...mcp-wiki-server.js", "--week", "18", "--server", "http://localhost:4001"]` ✅ 周数**确实被重写** |
| Task1（周数应为 1）连续 5 次同一提问 | 12:31:03 / 12:31:12 / 12:31:31 / 12:31:48 全部给出**完全相同**的拒答（"这两部分内容尚未在第 1 周的教学进度内发布"） |
| Task2（新对话，周数 18） | 首次提问即检索到第 4/5/6/10/11 周资料并给出完整实现 |

⇒ **配置重写链路是通的**（`switchWeek` → 写配置 → `registerWikiMcpConfigWatcher` → 重写 `cline_mcp_settings.json` → chokidar → `McpHub.configsRequireRestart` 判 true → `restartConnection`）。因此"同对话内切换周数不生效"的主因**不在 MCP 侧**，而在**对话历史自我锚定**：模型在历史里已写下 5 次相同的拒答，倾向与自己的前文保持一致；新对话清空历史后立即恢复。**（§8.3 给出验证与修法）**

---

## 8. 各项问题的根因

### 8.1 问题 1 —— 周数边界过严（助手看不到后续内容）

周数边界是**三层**叠加，而不是一层：

| 层 | 位置 | 行为 |
|---|---|---|
| ① **检索/SQL 层** | `teaching-server` 的 `search_wiki` | `applicable_week <= week` 硬过滤；`week` 由插件 **spawn MCP server 时以 `--week` 注入**（`mcp/args.ts`，`clampWeek` 限 1..18） |
| ② **索引层** | `LLMWikiService.buildIndexGroups()`（`LLMWikiService.ts:220`） | `if (week > this._currentWeek) return` ⇒ **连"后续周有哪些标题"都看不到** |
| ③ **提示词层** | `src/core/teaching/wikiPrompt.ts` | 规则 2「检索为空 → **不要展开讲解**其具体用法，应告知后续周次」；规则 3「**严禁**使用超出第 N 周的高级语法、设计模式或库函数」 |

用户判断「助手只能看到第 1 周的文件内容，实际并不能看到后续的内容」**正确，且比描述更彻底**：它连后续周的**标题**都看不到。因此它只能说"未发布 / 后续周次讲解"，**没有能力**说"这是第 N 周的内容，属于某主题"。

M2/M3 的表现（「没有找到相关内容，说明尚未在第 1 周的教学进度内发布」）是三层共同作用下的**必然结果**，不是模型偷懒。

### 8.2 问题 2 —— 过僵、无法联网、期望"松绑但受控"

**硬事实：学生端没有联网搜索能力。**

`src/core/prompts/system-prompt/tools/web_search.ts:19` 与 `web_fetch.ts`：

```
contextRequirements: (context) => context.providerInfo.providerId === "cline" && context.clineWebToolsEnabled === true
```

学生端使用 **DeepSeek**（`providerId === "deepseek"`）⇒ `web_search` / `web_fetch` **根本不出现在工具列表中**；`clineWebToolsEnabled` 默认 `true` 也无济于事。

官方工具描述本身已指路：

> *"If an MCP-provided web search tool is available, prefer using that tool instead of this one"*

⇒ **provider 无关的可行路径是新增一个联网检索 MCP server**，直接复用本项目已有的 `mcp-wiki-server` + `WikiMcpRegistrar` 范式（`--week` / `--server` 参数注入、chokidar 自动重载、禁用可控）。

**关于"加 skill 还是改系统提示词"**：两者**强制力等级相同 —— 都是提示词，都不具备强制**。

| 方案 | 强制力 | 定位 |
|---|---|---|
| 改 `wikiPrompt.ts`（现有约束文本） | 提示词 | ✅ **首选**：它本就是为此而生，改动最精准 |
| 新增 skill | 提示词 | ⚠️ 只改善**打包与可维护性**（可被 `skillsEnabled` 单独开关、学生可见"教学策略"），**不增加任何强制力** |
| 代码层过滤 assistant 输出 | 强制 | ❌ 不建议：`conceptModeConstraint.ts` 头部注释已论证会误伤学生正当代码 |

**要强制只能靠代码层；要引导，提示词就够了。** 当前问题是**提示词写成了"一律拒答"**，而不是"缺少强制机制"。

### 8.3 问题 3 —— 同对话内切换周数不生效

**已排除**"系统提示词被缓存"：`getSystemPrompt()` 无缓存，且注入代码位于 `attemptApiRequest`（`index.ts:2108–2333`）**内部，每次 API 请求都重建**。

**已排除**"配置未重写"：`cline_mcp_settings.json` 里 `--week` 确为 `18`（§7.7）。

**剩余主因（置信度高）**：**对话历史自我锚定**。Task1 中模型已输出 5 次完全相同的拒答（"尚未在第 1 周的教学进度内发布"），切换周数后继续在同一历史里提问，模型倾向与自己的前文保持一致；新对话清空历史后**立刻**恢复。

**次因**：MCP 进程重启存在延迟（chokidar `awaitWriteFinish` 100ms + 人工延迟 500ms + spawn），检索侧存在短暂旧周窗口；且**没有任何机制告知模型"周数已改变"**。

**验证方法（无需改代码）**：切周数后立即在新对话问一句，再切回旧对话问同一句 —— 若旧对话仍拒答而新对话正常，则确认主因为历史锚定。

### 8.4 问题 4 —— 阻断式干预永不触发（**结构性不可达**，而非阈值偏高）

完整链路与**四个阻断点**：

```
每次 ingest → updateRealtimeStreaks → evaluateRules（受 rulePolicy 门控）
                                   → checkXxxRule → 达阈值 → notify()
notify()：① 提醒冷却筛掉 → ② escalationCounter++ → ③ push(pendingAlerts)
attemptApiRequest → checkAndGenerateIntervention
                 → shouldEscalateToBlocking(ruleId)（计数 ≥6 且允许升级）→ 阻断
```

| # | 阻断点 | 位置 | 后果 |
|---|---|---|---|
| **1 ★** | **升级计数被提醒冷却节流** | `BehaviorMonitor.notify()` 中 `if (now - lastTs < cooldownMs) return`（`cooldownMs = 120_000`）**位于 `escalationCounter++` 之前** | 同一规则攒满 6 次至少需 **5×120s = 10 分钟**连续违规。§7.3 已用日志实测证实（两次触发间隔 124 秒） |
| **2 ★★** | **AI 写文件产生的 `code_edit` 反复清零 streak** | `CodeEditTracker` 不区分编辑者；`updateRealtimeStreaks()` 遇 `code_edit` 即 `assistantCodeStreak = 0` | `consecutive_code_generation` **永远达不到 `consecutiveAssistantCodeThreshold = 3`** ⇒ 日志中该规则注入次数为 **0** ⇒ 最对症的规则**根本没参与评估** |
| **3** | 分类门控可能静默停用规则 | `ingest()` 对**每个** user 消息覆盖 `currentTaskCategory`；`TaskClassifier.classify()` 按 `matchCount × weight` 排序（`排序`→algorithm **权重 10** > `实现`→code_generation **权重 7**） | 一个代码生成任务可能因后续消息是「再实现一个快速排序」而判成 `algorithm` ⇒ 代码类规则 `enabled=false` 且 `canEscalateToBlocking=false` |
| **4** | 次要闸门 | `maxInterventionsPerTask = 10`、`blockingTriggered` 单任务仅触发一次 | 非决定性 |

**结论：你提出的"第 3 次索要完整代码就应触发阻断"在当前设计下不可能实现 —— 问题不在阈值，在"计数口径"**：升级计数的是**提醒的发射次数**（被 120s 冷却节流），而不是**违规的次数**。

> 附带：`BehaviorMonitor.evaluateRules()` 的注释声称「门控只停用**评估**、不停用**计数**」，但 `escalationCounter++` 恰恰写在被评估层调用的 `notify()` 里 —— **注释与实现不一致，属真 bug**。

### 8.5 M1 失败 —— 模型工具调用方言崩溃（与干预逻辑无关）

见 §7.5。整段 `rawContent` 是畸形方言标记 ⇒ 3 次未命中 ⇒ 触发 `maxConsecutiveMistakes` ⇒ 输出「AI 连续 3 次没能正确调用工具」。**M1 的"无干预"预期无法被验证**，因为该轮压根没走到回答阶段。

### 8.6 M2 假阳性 —— `ai_dependency` 的比例指标在 Cline 形态下恒真

`high_recent_ai_dependency` 的指标是 `assistantTurns / (assistantTurns + userTurns)`。Cline 一次提问会产生 **6~11 个助手回合**，而用户回合只有 1 ⇒ 比例恒 >0.85，`minTurnsForDependency: 6` / `aiDependencyThreshold: 0.85` **压不住**。

`rulePolicy.ts` 已认识到"分母天然极小、比例指标不可靠"，但**只禁用了"升级"，未禁用"提示"** ⇒ 任何耗时稍长的概念问答都会在约 6 个回合后弹一条提示。日志中 Task1/Task2 各命中 1~2 次，**全部发生在纯问答场景**（Task1 的 M2 场景即为此）。

### 8.7 ★ M6 失败 —— 概念模式约束"越索要越放开"（设计自相矛盾）

比"翻转后应触发干预"更严重的问题：

- 约束注入条件：`isConceptModeCategory(category)`（`index.ts:2307`），仅 `explanation` / `algorithm` 注入；
- 学生说「**直接把完整代码给我**」→ `TaskClassifier` **一个关键词都命中不了**（该句不含 `写一个` / `实现` / `code` / `写个`…）⇒ `rawCategory = "other"` ⇒ **不是概念类** ⇒ **约束被摘掉** ⇒ 模型自由给出完整实现（日志 turn 4/5 直接 `write_to_file`）；
- 即使走 `RequestIntentRefiner` 把它翻成 `code_generation`，**同样会摘掉约束**。

即：**护栏被卸掉的那一刻，正是它最该起作用的时刻**。`RequestIntentRefiner` 的设计意图（"翻转后让代码类干预重新生效"）在干预侧生效了，但代价是**放行了模型**。

**同时解答了 §4.3 的 Important B**：`hasDeliveredKeyCode` 只认消息文本内的 fenced 块——但**在 M6 的场景里这条路径根本没被走到**，因为裸的"给我完整代码"落到了 `other` 而不是概念类。**B 属真实缺陷但非 M6 的根因**；根因是"撤销护栏"的语义错误。

**正确的翻转语义应是：保留护栏 + 开启阻断倒计时**，而不是"卸护栏 + 给一句提示"。

### 8.8 附带：`persistTurnLevelLog` 的 fire-and-forget 竞态

`index.ts:756` 是 `void this.persistTurnLevelLog(...)`（异步不等待），而分类门控与概念约束的读取在 `index.ts:2307`。两者竞态 ⇒ 同一行为的判定**可能时好时坏**，是 M5 通过 / M6 失败之间不确定性的来源之一。

---

## 9. 修订方案

### 9.1 方案总表

| 优先级 | 编号 | 方案 | 主要文件 | 风险 | 对应问题 |
|---|---|---|---|---|---|
| **P0** | F1 | **升级计数与提醒冷却脱钩**：违规即计数，阈值 6→3 | `BehaviorMonitor.ts` | 低 | 问题 4 |
| **P0** | F2 | **`code_edit` 区分编辑者**：AI 落盘不再清零 streak | `CodeEditTracker.ts`、`BehaviorMonitor.ts` | 低 | 问题 4（决定性） |
| **P0** | F3 | **概念约束不得因"索要"而撤销** | `index.ts`（注入条件）、`conceptModeConstraint.ts` | 低 | M6、问题 2 |
| **P1** | F4 | **全周目录索引 + 分级应答策略**（替掉"一律拒答"） | `wikiPrompt.ts`、`LLMWikiService.buildIndexGroups()`、`mcp-wiki-server.ts` | 中 | 问题 1、2 |
| **P1** | F5 | **分类口径粘性化**，消除门控静默停用 | `BehaviorMonitor.ingest()`、`TaskClassifier` | 中 | 问题 4 |
| **P1** | F6 | **干预不进对话历史 + 禁止改写**（消除仿写与不可审计） | `InterventionMessageGenerator.ts`、`index.ts` | 低 | §7.2 |
| **P2** | F7 | **周数热更新**（MCP 读文件，免重启）+ 切换周数显式通知 | `mcp/args.ts`、`mcp-wiki-server.ts`、`index.ts` | 中 | 问题 3 |
| **P2** | F8 | **联网检索 MCP server**（provider 无关） | 新增（复用 `mcp-wiki-server` 范式） | 中高 | 问题 2 |
| **P2** | F9 | `ai_dependency` 指标改造（绝对回合数，或概念问答下不提示） | `BehaviorMonitor.ts`、`rulePolicy.ts` | 低 | M2 |
| **P3** | F10 | `hasDeliveredKeyCode` 兼容工具落盘（读 `tool_use` 内容） | `index.ts:1097` | 低 | §4.3 B |
| **P3** | F11 | `countMatches` 加词边界；`adoption_infer` / `code_edit` 的 `role` 归属修正 | `TaskClassifier.ts`、`AdoptionTracker`、`CodeEditTracker` | 中 | §7.6 |
| **P3** | F12 | 方言（DSML）归一化 —— **治本，需单独排期** | 感知/工具调用层 | 高 | §7.5 |

### 9.2 P0 明细

#### F1 — 升级计数与提醒冷却脱钩

**现状**：`escalationCounter++` 在 `notify()` 内、被 `cooldownMs` 冷却筛掉之后。

**改动**：
1. 把计数与通知**分离**：在 `checkConsecutiveCodeGenerationRule()` / `checkNoEditStreakRule()` 等**判定命中时立即计数**（不受冷却影响），`notify()` 只负责是否需要发出提示。
2. `escalationBlockingThreshold` 6 → **3**（对齐"第 3 次索要完整代码即阻断"的验收口径）。
3. `checkAndGenerateIntervention()` 中"阻断判定"应**不依赖 `pendingAlerts` 是否非空** —— 当前若队列为空会直接 `return null`，会漏掉"已达阈值但本轮无新提示"的阻断。

**验收**：连续 3 次索要完整代码（无需等待 10 分钟）⇒ 第 3 次即进入阻断，横幅从 `1:00` 倒数。

#### F2 — `code_edit` 区分编辑者（**本次日志带来的最关键发现**）

**现状**：`CodeEditTracker.onDocumentChange` 只按路径过滤，**不区分人类/AI**；AI 通过 `write_to_file` 落盘的每次写入都会产生 `code_edit`，把 `assistantCodeStreak` 清零。

**改动**：
1. `onDocumentChange` 增加"来源判定"：若该次变更由 Cline 的 `DiffViewProvider` / `write_to_file` 写入，则标记 `eventType: "code_edit_ai"`（或将 `role` 标为 `assistant`）。
2. `BehaviorMonitor.updateRealtimeStreaks()`：只有**学生本人**的 `code_edit` 才重置 `assistantCodeStreak` / `turnsSinceLastEdit`；AI 落盘**不算**学生动手（且应作为"AI 又写了一次代码"计入 streak）。

**影响面提示**：该改动同时修正 §7.6 的第 3 项数据质量问题（AI 的劳动被算成学生的），因此**必须同步核对**教师端 `user_edit_count` / 采纳率口径，避免看板数据前后不一致。

#### F3 — 概念模式约束不得因"索要"而撤销

**现状**（§8.7）：约束仅在 `isConceptModeCategory(category)` 为真时注入；而「直接把完整代码给我」这类裸索要**不含任何分类关键词** ⇒ 落入 `other` ⇒ 非概念类 ⇒ **约束被摘掉**。走 `RequestIntentRefiner` 翻成 `code_generation` 时同样摘掉 ⇒ **两条路径都在最需要护栏的时刻卸掉护栏**。

**改动**：
1. 约束注入条件与"意图翻转"解耦：`isConceptModeCategory()` 的判定改为**任务级粘性**——一旦任务起始为概念类，**只有学生实际动手（学生侧 `code_edit`）或显式换题**才退出概念模式。
2. `RequestIntentRefiner` 的翻转语义改为：**保留约束** + **把该轮计入"索要完整代码"的专用计数器**（供 F1 升级）。
3. 在约束文本中补一条**例外通道**：允许给出"关键步骤 + 伪代码骨架"，并明确要求"完整实现留给学生"，避免模型在压力下要么全给、要么全拒。

### 9.3 P1 明细

#### F4 — 全周目录索引 + 分级应答策略

**拆开"能知道"与"能取用"**：

1. **索引层放行**：`buildIndexGroups()` 取消 `week > this._currentWeek` 的过滤，注入**全部 18 周的"周 → 标题"目录**（仍只含元数据、不含正文）。`MAX_INDEX_CHARS = 2400` 需要放宽或改为**分级截断**（当前周附近全列、远期只列周号 + 主题数）。
2. **提示词层改为三档策略**（替掉 `wikiPrompt.ts` 规则 2/3 的"一律拒答"）：

| 档位 | 情形 | 应答方式 |
|---|---|---|
| **A 在进度内** | `week <= currentWeek` 且检索命中 | 以资料为依据，教材对齐（现状不变） |
| **B 超纲、无资料** | 检索为空 | **允许讲解**，但必须：① 标注「📌 这属于第 N 周内容，你现在学到第 M 周」；② 先补齐当前进度内的前置基础；③ **不给完整可运行实现**（由 F1/F3 兜底，而不是靠拒答） |
| **C 超纲、可联网** | 启用联网 MCP 时 | 联网只用于**校验通用知识**；结论仍须回落到教材口径与当前阶段，外部资料不得覆盖教材定义 |

3. **同步改写工具描述**：`mcp-wiki-server.ts` 中 `search_wiki` 的 description 目前写着"若返回 0 条…**不要展开讲解**其具体用法" —— 这是拒答行为的直接指令源，必须与三档策略一起改。

**验收锚点**：M2'（week=1 问「什么是装饰器」）应给出**带周次标注的概念讲解 + 当前进度内的前置基础**，而不是"未发布，建议完成本周内容"。

#### F5 — 分类口径粘性化

**改动**：
1. `currentTaskCategory` 不再被每个短消息覆盖。规则改为：**只在出现"强信号"时覆盖**（任务起始分类；或命中明确的 `code_generation` 关键词；或 `RequestIntentRefiner` 的完整性标记），其余情况**保持上一个强分类**。
2. 修正 `countMatches()` 的**子串匹配**问题（加词边界），否则 `排序` 与 `实现` 的权重比较会被短关键词噪声污染。

#### F6 — 干预不进对话历史 + 禁止改写

**现状**：注入文本被 `userContent.push` 后 `addToApiConversationHistory` **持久化**，且提示词明确要求模型"把它说成像是自己主动给出的教学建议" ⇒ 模型持续仿写（§7.2 已用 `0 次命中` 证实）。

**改动**：
1. 干预文本**不进入** `apiConversationHistory`（只作为本轮的一次性后缀 / 或注入后立即从历史中剔除）。
2. 取消"不要提及这是系统自动插入的消息"这条指令，改为统一前缀（如 `[教学提示]`）并**禁止改写**。
3. 可选：把干预改为**独立 UI 元素**（不经过模型），使"干预次数"可被精确审计。

### 9.4 P2 / P3 明细

#### F7 — 周数热更新 + 切换通知

1. **MCP server 改为运行时读周数**：`mcp-wiki-server.ts` 每次 `search_wiki` 前从一个小文件（如 `<globalStorage>/teaching-week.json`，由插件在周数变更时写入）读取 `week`，`--week` 仅作**首次回退**。⇒ 彻底消除重启需求与"旧周窗口"。
2. **切换周数时注入显式通知**：`attemptApiRequest` 检测到 `currentWeek` 与本任务上次注入值不同时，往 `userContent` 追加一句「⚠️ 教学周已由第 N 周切换为第 M 周，此前基于旧进度的回答请以新进度为准」。这是**直接对抗历史锚定**的最低成本手段。
3. 保留 `--week` 的 spawn 注入作为兼容路径。

#### F8 — 联网检索 MCP server

- 复用 `mcp-wiki-server` 范式（stdio + `WikiMcpRegistrar` 自注册 + chokidar 重载 + 禁用可控）；
- 独立开关（如 `clineTeaching.webSearchEnabled`），与学生身份/课堂场景解耦；
- 工具描述需明确约束：**只用于校验通用知识**，回答口径仍以教材与当前周为准（与 F4 档位 C 配套）；
- 需评估外部搜索 API 的成本、超时与降级路径（失败时不阻断对话，返回结构化错误 JSON）。

#### F9 — `ai_dependency` 指标改造

- 指标语义从"比例"改为"**绝对回合数内 AI 独占的输出量**"，或对概念问答（`rulePolicy` 已识别的 `CONCEPTUAL_CATEGORIES`）**不提示**（当前只禁用了升级）；
- 需同步更新 `interventionParams.test.ts` 的断言。

#### F10 — `hasDeliveredKeyCode` 兼容工具落盘

置位条件从"仅 `assistantText` 的 fenced 块"扩展为"`assistantText` 的 fenced 块 **或** `write_to_file` / `apply_diff` 的 `content`"，使方案 C-3 在真实工作流（AI 落盘）下也能武装。

#### F11 — 三处数据质量修正

| 项 | 改动 |
|---|---|
| `countMatches` 子串匹配 | 加词边界（`\b` 或自定义边界），避免 `go` / `js` / `ts` 命中无关文本 |
| `adoption_infer` 恒 `adopted` | 复核 `AdoptionTracker` 的判定条件（当前几乎每条消息都判为 `adopted`） |
| `code_edit` 的 `role` 归属 | 与 F2 同源；AI 落盘应标 `assistant`，避免污染 `user_edit_count` 与看板"学生动手情况" |

#### F12 — 方言（DSML）归一化（治本，单独排期）

`d027994e` 只解决了渲染层。感知层与工具调用层的方言问题会让 M1 这类用例整轮作废（§7.5）。方案 G 已明确为"治本、需单独排期"，本次不展开。**在该项完成前，人工验收的可信度上限受此制约**。

---

## 10. 修订后的验收标准

> 原 M1–M7 中 **M1 因方言问题不可判、M5 已通过**，其余需重写。以下为新标准。

| # | 前置 | 动作 | 期望 | 对应方案 |
|---|---|---|---|---|
| **M1'** | week=1 | 询问「第一周学了什么」 | 给出第 1 周内容；**零干预**（验证提示预算，不再依赖方言可用性） | F6 |
| **M2'** | week=1 | 询问「什么是装饰器」 | **给出概念讲解**，标注「这属于第 N 周」+ 当前进度内前置基础；**不给完整实现**；零干预 | F4、F3 |
| **M3'** | week=1，同对话内切到 week=18 | 直接追问「冒泡排序怎么写」 | **即时生效**：检索到 week ≤ 18 的资料并作答，不再延续旧拒答 | F7 |
| **M4'** | 任何周 | 连续 3 次「帮我写一个完整的 XXX 程序」 | **第 3 次即进入阻断**（横幅从 `1:00` 倒数） | F1、F2、F3 |
| **M5'** | 概念问答 | 问「冒泡排序怎么写」 | 设计 + 仅交换那一行；无完整循环结构（**回归，须保持通过**） | — |
| **M6'** | 紧接 M5' | 说「直接把完整代码给我」 | 分类翻转为 `code_generation`（日志出现 `意图翻转`）；**仍不给完整实现**；新一轮索要计入升级计数 | F3 |
| **M7'** | 阻断激活中 | 发任意消息 | 被拦截并显示剩余时间；**60s 后自动恢复**，MCP 检索重新可用 | — |
| **M8'** | 任意 | 用 `write_to_file` 让 AI 连写 3 个文件后查看 `student_interactions.log` | `consecutive_code_generation` 出现在日志中；AI 落盘事件**不再**把 `assistantStreak` 清零 | F2 |
| **M9'** | 任意 | 统计一次会话的用户可见干预文案数 | 与 `api_conversation_history.json` 中 `<teaching_intervention ...>` 的条数**一致** | F6 |
| **M10'** | week=18 | 询问一个需要外部资料的问题（启用联网后） | 使用联网校验，但结论仍回落到教材口径 | F8 |

**新增的自动化门槛建议**（弥补本次"自动化全绿但人工失败"的缺口）：
- 新增一条**端到端阈值可达性**测试：构造"3 次索要完整代码 + AI 落盘"的事件序列，断言 3 次后 `shouldEscalateToBlocking() === true`；
- 新增一条**AI 落盘不清零 streak** 的测试；
- 新增一条**"索要完整代码不得撤销概念约束"**的测试。

---

## 11. 风险与明确不做的事

| 项 | 说明 |
|---|---|
| **F8 联网的合规风险** | 课堂场景下允许联网需评估（内容安全、API 成本、超时降级）。建议默认关闭、由教师端统一下发 |
| **F2 会改变既有指标口径** | `user_edit_count` / 采纳率在教师端看板上的历史数据与新数据**口径不一致**，需在 CHANGELOG 与看板文案中说明 |
| **F4 放宽索引** | 索引从"仅 ≤ 当前周"放宽到"全 18 周标题"，会略微扩大模型可见信息面；但**仍不含正文**，且正文检索边界可保持不变 |
| **F3 收紧后可能出现"过度拒绝"** | 需保留示例通道（关键步骤 + 伪代码骨架），并用 M6' 双向验证 |
| **明确不做** | ① 代码层过滤 assistant 输出（会误伤学生正当代码，`conceptModeConstraint.ts` 已论证）；② 用 skill 代替系统提示词以求"强制力"（**skill 无强制力**）；③ 在本次一并做 F12 方言归一化（治本、需单独排期） |

---

## 12. 附录：证据复算命令

```powershell
# ① 单任务的真实干预注入次数（每条注入只出现一次开标签）
$t = "<globalStorage>\shiinamatsuri.student-teaching-assistant-edu\tasks\1791721915982"
$j = Get-Content (Join-Path $t "api_conversation_history.json") -Raw
[regex]::Matches($j, '<teaching_intervention rule=\\"([a-z_]+)\\"').Count

# ② 验证"模型仿写"：该文案不在任何 user 消息中即为仿写
[regex]::Matches($j, "再对照我的实现找差异").Count   # 期望 0

# ③ 验证 MCP 周数参数是否被重写
Get-Content "<globalStorage>\shiinamatsuri.student-teaching-assistant-edu\settings\cline_mcp_settings.json" -Raw

# ④ 行为日志按规则统计（把 ｜｜DSML｜｜ 换成真实字符后使用）
Get-Content "<workdir>\.cline-logs\student_interactions.log" | Select-String "code_edit" | Measure-Object
```













*— 文档结束 —*
