# 教学干预误触发修复 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐 Task 执行本计划。步骤用 checkbox（`- [ ]`）跟踪。
>
> 配套文档：`docs/design/teaching-intervention-fix-options.md`（方案对比与决策依据）

**Goal:** 消除"学生纯概念提问却被判为连续索要代码、并在数轮内升级为阻断"的误触发，同时保证真正依赖代码生成的学生**仍会被干预**。

**Architecture:** 按 L1→L4 分层修：先止血参数（D），再对齐文案（E），再修指标判定（A），最后做规则分流（C）。C 额外引入"概念问答模式下不给完整代码"的行为约束，以及"学生持续索要完整代码时意图翻转为 `code_generation`"的反馈回路。

**Tech Stack:** TypeScript（VS Code 扩展宿主）、mocha 10 + ts-node 10（`tsconfig.unit-test.json`，`preferTsExts: true`）、chai、Biome。

## Global Constraints

- 单测命令：`npm run test:unit -- --grep "<suite 名>"`；**全量基线 768 passing / 111 pending / 0 failing**，每个 Task 结束时不得低于该基线，且不得新增 failing。
- 类型检查：`npx tsc --noEmit`（扩展侧）与 `cd webview-ui && npx tsc --noEmit` 均须 **0 错误**。
- Lint：改动文件须 **0 新增** Biome 问题。检查命令：`npx biome lint --reporter=github <文件…>`。
- **缩进风格**：`src/core/task/student-analytics/*` 与 `src/core/task/index.ts` 均为 **Tab 缩进**；新建的 `.ts` 一律用 Tab。`src/core/teaching/assistantTextSanitizer.ts` 为 Tab。
- **不要跑 `npx biome format --write`**：会把 Tab 文件整体重排，污染 diff。
- **`student_interactions.log` 字段是外部契约**（教师端看板 `backend:4000` 与 `teaching-server:4001` 都消费）：
  **原则上只新增字段、不改旧字段语义**。
  ⚠️ **唯一例外：`hasCode`（Task 3 的 ② 已决 = B1）** —— 它会对"含工具标记的回合"改变取值，
  直接影响看板的 `codeGenerationRatio` / `codeEditRatio` / `selfModificationRate`。
  这是**有意为之的口径修正**，必须写进 CHANGELOG 并同步教师端，而不是当成意外。
- **不得整体关闭教学干预机制**（不得把 `behaviorMonitorEnabled` 默认改为 false、不得整体停用规则）。
  ⚠️ 本计划 Task 4 会**按学生意图有条件分流**（概念问答下停用两条代码类规则）—— 那是本计划的设计目标，不算"关闭干预"。
  判断标准：任何改动都不得让"**学生在代码类任务里反复索要代码**"这条路径失去干预。
- 本计划**不含** `docs/design/teaching-intervention-fix-options.md` §5「感知层重构」的内容 —— 那部分明确保留不动。

---

## 1. 文件结构

### 新建

| 文件 | 职责 |
|---|---|
| `src/shared/markdown/codeBlocks.ts` | **纯函数**：解析 fenced 代码块（语言标签 / 内容 / 有效行数）—— Task 3a 新建 |
| `src/shared/markdown/toolCallMarkup.ts` | `stripLeakedToolCallMarkup`（从 `core/teaching/assistantTextSanitizer.ts` **迁移**而来）—— Task 3a |
| `src/shared/markdown/__tests__/codeBlocks.test.ts` | Task 3a 测试 |
| `src/shared/markdown/__tests__/toolCallMarkup.test.ts` | 原 `assistantTextSanitizer.test.ts` 随文件 **迁移** |
| `src/core/task/student-analytics/rulePolicy.ts` | **纯函数**：按 `TaskCategory` 决定每条规则是否启用、是否可升级为阻断 |
| `src/core/task/student-analytics/RequestIntentRefiner.ts` | **纯函数**：把"概念提问 + 持续索要完整代码"重分类为 `code_generation` |
| `src/core/teaching/conceptModeConstraint.ts` | 概念问答模式的提示词约束文本 + 违规检测（仅可见化） |
| `src/core/task/student-analytics/__tests__/interventionParams.test.ts` | Task 1 测试 |
| `src/core/task/student-analytics/__tests__/interventionMessages.test.ts` | Task 2 测试 |
| `src/core/task/student-analytics/__tests__/contentAnalyzer.test.ts` | Task 3 测试 |
| `src/core/task/student-analytics/__tests__/behaviorMonitor.streak.test.ts` | Task 3 测试 |
| `src/core/task/student-analytics/__tests__/rulePolicy.test.ts` | Task 4 测试 |
| `src/core/teaching/__tests__/conceptModeConstraint.test.ts` | Task 5 测试 |
| `src/core/task/student-analytics/__tests__/requestIntentRefiner.test.ts` | Task 6 测试 |
| `src/core/task/student-analytics/__tests__/interventionRegression.test.ts` | Task 7 回归（**验收门槛**） |

> 该模块**目前没有任何测试**，本计划是其首批测试。

### 修改

| 文件 | 涉及 Task |
|---|---|
| `src/core/task/student-analytics/BehaviorMonitor.ts` | 1、3、4 |
| `src/core/task/student-analytics/TeachingInterventionManager.ts` | 1 |
| `src/core/task/student-analytics/InterventionMessageGenerator.ts` | 1、2 |
| `src/core/task/student-analytics/ContentAnalyzer.ts` | 3 |
| `src/core/task/student-analytics/types.ts` | 3 |
| `src/core/task/index.ts` | 3a、3、5、6 |
| `docs/design/wiki-mcp-retrieval-acceptance.md`、`docs/design/teaching-features.md` | 3a（文档中的 `assistantTextSanitizer` 路径引用） |

---

## 2. 执行顺序与门槛

```
Task 1（D 止血） → Task 2（E 文案） → **Task 3a（公共模块）** → Task 3（A 指标）
        ↓ 全部通过 + Task 7 的回归门槛
Task 4（C-1 规则分流） → Task 5（C-2 概念模式约束） → Task 6（C-3 意图翻转） → Task 7（回归验收）
```

> **Task 3a 的位置不可后移**：Task 3（`ContentAnalyzer`）与 Task 5（`conceptModeConstraint`）都需要"解析 fenced 代码块"，
> 把公共模块放在它们之前，两个 Task 才能各自只写调用而不再各持一份正则。

**硬门槛**：Task 4/5/6 中任一项开工前，Task 1–3 必须全绿，且 `interventionRegression.test.ts` 的场景 1/2/3 已通过（保证干预机制本身仍然生效）。

---

## 2.5 预检决策记录

### 已决：① 代码块解析 — 选 **B + B+**

| 项 | 结论 |
|---|---|
| B | 新增公共模块 `src/shared/markdown/codeBlocks.ts`，`ContentAnalyzer` 与 `conceptModeConstraint` 共用 |
| B+ | 把 `stripLeakedToolCallMarkup` 从 `core/teaching/assistantTextSanitizer.ts` **一并迁入** `src/shared/markdown/toolCallMarkup.ts` |
| 收益 | ① 消掉本计划原本要引入的跨层依赖；② "块边界怎么算"只定义一次；③ `sanitizer` 的路径变更需同步改两次文档引用 |
| 落地 | **Task 3a**（已插入到 Task 2 与 Task 3 之间） |

### 已决：② `hasCode` 与新字段的输入文本 = **B1（统一输入）**

### ✅ 计划内部矛盾已被 B1 消解

初稿里 Step 1 的测试断言 `expect(r.hasCode).to.equal(false)` 与 Step 4 的实现（`hasCode` 用原始文本）冲突。
选 B1 后 `hasCode` 改基于剔除后文本 → **该断言成立，无需改测试**。

> **因此 Task 3 不需要动这 6 处之外的任何代码**：`BehaviorMonitor.checkHighAdoptionLowSelfModificationRule`、
> `AdoptionTracker`、`StudentProfiler`、`scripts/analyze-student-log.ts`
> **均无需修改**（它们读的是同一个 `hasCode` 字段，会自动受益）。
> ⚠️ 执行者切勿“顺手”去改它们 —— 那会把一个单点修正变成 6 处改动。

### 三个选项

| | B1 统一输入 | B2 保留旧语义 + 逐个改读者 | B3 保留旧语义 + `@deprecated` 标记 |
|---|---|---|---|
| `hasCode` 的输入 | 剔除标记后的文本 | 原始文本 | 原始文本 |
| 纯标记回合的 `hasCode` | `false` | `true` | `true` |
| 需额外改造点 | **无** | `BehaviorMonitor`×2、`AdoptionTracker`、`StudentProfiler`、离线脚本 | 同 B2 |
| 漏改风险 | 低（单一字段） | **高（漏一处就静默留下一条误判）** | 高 + 长期维护 `@deprecated` |

### 影响面（两个方向都要看）

**学生端（扩展内）** —— 这是实质影响所在。`hasCode` 的 6 个读取方：

| # | 读取方 | 用途 | 选 B1 | 选 B2/B3 |
|---|---|---|---|---|
| 1 | `BehaviorMonitor.updateRealtimeStreaks` | `assistantCodeStreak` | 修好（Task 3 已改读 `hasCodeBlock`） | 修好 |
| 2 | `BehaviorMonitor.checkHighAdoptionLowSelfModificationRule` | 自主修改率的**分母** | **自动修好** | 需改造 |
| 3 | **`AdoptionTracker.inferAdoption`** | **采纳状态判定** | **自动修好** | 需改造 |
| 4 | `StudentProfiler` | 能力画像统计 | **自动修好** | 需改造 |
| 5 | `student_interactions.log` 字段 | 外部（见下） | 口径变化 | 不变 |
| 6 | `scripts/analyze-student-log.ts` | 开发者离线脚本 | **自动修好** | 需改造 |

第 3 项后果最重（`AdoptionTracker.ts:131` 已核实）：

```ts
// 规则 1：AI 建议包含代码，且用户在建议后编辑/保存了代码 → adopted
if (pending.hasCode && (pending.hasCodeEdit || pending.hasFileSave)) {
    return "adopted"
}
```

纯工具标记回合**本不是**代码建议，但只要 `hasCode=true`，学生之后编辑任何文件，
这些回合就**全被算成"已采纳"** → 采纳率虚高 → 而 `high_adoption_low_self_modification`
的触发条件正是 `adoptionRate >= 0.7` → **又一条误触发路径被打开**。

**教师端 / 云端** —— ⚠️ **有两条独立路径，必须分开看（初次分析只查了其中一条，结论已更正）**

1. **`teaching-server` 从不读 `hasCode`**。它的 `analyzeLogs()` 只读 `role` / `category` / `eventType` / `adoptionStatus`，
   产出 `ai_dependency` / `metric_gaming_score` / `user_edit_count`。所以三个选项对这三个指标**都没有直接影响**。
2. **而且这条链路当前根本没接通真实数据**（这是独立于本计划的缺陷，已登记在 `teaching-intervention-fix-options.md`）：
   - `AssignmentManager.readClineLogs()` 找的是 `<root>/tasks/<taskId>/task_metadata.json`，
     而 `getPossibleClineLogRoots()` 只试 `CLINE_LOG_DIR` / `D:\.cline-logs` / `~/.cline-logs` /
     `%APPDATA%\Cline\.cline-logs` / `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\logs`
     —— **硬编码了上游发布 ID**，与我们 fork 的 `shiinamatsuri.student-teaching-assistant-edu` 不匹配。
   - 实测这些目录均不存在 → 走兑底分支 → 上传**硬编码 demo 事件**（`source: "fallback"`）。
   - 即便找到了，真实的 `task_metadata.json` 内容只有 `{files_in_context, model_usage, environment_history}`
     —— **没有 `events` 数组**，`analyzeLogs` 会返回全 0。

**路径 B — 教师端看板（`web-dashboard/backend`，端口 4000）：⚠️ 这条读 `hasCode`**

`backend/src/analytics.js` **不走上**传，而是**直接读服务端磁盘上的 `student_interactions.log`**：

```js
const LOG_PATH = process.env.CLINE_LOG_PATH || resolveDefaultLogPath()
export function resolveDefaultLogPath() {
  return path.resolve(process.cwd(), "..", "..", "cline", ".cline-logs", "student_interactions.log")
}
```

它从 `hasCode` 派生了**三个看板指标**：

| 指标 | 公式 | B1 实施后的方向 |
|---|---|---|
| `codeGenerationRatio`（代码生成比例） | `assistantWithCode / assistantTurns` | **↓**（不再把纯工具标记/行内代码算作含代码，变得**更准确**） |
| `codeEditRatio` | `codeEdits / assistantWithCode` | **↑**（分母变小） |
| `selfModificationRate`（自主修改率） | `tasksWithCodeEdit / tasksWithAssistantCode` | **↑**（分母变小） |

> ⚠️ `selfModificationRate` 是 `inferLearningStyle()` 的输入之一 →
> **学生的"学习风格"标签可能因 B1 而发生翻转**（而学习风格在前端是可见的）。
> 另外 `adoptionRate` 也是看板指标，而它依赖扩展端的 `AdoptionTracker`
> —— 那个模块**自己也读 `hasCode`**（`AdoptionTracker.ts:131`），所以 B1 会**间接**影响 `adoptionRate`。

**影响结论（更正）**：

- 对 `teaching-server` 的三项指标：**无影响**（它真的不读 `hasCode`）。
- 对 **教师端看板**：**有实质影响** —— `codeGenerationRatio` / `codeEditRatio` / `selfModificationRate` 都会变，
  且可能连带改变 **学习风格标签**。方向是**更准确**（旧值虚高），但属于**口径变化**，
  必须写进 CHANGELOG 并在教师端同步说明，否则会被当成回归。

**顺带查出的教师端缺口**（不在本计划范围，仅登记）：

1. **`student_meta` 扩展端从不写，但 `teaching-server` 会写（且写的是假数据）**。
   `StudentLogPersister.persist()` 只是 `JSON.stringify(log)`，`StudentInteractionLog` 也没有该字段（`src/**` 零命中）；
   但 `teaching-server` 的 `appendToDashboardLog()` 会给**每条经提交进来的事件**补上 `student_meta`。
   ⇒ 实测 `d:\cline-test\.cline-logs\student_interactions.log` 550 行中**仅第 545–550 行**含 `student_meta`
   —— 正是 6 条 demo 兜底事件。所以 `computeStudents()` **不是恒空**，而是返回 **1 个假学生「小王」**。
   真正缺的是**真实日志从未带上 `student_meta`**。
2. **`intervention_evaluation` 事件无人写入**。`LogEventType` 只有
   `task_start | turn_message | code_edit | file_save | adoption_infer`，而
   `extractInterventionEvaluations()` 找的正是 `eventType === "intervention_evaluation"`
   ⇒ **"干预效果/洞察"面板恒为空**（除非有绕过类型的地方写了它）。

> 完整清单（含部署态写入路径失效、`_analysis.json` 误判排除）见
> `docs/design/teaching-intervention-fix-options.md` **§6 教师端链路缺口**（§6.1–§6.7）。

### ⚠️ 一个与 Task 6 有关的反向影响（与选项无关，但必须记录）

`analyzeLogs` 把 `category === "code_generation"` 计入 `ai_dependency` 的**分子**。
Task 6 的意图翻转会**把学生提问的 `category` 改成 `code_generation`** →
**一旦将来接通真实数据，`ai_dependency` 会上升**（概念问答里持续索要代码的学生会被计为依赖度高）。
语义上这是对的，但属于**口径变化点**，必须写进 CHANGELOG 与验收文档。

（同一条链路里还有个既有瑕疵：`user_edit_count` 把 `category === "refactoring"` 也算作一次手动编辑 ——
学生问"帮我重构一下"会被计入。这不在本计划范围内，仅记录。）

### ② 的决策记录（已定）

- **决策：B1 统一输入**。理由：教师端看板确实读 `hasCode`，但 6 个读取方的存亡比“看板数字不变”更重要；
  且旧值本身就是错的（把纯工具调用算作“含代码”）。
- **必须随 Task 3 一并交付的东西**（否则会被当成回归）：
  1. CHANGELOG 条目写明 `hasCode` 口径变更及其对看板三个指标的影响方向；
  2. 验收文档里记一笔（而不仅是学生端行为）。
- **不在本计划范围（已登记，权威清单见 options 文档 §6）**：
  - `student_meta` 真实日志从不带 → 看板学生列表只有提交产生的假学生；
  - `intervention_evaluation` 无写入方 → “干预效果”面板恒空；
  - 上传路径与真实行为日志脱节（demo 兜底 → `ai_dependency` 恒为 0.33）；
  - 部署态 `teaching-server` 写入路径失效（缺 `DASHBOARD_LOG_PATH` + 无共享卷）。
  均与本计划的干预误触发无关，**本次不修**。

---

## ⚠️ 开工前必须先读：一个隐藏缺陷

`blockingCooldownMs` 从 180s 改成 60s，**只改 `TeachingInterventionManager.DEFAULT_OPTIONS` 是不够的** —— 注入给模型的倒计时文本会**仍然写 180 秒**。

原因（三处副本 + 一处写死）：

| 位置 | 内容 | 是否被读取 |
|---|---|---|
| `TeachingInterventionManager.DEFAULT_OPTIONS.blockingCooldownMs` | `180_000` | ✅ 权威（L172、L178） |
| `InterventionMessageGenerator.generateBlockingInterventionMessage` 参数默认值 | `180_000` | 仅兜底（调用方总是显式传） |
| `InterventionMessageGenerator` 三个阻断模板的 `countdownSeconds` | **写死 `180`** | ⚠️ **被 `generateBlockingInterventionMessage` 直接复制进 `countdownSeconds`** |

而 `formatBlockingInterventionForInjection`（内部函数，由已导出的 `formatInterventionForInjection` 分派）用 `countdownSeconds` 渲染 `⏳ 冷却倒计时: 3 分钟`，横幅却按真实的 `blockingEndsAt` 从 60 秒倒数 —— **同一屏里两个数字互相矛盾**。

同理 `escalationBlockingThreshold` 也有两份（`BehaviorMonitor` 与 `TeachingInterventionManager`），且**后者从未被读取**：升级判定走的是 `monitor.shouldEscalateToBlocking()`（`TeachingInterventionManager.ts:162`）。所以**改错那一份不会有任何效果**，也没有任何报错。

→ Task 1 必须同时处理这两个陷阱，并用测试锁住"两处副本一致"。

---

## Task 1：方案 D — 参数止血 + 修掉倒计时不一致

**Files:**
- Modify: `src/core/task/student-analytics/BehaviorMonitor.ts`（`DEFAULT_OPTIONS`，约 L33–45）
- Modify: `src/core/task/student-analytics/TeachingInterventionManager.ts`（`DEFAULT_OPTIONS`，约 L31–40）
- Modify: `src/core/task/student-analytics/InterventionMessageGenerator.ts`（`generateBlockingInterventionMessage`，约 L340–366）
- Test: Create `src/core/task/student-analytics/__tests__/interventionParams.test.ts`

**Interfaces:**
- Produces: `BehaviorMonitor` 文件导出只读常量 `DEFAULT_OPTIONS`（供测试断言）
- Produces: `TeachingInterventionManager` 文件导出只读常量 `DEFAULT_OPTIONS`
- Produces: `generateBlockingInterventionMessage(alert, blockingCooldownMs)` 的返回值满足 `countdownSeconds === Math.round(blockingCooldownMs / 1000)`

**参数终值（全部来自 `teaching-intervention-fix-options.md` §2 方案 D）**

| 参数 | 现值 | 终值 | 所属 |
|---|---|---|---|
| `blockingCooldownMs` | `180_000` | **`60_000`** | `TeachingInterventionManager` |
| `cooldownMs` | `15_000` | **`120_000`** | `BehaviorMonitor` |
| `escalationBlockingThreshold` | `4` | **`6`** | 两份都要改（以 `BehaviorMonitor` 为准） |
| `noEditTurnStreakThreshold` | `5` | **`8`** | `BehaviorMonitor` |
| `aiDependencyThreshold` | `0.7` | **`0.85`** | `BehaviorMonitor` |
| `minTurnsForDependency` | `4` | **`6`** | `BehaviorMonitor` |

- [ ] **Step 1: 写失败测试**

创建 `src/core/task/student-analytics/__tests__/interventionParams.test.ts`：

```ts
import { expect } from "chai"
import { DEFAULT_OPTIONS as MONITOR_DEFAULTS } from "../BehaviorMonitor"
import { DEFAULT_OPTIONS as MANAGER_DEFAULTS } from "../TeachingInterventionManager"
import { formatInterventionForInjection, generateBlockingInterventionMessage } from "../InterventionMessageGenerator"
import type { BehaviorAlert } from "../types"

describe("干预参数基线（方案 D 止血）", () => {
	it("★ 阻断冷却 60s（原 180s）", () => {
		expect(MANAGER_DEFAULTS.blockingCooldownMs).to.equal(60_000)
	})

	it("★ 同规则升级阈值 6（原 4），且两处副本必须一致", () => {
		expect(MONITOR_DEFAULTS.escalationBlockingThreshold).to.equal(6)
		// TeachingInterventionManager 的这份从未被读取（升级判定走 monitor.shouldEscalateToBlocking），
		// 两份不一致会造成"改了值却没生效"且无任何报错 —— 用测试锁住。
		expect(MANAGER_DEFAULTS.escalationBlockingThreshold).to.equal(MONITOR_DEFAULTS.escalationBlockingThreshold)
	})

	it("规则级冷却 120s（原 15s）", () => {
		expect(MONITOR_DEFAULTS.cooldownMs).to.equal(120_000)
	})

	it("AI 依赖阈值 0.85（原 0.7）、最少 6 条回合（原 4）", () => {
		expect(MONITOR_DEFAULTS.aiDependencyThreshold).to.equal(0.85)
		expect(MONITOR_DEFAULTS.minTurnsForDependency).to.equal(6)
	})

	it("无编辑连续阈值 8（原 5）", () => {
		expect(MONITOR_DEFAULTS.noEditTurnStreakThreshold).to.equal(8)
	})
})

describe("★ 阻断倒计时必须与实际冷却时长一致", () => {
	const alert: BehaviorAlert = {
		ruleId: "no_edit_streak",
		message: "test",
		triggeredAt: new Date().toISOString(),
		metricValue: 8,
		threshold: 8,
		escalationCount: 6,
	}

	it("60s 冷却 → countdownSeconds = 60（不得沿用模板里写死的 180）", () => {
		expect(generateBlockingInterventionMessage(alert, 60_000).countdownSeconds).to.equal(60)
	})

	it("注入文本显示 1 分钟，且不含 3 分钟", () => {
		const text = formatInterventionForInjection(generateBlockingInterventionMessage(alert, 60_000))
		expect(text).to.include("1 分钟")
		expect(text).to.not.include("3 分钟")
	})

	it("180s 冷却仍显示 3 分钟（不得把映射写反）", () => {
		const text = formatInterventionForInjection(generateBlockingInterventionMessage(alert, 180_000))
		expect(text).to.include("3 分钟")
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

Run:
```powershell
cd d:\cline
npm run test:unit -- --grep "干预参数基线|阻断倒计时必须与实际冷却时长一致" 2>&1 | Select-Object -Last 25
```

Expected: **FAIL**，报错包含
- `expected 180000 to equal 60000`
- `expected 180 to equal 60`
- 以及 `DEFAULT_OPTIONS` 未导出导致的编译错误（`has no exported member 'DEFAULT_OPTIONS'`）

- [ ] **Step 3: 导出并改值 `BehaviorMonitor.DEFAULT_OPTIONS`**

`src/core/task/student-analytics/BehaviorMonitor.ts`，把现有 `const DEFAULT_OPTIONS: Required<BehaviorMonitorOptions> = { … }` 整体替换为：

```ts
export const DEFAULT_OPTIONS: Readonly<Required<BehaviorMonitorOptions>> = Object.freeze({
	enabled: true,
	debug: false,
	windowSize: 20, // 覆盖 ~4 轮完整对话（每轮约 5 条事件）
	// 【方案 D 止血】15s → 120s。原值让同一条规则在几十秒内被反复计数，
	// 是"3 次提问就攒满升级阈值"的直接原因之一。
	cooldownMs: 120_000,
	// 【方案 D 止血】4 → 6。原值在"一次提问 = 7~11 个助手回合"的形态下太容易达到。
	minTurnsForDependency: 6,
	// 【方案 D 止血】0.7 → 0.85。原阈值在 Cline 多工具循环下几乎必然被突破
	// （实测 3/4 个任务里用户 turn_message 数为 0，比例恒 100%）。
	aiDependencyThreshold: 0.85,
	// 【方案 D 止血】5 → 8。该计数器对每个 turn_message 都 +1（助手回合也算），
	// 一次提问就能贡献 7~11，原值 5 等价于"问一句话就触发"。
	noEditTurnStreakThreshold: 8,
	consecutiveAssistantCodeThreshold: 3,
	adoptionRateThreshold: 0.7,
	selfModificationThreshold: 0.25,
	minAdoptionSamples: 2,
	// 【方案 D 止血】4 → 6。★ 权威值在本文件：升级判定走 shouldEscalateToBlocking()，
	// TeachingInterventionManager 里那份同名配置从未被读取。
	escalationBlockingThreshold: 6,
})
```

> `Object.freeze` 是安全的：构造函数用的是 `{ ...DEFAULT_OPTIONS, ...options }` 展开复制，不会写回。

- [ ] **Step 4: 同步 `TeachingInterventionManager.DEFAULT_OPTIONS`**

`src/core/task/student-analytics/TeachingInterventionManager.ts`，整体替换：

```ts
export const DEFAULT_OPTIONS: Readonly<Required<InterventionManagerOptions>> = Object.freeze({
	enabled: true,
	globalCooldownMs: 5_000, // 5 秒全局冷却（用于提示式干预）
	maxInterventionsPerTask: 10, // 单任务最多 10 次干预（含阻断）
	minTurnsBetweenInterventions: 0, // 不限制轮次间隔
	preferredStyle: "hint" as InterventionStyle, // 默认使用提示风格
	logToOutputChannel: true,
	// ⚠️ 本项在管理器内**从未被读取**（升级判定走 monitor.shouldEscalateToBlocking）。
	// 保留是为了与 BehaviorMonitor 的值保持一致；改升级阈值请改 BehaviorMonitor。
	escalationBlockingThreshold: 6,
	// 【方案 D 止血】180_000 → 60_000。阻隔 3 分钟对"概念问答误触发"场景过重。
	blockingCooldownMs: 60_000,
})
```

- [ ] **Step 5: 让倒计时由参数推导（修掉写死的 180）**

`src/core/task/student-analytics/InterventionMessageGenerator.ts`，把 `generateBlockingInterventionMessage` 的签名默认值与返回体改为：

```ts
export function generateBlockingInterventionMessage(
	alert: BehaviorAlert,
	blockingCooldownMs: number = 60_000,
): InterventionMessage {
	const template = BLOCKING_TEMPLATE_REGISTRY[alert.ruleId] ?? BLOCKING_TEMPLATE_REGISTRY.consecutive_code_generation!

	const now = new Date()
	const cooldownDate = new Date(now.getTime() + blockingCooldownMs)

	return {
		content: template.content,
		ruleId: alert.ruleId,
		severity: "strong",
		style: "blocking",
		interventionType: "blocking",
		generatedAt: now.toISOString(),
		cooldownUntil: cooldownDate.toISOString(),
		disabledFeatures: template.disabledFeatures,
		// ★ 由实际冷却时长推导，不再沿用模板里写死的 180 —— 否则注入文本会说"3 分钟"，
		// 而横幅按 blockingEndAt 从 1 分钟倒数，同屏两个数字互相矛盾。
		countdownSeconds: Math.round(blockingCooldownMs / 1000),
		blockingEndAt: cooldownDate.toISOString(),
		reflectionQuestions: template.reflectionQuestions,
	}
}
```

同时删除三个阻断模板里的 `countdownSeconds: 180,` 行（已验证除该函数外无其它读取点）：
```powershell
cd d:\cline
Select-String -Path src\core\task\student-analytics\InterventionMessageGenerator.ts -Pattern "countdownSeconds"
```
Expected: 删除后只剩 `InterventionMessage.type` 定义、`formatBlockingInterventionForInjection` 的读取、以及上面新增的赋值 —— **不应再有 `countdownSeconds: 180`**。

> 若 `BlockingTemplate` 接口的 `countdownSeconds` 变为必填而导致类型错误，把该字段改为可选 `countdownSeconds?: number`（`InterventionMessageGenerator.ts` 约 L25）。

- [ ] **Step 6: 跑测试确认通过**

Run:
```powershell
npm run test:unit -- --grep "干预参数基线|阻断倒计时必须与实际冷却时长一致" 2>&1 | Select-Object -Last 20
npx tsc --noEmit 2>&1 | Select-Object -Last 10
```

Expected: `8 passing`；`tsc` 无输出。

- [ ] **Step 7: 确认无回归**

Run:
```powershell
npm run test:unit 2>&1 | Select-Object -Last 5
```

Expected: `776 passing`、`111 pending`、`0 failing`（768 + 8）。

- [ ] **Step 8: Commit**

```bash
cd d:\cline
git add src/core/task/student-analytics/BehaviorMonitor.ts src/core/task/student-analytics/TeachingInterventionManager.ts src/core/task/student-analytics/InterventionMessageGenerator.ts src/core/task/student-analytics/__tests__/interventionParams.test.ts
git commit -m "fix(intervention): tune thresholds and derive blocking countdown from actual cooldown"
```

---

## Task 2：方案 E — 文案与指标对齐

**Files:**
- Modify: `src/core/task/student-analytics/InterventionMessageGenerator.ts`（`TEMPLATE_REGISTRY` 的导出与文案，约 L30–190）
- Test: Create `src/core/task/student-analytics/__tests__/interventionMessages.test.ts`

**Interfaces:**
- Consumes: `generateInterventionMessage(alert, preferredStyle, globalCooldownMs)`（已有）
- Produces: 三条规则的文案不再出现"**你** … **请求代码生成**"这类主谓错位的指控

**问题**：`{streak}` 实际取值是 `assistantCodeStreak` = "AI 回复里出现过代码/反引号的回合数"，但文案写成"**你**已经连续 {streak} 次**请求代码生成**"。实测 task `1790693716610`（提问"什么是python函数装饰器"）里学生**一次代码生成请求都没有**，却被连续告知"连续 5 次让我生成代码"。

- [ ] **Step 1: 写失败测试**

创建 `src/core/task/student-analytics/__tests__/interventionMessages.test.ts`：

```ts
import { expect } from "chai"
import { TEMPLATE_REGISTRY, generateInterventionMessage } from "../InterventionMessageGenerator"

describe("干预文案与指标对齐（方案 E）", () => {
	const SEVERITIES = ["gentle", "moderate", "strong"] as const

	// 直接扫描模板注册表，而不是靠 generateInterventionMessage 的随机选档 ——
	// 后者可能只抽到某一档，留下未检查的模板；而那些模板同样会被真实触发。
	it("★ consecutive_code_generation 的全部模板都不得指控学生'请求代码生成'", () => {
		for (const severity of SEVERITIES) {
			for (const t of TEMPLATE_REGISTRY.consecutive_code_generation[severity]) {
				expect(t.template, `${severity}/${t.style}`).to.not.include("请求代码生成")
				expect(t.template, `${severity}/${t.style}`).to.not.include("让我生成代码")
				expect(t.template, `${severity}/${t.style}`).to.not.include("你已经连续请求")
			}
		}
	})

	it("★ no_edit_streak 的全部模板不得写成'你没有编辑代码'的指控", () => {
		for (const severity of SEVERITIES) {
			for (const t of TEMPLATE_REGISTRY.no_edit_streak[severity]) {
				expect(t.template, `${severity}/${t.style}`).to.not.include("没有编辑代码")
			}
		}
	})

	it("★ 文案仍须保留可操作的引导（不得为了改口径把建议删空）", () => {
		for (const severity of SEVERITIES) {
			for (const t of TEMPLATE_REGISTRY.consecutive_code_generation[severity]) {
				expect(t.template.length, `${severity}/${t.style}`).to.be.greaterThan(30)
			}
		}
	})

	it("generateInterventionMessage 仍能正常产出（冒烟）", () => {
		const msg = generateInterventionMessage(
			{
				ruleId: "consecutive_code_generation",
				message: "x",
				triggeredAt: new Date().toISOString(),
				metricValue: 3,
				threshold: 3,
			},
			"hint",
			5_000,
		)
		expect(msg.content.length).to.be.greaterThan(30)
		expect(msg.ruleId).to.equal("consecutive_code_generation")
	})
})
```

> 本测试要求 `TEMPLATE_REGISTRY` 可读，因此 Task 2 需先把它导出：
> ```ts
> export const TEMPLATE_REGISTRY: Record<BehaviorRuleId, Record<InterventionSeverity, MessageTemplate[]>> = {
> ```
> （只加 `export`，内容不动。它是只读常量，导出不会带来副作用。）

- [ ] **Step 2: 跑测试确认失败**

Run:
```powershell
npm run test:unit -- --grep "干预文案与指标对齐" 2>&1 | Select-Object -Last 25
```
Expected: **FAIL** —— `consecutive_code_generation` 的模板含"你已经连续 3 次请求代码生成"，`no_edit_streak` 含"你已经 3 轮没有编辑代码了"。

- [ ] **Step 3: 改写 `consecutive_code_generation` 三档模板**

把 `TEMPLATE_REGISTRY.consecutive_code_generation` 整体替换为：

```ts
	consecutive_code_generation: {
		gentle: [
			{
				style: "hint",
				template:
					"💡 学习提示：刚才我连续 {streak} 轮给出的内容里都带了代码。要不要换一下顺序 —— 你先说说打算怎么实现，我再帮你补细节？",
			},
			{
				style: "question",
				template:
					"🤔 思考一下：这 {streak} 轮我都给了代码。这里面哪一段是你已经能自己写出来的？试着从那段开始动手。",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 学习引导：我已经连续 {streak} 轮直接给代码了。在继续之前，能否先讲讲你对当前实现的理解？比如：核心逻辑分几步？",
			},
			{
				style: "challenge",
				template:
					"🎯 小挑战：这 {streak} 轮都是我写代码。这一轮你先写出函数签名和核心步骤，我来帮你补充和检查，好吗？",
			},
		],
		strong: [
			{
				style: "challenge",
				template:
					"🎯 动手实践：我已经连续 {streak} 轮提供完整代码了。为了真正掌握，请先自己实现核心部分，遇到具体卡点再来问我。",
			},
			{
				style: "reflection",
				template:
					"📝 学习反思：这 {streak} 轮你拿到的都是现成代码。请回顾一下：其中的核心逻辑你能独立复述吗？哪一部分你最没把握？",
			},
		],
	},
```

> **改口径的关键**：主语从"**你**请求代码生成"改为"**我**（AI）给出的内容里带了代码"。指标本来就是后者，这样文案不再撒谎，而教学意图（鼓励学生先动手）完整保留。

- [ ] **Step 4: 改写 `no_edit_streak` 三档模板**

把 `TEMPLATE_REGISTRY.no_edit_streak` 整体替换为：

```ts
	no_edit_streak: {
		gentle: [
			{
				style: "hint",
				template:
					"💡 实践建议：最近 {streak} 轮我们都在聊，还没动手改过代码。想不想挑一处小地方试试 —— 改个变量名、加一行注释都算开始。",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 想一想：最近 {streak} 轮我们都没有碰代码。是哪里不确定、不知道从哪下手吗？说说你卡住的位置，我们一起拆开看。",
			},
			{
				style: "challenge",
				template:
					"🎯 小任务：在看我的下一条回复之前，先试着改一个小地方，然后告诉我你改了什么、为什么这么改。",
			},
		],
		strong: [
			{
				style: "reflection",
				template:
					"📝 学习反思：我们已经连续 {streak} 轮没有动手写代码了。编程是实践技能，读懂和写出之间还有一段距离。现在就打开编辑器，试着修改或重写我们正在讨论的那部分函数中的一小段。",
			},
		],
	},
```

- [ ] **Step 5: 改写 `high_adoption_low_self_modification` 与 `high_recent_ai_dependency` 的措辞**

把这两条的模板中的主语/措辞按同一原则调整（保留全部三档与风格字段，只改 `template` 字符串）：

| 规则 | 现有措辞问题 | 改为 |
|---|---|---|
| `high_adoption_low_self_modification` | "你对 AI 建议的采纳率较高…自主修改较少" | 保留（该指标确实基于学生的采纳行为，无主谓错位）→ **不改** |
| `high_recent_ai_dependency` | "AI 参与度达到 {percent}%" | 措辞基本准确，但 `{percent}` 在 Cline 多工具循环下恒为 100% → 改为不强调具体数字的表述，并加一句"如果你只是一直在提问、我一直在检索和整理答案，这很正常；这里想确认的是你有没有自己动手的打算" |

具体替换 `high_recent_ai_dependency` 的 `gentle` / `moderate` / `strong` 三个 `template`：

```ts
	high_recent_ai_dependency: {
		gentle: [
			{
				style: "hint",
				template:
					"💡 独立编码提示：这几轮基本都是我在说。要不要先自己构思一下解题思路，再把具体问题提给我？",
			},
		],
		moderate: [
			{
				style: "question",
				template:
					"🤔 换个方式：这几轮大多是你在提问、我在整理答案。你能否先用伪代码或自然语言描述一下你想实现的逻辑？这样我能针对性帮你，你也能更清楚自己的思路。",
			},
		],
		strong: [
			{
				style: "reflection",
				template:
					"📝 学习反思：这段时间基本是我在输出。请想一想：如果没有我帮忙，当前任务的哪些部分你能独立完成？哪些知识点还需要补？",
			},
			{
				style: "challenge",
				template:
					"🎯 自主练习：请先关掉这个对话，尝试独立编写当前功能的核心逻辑（不完整也没关系），然后带着你的代码和具体问题回来，我帮你诊断和改进。",
			},
		],
	},
```

> 同时把阻断模板 `high_recent_ai_dependency.content` 里的"系统检测到最近的交互中 AI 参与占比过高"改为
> "系统检测到最近几轮基本由 AI 输出、缺少你自己的动手环节"，避免向学生断言一个它无法验证的百分比。

- [ ] **Step 6: 跑测试确认通过**

```powershell
npm run test:unit -- --grep "干预文案与指标对齐" 2>&1 | Select-Object -Last 20
npx tsc --noEmit 2>&1 | Select-Object -Last 10
```
Expected: `4 passing`；`tsc` 无输出。
- [ ] **Step 7: 确认无回归**

```powershell
npm run test:unit 2>&1 | Select-Object -Last 5
```
Expected: `780 passing`、`111 pending`、`0 failing`。

- [ ] **Step 8: Commit**

```bash
git add src/core/task/student-analytics/InterventionMessageGenerator.ts src/core/task/student-analytics/__tests__/interventionMessages.test.ts
git commit -m "fix(intervention): align message wording with the metric it is derived from"
```

---

## Task 3a：建公共 Markdown/代码块模块（含迁移 sanitizer）

> **决策依据**：开车前预检的 ① 选了 **B + B+**。
>
> 为什么不能等：Task 3（`ContentAnalyzer.countCodeBlocks`）与 Task 5（`conceptModeConstraint.detectConceptModeViolation`）
> 都要"解析 fenced 代码块"。两处各持一份正则的代价不是"重复 1 行"，而是**"块边界怎么算"被解释两遍**
> （未闭合围栏、无语言标签、`\r\n`、空块），且后续迭代只改一处就静默漂移。
> 同时把 Task 3 原本要引入的跨层依赖（`student-analytics` → `core/teaching/assistantTextSanitizer`）一并消除。

**Files:**
- Create: `src/shared/markdown/codeBlocks.ts`
- Create: `src/shared/markdown/__tests__/codeBlocks.test.ts`
- Move: `src/core/teaching/assistantTextSanitizer.ts` → `src/shared/markdown/toolCallMarkup.ts`
- Move: `src/core/teaching/__tests__/assistantTextSanitizer.test.ts` → `src/shared/markdown/__tests__/toolCallMarkup.test.ts`
- Modify: `src/core/task/index.ts`（import 路径）
- Modify: `docs/design/wiki-mcp-retrieval-acceptance.md`、`docs/design/teaching-features.md`（路径引用）

**Interfaces:**
- Produces:
  ```ts
  export interface CodeBlock {
  	raw: string
  	lang: string
  	inner: string
  	lineCount: number
  }
  export function parseFencedCodeBlocks(text: string): CodeBlock[]
  ```
- Produces: `stripLeakedToolCallMarkup(text: string): string` 改从 `@/shared/markdown/toolCallMarkup` 导出（**签名不变**）

- [ ] **Step 1: 写失败的测试**

创建 `src/shared/markdown/__tests__/codeBlocks.test.ts`：

```ts
import { expect } from "chai"
import { parseFencedCodeBlocks } from "../codeBlocks"

describe("parseFencedCodeBlocks", () => {
	it("解析语言标签与内容行数（空行不计）", () => {
		const [b] = parseFencedCodeBlocks("```python\na = 1\n\nb = 2\n```")
		expect(b.lang).to.equal("python")
		expect(b.lineCount).to.equal(2)
		expect(b.inner).to.equal("a = 1\n\nb = 2")
	})

	it("无语言标签时 lang 为空串", () => {
		expect(parseFencedCodeBlocks("```\nx\n```")[0].lang).to.equal("")
	})

	it("★ 行内代码不算块", () => {
		expect(parseFencedCodeBlocks("`x` 是个变量")).to.deep.equal([])
	})

	it("★ 多个块全部解析", () => {
		expect(parseFencedCodeBlocks("```\na\n```\n中间文字\n```python\nb\nc\n```")).to.have.lengthOf(2)
	})

	it("★ 未闭合的围栏不算一个块（流式中间态）", () => {
		expect(parseFencedCodeBlocks("```python\na = 1\n")).to.deep.equal([])
	})

	it("空输入 / null 输入", () => {
		expect(parseFencedCodeBlocks("")).to.deep.equal([])
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
cd d:\cline
npm run test:unit -- --grep "parseFencedCodeBlocks" 2>&1 | Select-Object -Last 20
```
Expected: **FAIL**（模块不存在）。

- [ ] **Step 3: 实现 `codeBlocks.ts`**

创建 `src/shared/markdown/codeBlocks.ts`（Tab 缩进）：

```ts
export interface CodeBlock {
	/** 原始片段，含首尾围栏与语言标签 */
	raw: string
	/** 语言标签（无标签时为空串） */
	lang: string
	/** 去掉首尾围栏与语言标签后的内容 */
	inner: string
	/** 内容中“非空行”的条数 */
	lineCount: number
}

/** 匹配成对闭合的 fenced 代码块。刻意不匹配未闭合的围栏（流式中间态不应当作完整代码块处理） */
const FENCED = /```[^\n]*\n?[\s\S]*?```/g

export function parseFencedCodeBlocks(text: string): CodeBlock[] {
	if (!text) {
		return []
	}
	const out: CodeBlock[] = []
	for (const raw of text.match(FENCED) ?? []) {
		const inner = raw.replace(/^```[^\n]*\n?/, "").replace(/```\s*$/, "")
		const header = raw.match(/^```([^\n]*)/)
		out.push({
			raw,
			lang: (header?.[1] ?? "").trim(),
			inner,
			lineCount: inner.split("\n").filter((l) => l.trim().length > 0).length,
		})
	}
	return out
}
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npm run test:unit -- --grep "parseFencedCodeBlocks" 2>&1 | Select-Object -Last 20
```
Expected: `6 passing`。

- [ ] **Step 5: 迁移 sanitizer 到公共模块（B+）**

```bash
cd d:\cline
git mv src/core/teaching/assistantTextSanitizer.ts src/shared/markdown/toolCallMarkup.ts
git mv src/core/teaching/__tests__/assistantTextSanitizer.test.ts src/shared/markdown/__tests__/toolCallMarkup.test.ts
```

然后改测试文件的 import：

```ts
import { stripLeakedToolCallMarkup } from "../toolCallMarkup"
```

再改 `src/core/task/index.ts` 里的 import（路径只有这一处）：

```ts
import { stripLeakedToolCallMarkup } from "@/shared/markdown/toolCallMarkup"
```

> ⚠️ 此改动会改变**已入库改动的文件路径**（前两次提交里的 `assistantTextSanitizer.ts`）。
> 必须在同一提交里更新文档引用，否则 `wiki-mcp-retrieval-acceptance.md` §7.1 会指向不存在的路径。

- [ ] **Step 6: 更新文档里的路径引用**

```powershell
cd d:\cline
Select-String -Path docs\design\*.md -Pattern "assistantTextSanitizer" | Select-Object -ExpandProperty Path -Unique
```

把命中的每一处 `src/core/teaching/assistantTextSanitizer.ts` 改为 `src/shared/markdown/toolCallMarkup.ts`
（预期命中：`wiki-mcp-retrieval-acceptance.md`、`teaching-features.md`）。改完重跑上句确认**零命中**。

- [ ] **Step 7: 全量校验**

```powershell
npx tsc --noEmit 2>&1 | Select-Object -Last 10
npm run test:unit 2>&1 | Select-Object -Last 5
```
Expected: `tsc` 无输出；`786 passing`（780 + 6）、`111 pending`、`0 failing`。

- [ ] **Step 8: Commit**

```bash
git add -A src/shared/markdown src/core/task/index.ts docs/design
git commit -m "refactor(shared): extract markdown code-block parser and move markup sanitizer"
```

---

## Task 3：方案 A — 修正「含代码」判定

**Files:**
- Modify: `src/core/task/student-analytics/ContentAnalyzer.ts`（`detectCode`、`analyze`）
- Modify: `src/core/task/student-analytics/types.ts`（`ContentAnalysisResult`、`StudentInteractionLog`）
- Modify: `src/core/task/student-analytics/BehaviorMonitor.ts`（`updateRealtimeStreaks`）
- Modify: `src/core/task/index.ts`（`persistAssistantTurnLog`）
- Test: Create `src/core/task/student-analytics/__tests__/contentAnalyzer.test.ts`
- Test: Create `src/core/task/student-analytics/__tests__/behaviorMonitor.streak.test.ts`

**Interfaces:**
- Consumes: `stripLeakedToolCallMarkup(text: string): string` 与 `parseFencedCodeBlocks(text: string): CodeBlock[]`
  （均来自 `src/shared/markdown/`，Task 3a 产出）
- Produces: `ContentAnalysisResult` 新增 `hasCodeBlock: boolean` 与 `hasInlineCode: boolean`
- Produces: `StudentInteractionLog` 新增可选字段 `hasCodeBlock?: boolean`
- Produces: `BehaviorMonitor` 的 `assistantCodeStreak` 改读 `event.hasCodeBlock ?? event.hasCode`

> **依赖方向说明**：不再需要跨层依赖 —— `stripLeakedToolCallMarkup` 已在 Task 3a 迁移到 `src/shared/markdown/toolCallMarkup.ts`，`student-analytics` 引用 `@/shared/*` 属于正常方向。

**背景（实测证据）**：`hasCode=true` 有两类来源，都不是"学生要代码"：
1. **DSML 工具标记**：`codeIndicators` 第 2 条 `[{}[\]();]`（`arguments` 值为 `{}`）+ 第 5 条赋值样式 `name=...`（`name="server_name"`）→ 凑满 2 条即判真。
2. **行内代码**：`codeBlockPatterns` 第 2 条 `/(`[^`\n]+`)/g`，**单个反引号即算代码**（如 `` `wiki_backend_unreachable` ``）。

- [ ] **Step 1: 写失败的 `ContentAnalyzer` 测试**

创建 `src/core/task/student-analytics/__tests__/contentAnalyzer.test.ts`：

```ts
import { expect } from "chai"
import { ContentAnalyzer } from "../ContentAnalyzer"

const P = String.fromCharCode(0xff5c) // 全角竖线 U+FF5C
const T = (s: string): string => s.replace(/%P%/g, `${P}${P}`)

describe("ContentAnalyzer.detectCode（方案 A）", () => {
	const a = new ContentAnalyzer()

	it("★ 纯工具调用标记不得判为代码（实测误判来源）", () => {
		const leaked = T(
			[
				"<%P%DSML%P% calls>",
				'<%P%DSML%P% invoke name="use_mcp_tool">',
				'<%P%DSML%P% parameter name="server_name">wiki<%P%/DSML%P% parameter>',
				'<%P%DSML%P% parameter name="arguments">{}<%P%/DSML%P% parameter>',
				"<%P%/DSML%P% invoke>",
				"<%P%/DSML%P% calls>",
			].join("\n"),
		)
		const r = a.analyze(leaked)
		expect(r.hasCode).to.equal(false)
		expect(r.hasCodeBlock).to.equal(false)
	})

	it("★ 含完整代码块 → hasCodeBlock=true（真正的代码生成信号，必须保留）", () => {
		const code = ["```python", "def bubble_sort(a):", "    for i in range(len(a)):", "        pass", "```"].join("\n")
		const r = a.analyze(`冒泡排序可以这样写：\n${code}\n注意边界。`)
		expect(r.hasCode).to.equal(true)
		expect(r.hasCodeBlock).to.equal(true)
		expect(r.codeBlockCount).to.equal(1)
	})

	it("★ 仅行内代码 → hasCodeBlock=false（提及不等于生成）", () => {
		const r = a.analyze("资料库当前无法连接（`wiki_backend_unreachable`），我换个关键词试试。")
		expect(r.hasCodeBlock).to.equal(false)
		expect(r.hasInlineCode).to.equal(true)
	})

	it("学生正文里的 markdown 表格竖线与比较符号不得判为代码", () => {
		const r = a.analyze("| 周 | 内容 |\n|---|---|\n| 1 | 起步 |\n\n当 a < b 时交换。")
		expect(r.hasCode).to.equal(false)
		expect(r.hasCodeBlock).to.equal(false)
	})

	it("工具标记被剔除后，同段文本里的真代码块仍能被识别", () => {
		const mixed = T(["<%P%DSML%P% calls>", "下面给你一个例子：", "```python", "print(a)", "```"].join("\n"))
		const r = a.analyze(mixed)
		expect(r.hasCodeBlock).to.equal(true)
	})
})

describe("ContentAnalyzer.detectCodeBlock", () => {
	const a = new ContentAnalyzer()

	it("仅统计 fenced 代码块，不把行内代码算进去", () => {
		expect(a.detectCodeBlock("`x` 是个变量")).to.equal(false)
		expect(a.detectCodeBlock("```\nx = 1\n```")).to.equal(true)
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npm run test:unit -- --grep "ContentAnalyzer" 2>&1 | Select-Object -Last 25
```
Expected: **FAIL** —— `hasCodeBlock` / `hasInlineCode` 不存在（TS 报错），且第一条断言 `expected true to equal false`。

- [ ] **Step 3: 扩展 `ContentAnalysisResult` 与 `StudentInteractionLog`**

`src/core/task/student-analytics/types.ts`。

`ContentAnalysisResult` 改为：

```ts
export interface ContentAnalysisResult {
	/** 内容长度 */
	contentLength: number
	/** 是否包含代码（= hasCodeBlock || hasInlineCode || 代码特征足够多） */
	hasCode: boolean
	/** 【v2.13】是否含 fenced 代码块 —— 这才是"AI 真的给出了代码"的信号 */
	hasCodeBlock: boolean
	/** 【v2.13】是否仅含行内代码（单反引号）—— 与"提及"等价，不构成代码生成 */
	hasInlineCode: boolean
	/** 推断的语言类型 */
	languageHint: LanguageHint
	/** 检测到的代码片段数量（仅 fenced） */
	codeBlockCount: number
}
```

`StudentInteractionLog` 在 `hasCode` 之后新增：

```ts
	/** 【v2.13】是否含 fenced 代码块（仅 role=assistant 时有值；streak 只认它） */
	hasCodeBlock?: boolean
```

- [ ] **Step 4: 改 `ContentAnalyzer`**

`src/core/task/student-analytics/ContentAnalyzer.ts`：

1. 文件顶部新增 import：

```ts
import { parseFencedCodeBlocks } from "@/shared/markdown/codeBlocks"
import { stripLeakedToolCallMarkup } from "@/shared/markdown/toolCallMarkup"
import type { ContentAnalysisResult, LanguageHint } from "./types"
```

> `countCodeBlocks` 改为基于公共解析器，不再自持正则：
> ```ts
> 	public countCodeBlocks(text: string): number {
> 		return parseFencedCodeBlocks(text).length
> 	}
> ```

2. `analyze()` 改为：

```ts
	public analyze(text?: string): ContentAnalysisResult {
		if (!text) {
			return {
				contentLength: 0,
				hasCode: false,
				hasCodeBlock: false,
				hasInlineCode: false,
				languageHint: "unknown",
				codeBlockCount: 0,
			}
		}

		// ★ 先剔除模型泄漏的工具调用标记再判定。
		// 实测（taskId=1790691098981 等 4 个任务）：DSML 标记里的 `{}` 与 `name="…"`
		// 恰好凑满 codeIndicators 的 2 条阈值，导致"纯工具调用回合"被判成含代码，
		// 直接把 assistantCodeStreak 推到触发阈值。
		const scrubbed = stripLeakedToolCallMarkup(text)

		const contentLength = this.getContentLength(text)
		const codeBlockCount = this.countCodeBlocks(scrubbed)
		const hasCodeBlock = this.detectCodeBlock(scrubbed)
		const hasInlineCode = this.detectInlineCode(scrubbed)
		// 【② 已决 = B1】所有判定统一基于剔除工具标记后的文本
		const hasCode = this.detectCode(scrubbed)
		const languageHint = this.inferLanguage(scrubbed)

		return {
			contentLength,
			hasCode,
			hasCodeBlock,
			hasInlineCode,
			languageHint,
			codeBlockCount,
		}
	}
```

> **② 已决 = B1：`hasCode` 也基于剔除后的文本。**
> 这会让纯工具标记回合的 `hasCode` 从 `true` 变为 `false` —— **6 个读取方全部自动修好**，无需逐个改造。
> 代价：**教师端看板的 `codeGenerationRatio` 会下降**（旧值虚高），属口径变化。

3. 新增两个方法：

```ts
	/**
	 * 是否含 fenced 代码块（```…```）
	 */
	public detectCodeBlock(text: string): boolean {
		return this.countCodeBlocks(text) > 0
	}

	/**
	 * 是否含行内代码（单反引号包裹）
	 */
	public detectInlineCode(text: string): boolean {
		return /`[^`\n]+`/.test(text)
	}
```

- [ ] **Step 5: 跑 `ContentAnalyzer` 测试确认通过**

```powershell
npm run test:unit -- --grep "ContentAnalyzer" 2>&1 | Select-Object -Last 20
```
Expected: `7 passing`。

- [ ] **Step 6: 写 `BehaviorMonitor` streak 测试（当前应失败）**

创建 `src/core/task/student-analytics/__tests__/behaviorMonitor.streak.test.ts`：

```ts
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import type { StudentInteractionLog } from "../types"

const turn = (taskId: string, role: "user" | "assistant", idx: number, extra: Partial<StudentInteractionLog> = {}): StudentInteractionLog => ({
	ts: new Date().toISOString(),
	taskId,
	eventType: "turn_message",
	role,
	category: "explanation",
	contentLength: 10,
	hasCode: false,
	languageHint: "python",
	imageCount: 0,
	fileCount: 0,
	turnIndex: idx,
	...extra,
})

// 关掉规则级冷却，让每次 ingest 都立刻评估规则
describe("BehaviorMonitor — assistantCodeStreak 只认 fenced 代码块（方案 A）", () => {
	it("★ 仅行内代码的助手回合不得推高 streak", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		for (let i = 1; i <= 5; i++) {
			m.ingest(turn("t1", "assistant", i, { hasCode: true, hasCodeBlock: false }))
		}
		// 阈值 3；若仍按 hasCode 计数会触发 consecutive_code_generation
		expect(m.getPendingAlerts().some((a) => a.ruleId === "consecutive_code_generation")).to.equal(false)
	})

	it("★ 含 fenced 代码块的助手回合仍然推高 streak（真实信号不得丢）", () => {
		const m = new BehaviorMonitor("t2", { cooldownMs: 0 })
		for (let i = 1; i <= 3; i++) {
			m.ingest(turn("t2", "assistant", i, { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getPendingAlerts().some((a) => a.ruleId === "consecutive_code_generation")).to.equal(true)
	})

	it("缺少 hasCodeBlock 的旧事件回退到 hasCode（兼容）", () => {
		const m = new BehaviorMonitor("t3", { cooldownMs: 0 })
		for (let i = 1; i <= 3; i++) {
			m.ingest(turn("t3", "assistant", i, { hasCode: true }))
		}
		expect(m.getPendingAlerts().some((a) => a.ruleId === "consecutive_code_generation")).to.equal(true)
	})
})
```

- [ ] **Step 7: 跑测试确认失败**

```powershell
npm run test:unit -- --grep "assistantCodeStreak 只认 fenced 代码块" 2>&1 | Select-Object -Last 20
```
Expected: 第 1 条 **FAIL**（`expected true to equal false`）。

- [ ] **Step 8: 改 `BehaviorMonitor.updateRealtimeStreaks`**

把该方法里助手分支的判断改为：

```ts
			if (event.role === "assistant") {
				// 【v2.13 方案 A】streak 只认 **fenced 代码块**，不再认"文本里出现过代码/反引号/工具标记"。
				// 实测：DSML 工具标记与行内代码（如 `wiki_backend_unreachable`）都会被旧判定算成代码，
				// 把一个纯概念问答任务在几个回合内推到触发阈值。
				// 兼容：缺少该字段的旧事件回退到 hasCode。
				const hasRealCode = event.hasCodeBlock ?? event.hasCode
				if (hasRealCode) {
					this.assistantCodeStreak++
				}
			}
```

- [ ] **Step 9: 跑测试确认通过**

```powershell
npm run test:unit -- --grep "assistantCodeStreak 只认 fenced 代码块" 2>&1 | Select-Object -Last 20
```
Expected: `3 passing`。

- [ ] **Step 10: 把 `hasCodeBlock` 写进日志 + 修掉 `inferSuggestionType` 的同类漏判**

`src/core/task/index.ts`：

**(a)** `persistAssistantTurnLog`：在组装 `log` 时，紧跟 `hasCode: analysis.hasCode,` 之后插入一行：

```ts
				hasCode: analysis.hasCode,
				// 【v2.13 方案 A】新增字段（不改旧字段语义）：streak 与离线统计都改用它
				hasCodeBlock: analysis.hasCodeBlock,
				languageHint: analysis.languageHint,
```

**(b)** ⚠️ **同类漏判（必须一起修）**：`inferSuggestionType()` 里的这一行**直接调 `detectCode`，绕过了 `analyze()`**，
所以不会受益于 B1 的剔除逻辑 —— 纯工具标记回合仍会被标成 `suggestionType = "code_generation"`：

```ts
			if (contentAnalyzer.detectCode(assistantText)) {
				return "code_generation"
			}
```

改为：

```ts
			// 【方案 A】先剔除工具标记再判定，否则纯工具调用回合会被标成 code_generation
			// —— 这正是最初报告的现象（"调用 wiki 工具进行检索时被记录为请求代码生成"）。
			if (contentAnalyzer.detectCode(stripLeakedToolCallMarkup(assistantText))) {
				return "code_generation"
			}
```

> `stripLeakedToolCallMarkup` 在本文件的 import 已由 Task 3a 建立，无需新增 import。

- [ ] **Step 11: 全量校验**

```powershell
npx tsc --noEmit 2>&1 | Select-Object -Last 10
npm run test:unit 2>&1 | Select-Object -Last 5
```
Expected: `tsc` 无输出；`796 passing`、`111 pending`、`0 failing`。

- [ ] **Step 12: Commit**

```bash
git add src/core/task/student-analytics/ContentAnalyzer.ts src/core/task/student-analytics/types.ts src/core/task/student-analytics/BehaviorMonitor.ts src/core/task/index.ts src/core/task/student-analytics/__tests__/contentAnalyzer.test.ts src/core/task/student-analytics/__tests__/behaviorMonitor.streak.test.ts
git commit -m "fix(analytics): count only fenced code blocks toward the code-generation streak"
```

---

## Task 4：方案 C-1 — 按任务类型分流规则

**Files:**
- Create: `src/core/task/student-analytics/rulePolicy.ts`
- Modify: `src/core/task/student-analytics/BehaviorMonitor.ts`（捕获 `taskCategory`；`evaluateRules` 按策略跳过；`shouldEscalateToBlocking` 按策略限制）
- Test: Create `src/core/task/student-analytics/__tests__/rulePolicy.test.ts`

**Interfaces:**
- Produces: `getRulePolicy(ruleId: BehaviorRuleId, category: TaskCategory | undefined): { enabled: boolean; canEscalateToBlocking: boolean }`
- Produces: `BehaviorMonitor.ingest()` 在 `event.role === "user"` 时记录 `currentTaskCategory`；新增公开只读访问器 `getTaskCategory(): TaskCategory | undefined`

> **注入通道是现成的**：学生首句提问以 `eventType: "task_start"`+`role: "user"` 进入 `monitorBehavior()`（`src/core/task/index.ts:1027`），后续追问以 `turn_message`+`role: "user"` 进入（`:1071`）。两者都带 `category`，所以 **`BehaviorMonitor` 无需任何新构造参数或透传改造**。

- [ ] **Step 1: 写失败测试（策略纯函数）**

创建 `src/core/task/student-analytics/__tests__/rulePolicy.test.ts`：

```ts
import { expect } from "chai"
import { getRulePolicy } from "../rulePolicy"
import type { BehaviorRuleId, TaskCategory } from "../types"

const ALL_RULES: BehaviorRuleId[] = [
	"consecutive_code_generation",
	"no_edit_streak",
	"high_adoption_low_self_modification",
	"high_recent_ai_dependency",
]

describe("getRulePolicy（方案 C-1）", () => {
	it("★ 概念问答（explanation）下停用代码类规则", () => {
		for (const rule of ["consecutive_code_generation", "no_edit_streak"] as BehaviorRuleId[]) {
			expect(getRulePolicy(rule, "explanation").enabled, rule).to.equal(false)
		}
	})

	it("★ 算法思路（algorithm）同样停用代码类规则", () => {
		for (const rule of ["consecutive_code_generation", "no_edit_streak"] as BehaviorRuleId[]) {
			expect(getRulePolicy(rule, "algorithm").enabled, rule).to.equal(false)
		}
	})

	it("★ 概念问答下 AI 依赖规则仍启用，但不得升级为阻断", () => {
		const p = getRulePolicy("high_recent_ai_dependency", "explanation")
		expect(p.enabled).to.equal(true)
		expect(p.canEscalateToBlocking).to.equal(false)
	})

	it("★ 代码类任务下所有规则都启用且可升级", () => {
		for (const category of ["code_generation", "debugging", "refactoring", "testing"] as TaskCategory[]) {
			for (const rule of ALL_RULES) {
				const p = getRulePolicy(rule, category)
				expect(p.enabled, `${category}/${rule}`).to.equal(true)
				expect(p.canEscalateToBlocking, `${category}/${rule}`).to.equal(true)
			}
		}
	})

	it("★ 分类未知 / other / language_request 时保守启用全部（不得因分类失败而静默失效）", () => {
		for (const category of [undefined, "other", "language_request"] as Array<TaskCategory | undefined>) {
			for (const rule of ALL_RULES) {
				expect(getRulePolicy(rule, category).enabled, `${category}/${rule}`).to.equal(true)
			}
		}
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npm run test:unit -- --grep "getRulePolicy" 2>&1 | Select-Object -Last 20
```
Expected: **FAIL**（模块不存在）。

- [ ] **Step 3: 实现 `rulePolicy.ts`**

创建 `src/core/task/student-analytics/rulePolicy.ts`（Tab 缩进）：

```ts
/**
 * 规则策略（方案 C-1）
 *
 * 背景：4 条规则原本对任何任务都启用，但它们的阈值是按"学生在写代码、AI 在旁辅助"设计的。
 * 学生端当前的主要用法是"提问 → AI 检索资料并讲解"，在这个用法下：
 *   - 学生本来就不编辑代码 → no_edit_streak 恒真
 *   - 一次提问产生多个助手回合 → high_recent_ai_dependency 恒 > 0.7
 *   - Python 讲解必然出现代码/反引号 → consecutive_code_generation 极易触发
 * 三条规则同时近似恒真 + 升级阈值小 = 几轮内必然阻断。
 *
 * 本模块把"什么时候该干预"显式编码为纯函数，便于单测与离线复算。
 */

import type { BehaviorRuleId, TaskCategory } from "./types"

export interface RulePolicy {
	/** 该规则是否参与评估 */
	enabled: boolean
	/** 命中后是否允许累计升级为阻断式干预 */
	canEscalateToBlocking: boolean
}

/** 以"讲解/思路"为主的分类：学生的意图是理解，不是要可运行代码 */
const CONCEPTUAL_CATEGORIES: ReadonlySet<TaskCategory> = new Set<TaskCategory>(["explanation", "algorithm"])

/** 在概念问答场景下没有意义的代码类规则 */
const CODE_ORIENTED_RULES: ReadonlySet<BehaviorRuleId> = new Set<BehaviorRuleId>([
	"consecutive_code_generation",
	"no_edit_streak",
])

/**
 * 判定某条规则在给定任务分类下的策略。
 *
 * 保守原则：分类缺失/未知/other/language_request 时**全部启用且可升级** ——
 * 宁可保留原有干预能力，也不要因为分类器没命中而让干预静默失效。
 */
export function getRulePolicy(ruleId: BehaviorRuleId, category: TaskCategory | undefined): RulePolicy {
	if (!category || !CONCEPTUAL_CATEGORIES.has(category)) {
		return { enabled: true, canEscalateToBlocking: true }
	}

	// 概念问答：代码类规则整体停用
	if (CODE_ORIENTED_RULES.has(ruleId)) {
		return { enabled: false, canEscalateToBlocking: false }
	}

	// 其余规则（AI 依赖 / 只采纳不消化）仍保留提示，但不允许升级为阻断 ——
	// 因为在这类任务里它们的分母（user turn_message 数）天然极小，比例指标不可靠。
	return { enabled: true, canEscalateToBlocking: false }
}
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npm run test:unit -- --grep "getRulePolicy" 2>&1 | Select-Object -Last 15
```
Expected: `5 passing`。

- [ ] **Step 5: 在 `BehaviorMonitor` 中接入**

`src/core/task/student-analytics/BehaviorMonitor.ts`：

1. 顶部新增 import：
```ts
import { getRulePolicy } from "./rulePolicy"
import type { BehaviorAlert, BehaviorRuleId, StudentInteractionLog, TaskCategory } from "./types"
```

2. 新增私有字段（与 `assistantCodeStreak` 同区域）：
```ts
	/** 【方案 C-1】最近一次**学生**事件的意图分类（用于规则分流） */
	private currentTaskCategory: TaskCategory | undefined
```

3. `ingest()` 里，在 `this.updateRealtimeStreaks(event)` **之前**插入：
```ts
		// 【方案 C-1】只采纳"学生侧"事件的分类：首句提问是 task_start，后续追问是 turn_message。
		// 助手事件里也带 category，但那是"AI 输出被分成什么"，不能当学生意图用。
		if (event.eventType === "task_start" || (event.eventType === "turn_message" && event.role === "user")) {
			this.currentTaskCategory = event.category
		}
```

4. 新增公开访问器：
```ts
	/** 【方案 C-1】当前任务的学生意图分类（未捕获到时为 undefined） */
	public getTaskCategory(): TaskCategory | undefined {
		return this.currentTaskCategory
	}
```

5. `evaluateRules()` 改为按策略执行：
```ts
	private evaluateRules(): void {
		// 【方案 C-1】按学生意图分流：概念问答下停用代码类规则
		const policy = (ruleId: BehaviorRuleId): boolean => getRulePolicy(ruleId, this.currentTaskCategory).enabled

		if (policy("consecutive_code_generation")) {
			this.checkConsecutiveCodeGenerationRule()
		}
		if (policy("no_edit_streak")) {
			this.checkNoEditStreakRule()
		}
		if (policy("high_adoption_low_self_modification")) {
			this.checkHighAdoptionLowSelfModificationRule()
		}
		if (policy("high_recent_ai_dependency")) {
			this.checkHighRecentAiDependencyRule()
		}
	}
```

6. `shouldEscalateToBlocking()` 改为再查一次策略：
```ts
	public shouldEscalateToBlocking(ruleId: BehaviorRuleId): boolean {
		if (this.blockingTriggered) {
			return false // 同一任务内阻断仅触发一次
		}
		// 【方案 C-1】概念问答场景下不允许升级为阻断
		if (!getRulePolicy(ruleId, this.currentTaskCategory).canEscalateToBlocking) {
			return false
		}
		const count = this.getEscalationCount(ruleId)
		return count >= this.options.escalationBlockingThreshold
	}
```

7. `reset()` 里把 `this.currentTaskCategory = undefined` 与其它字段一起清空（`BehaviorMonitor.ts` 约 L330–340）。

- [ ] **Step 6: 写并跑集成测试（分流生效）**

创建 `src/core/task/student-analytics/__tests__/behaviorMonitor.taskCategory.test.ts`：

```ts
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import type { StudentInteractionLog, TaskCategory } from "../types"

const ev = (
	taskId: string,
	role: "user" | "assistant",
	idx: number,
	category: TaskCategory,
	extra: Partial<StudentInteractionLog> = {},
): StudentInteractionLog => ({
	ts: new Date().toISOString(),
	taskId,
	eventType: "turn_message",
	role,
	category,
	contentLength: 10,
	hasCode: false,
	languageHint: "python",
	imageCount: 0,
	fileCount: 0,
	turnIndex: idx,
	...extra,
})

const taskStart = (taskId: string, category: TaskCategory): StudentInteractionLog => ({
	...ev(taskId, "user", 0, category),
	eventType: "task_start",
})

describe("BehaviorMonitor — 按学生意图分流（方案 C-1）", () => {
	it("★ 概念问答：即使连续 5 个助手回合都含代码，也不触发代码类规则", () => {
		const m = new BehaviorMonitor("c1", { cooldownMs: 0 })
		m.ingest(taskStart("c1", "explanation"))
		for (let i = 1; i <= 5; i++) {
			m.ingest(ev("c1", "assistant", i, "explanation", { hasCode: true, hasCodeBlock: true }))
		}
		const rules = m.getPendingAlerts().map((a) => a.ruleId)
		expect(rules).to.not.include("consecutive_code_generation")
		expect(rules).to.not.include("no_edit_streak")
	})

	it("★ 代码生成任务：同样的序列必须仍然触发（干预机制不得失效）", () => {
		const m = new BehaviorMonitor("c2", { cooldownMs: 0 })
		m.ingest(taskStart("c2", "code_generation"))
		for (let i = 1; i <= 5; i++) {
			m.ingest(ev("c2", "assistant", i, "code_generation", { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})

	it("★ 概念问答下 high_recent_ai_dependency 仍出提示，但不得升级为阻断", () => {
		const m = new BehaviorMonitor("c3", { cooldownMs: 0, escalationBlockingThreshold: 1 })
		m.ingest(taskStart("c3", "explanation"))
		for (let i = 1; i <= 8; i++) {
			m.ingest(ev("c3", "assistant", i, "explanation"))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("high_recent_ai_dependency")
		expect(m.shouldEscalateToBlocking("high_recent_ai_dependency")).to.equal(false)
	})

	it("★ 分类未知时保守启用（不得因分类失败静默失效）", () => {
		const m = new BehaviorMonitor("c4", { cooldownMs: 0 })
		for (let i = 1; i <= 5; i++) {
			m.ingest(ev("c4", "assistant", i, "other", { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})

	it("助手事件的 category 不得被当作学生意图", () => {
		const m = new BehaviorMonitor("c5", { cooldownMs: 0, escalationBlockingThreshold: 2 })
		m.ingest(taskStart("c5", "code_generation"))
		// 助手回合报告 explanation —— 不应改变已经确立的学生意图
		for (let i = 1; i <= 5; i++) {
			m.ingest(ev("c5", "assistant", i, "explanation", { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getTaskCategory()).to.equal("code_generation")
	})
})
```

Run:
```powershell
npm run test:unit -- --grep "按学生意图分流" 2>&1 | Select-Object -Last 25
```
Expected: `5 passing`。

- [ ] **Step 7: 全量校验**

```powershell
npx tsc --noEmit 2>&1 | Select-Object -Last 10
npm run test:unit 2>&1 | Select-Object -Last 5
```
Expected: `tsc` 无输出；`806 passing`、`0 failing`。

- [ ] **Step 8: Commit**

```bash
git add src/core/task/student-analytics/rulePolicy.ts src/core/task/student-analytics/BehaviorMonitor.ts src/core/task/student-analytics/__tests__/rulePolicy.test.ts src/core/task/student-analytics/__tests__/behaviorMonitor.taskCategory.test.ts
git commit -m "feat(intervention): gate rules by student intent category"
```

---

## Task 5：方案 C-2 — 概念问答模式不给完整代码

**Files:**
- Create: `src/core/teaching/conceptModeConstraint.ts`
- Modify: `src/core/task/index.ts`（`systemPromptFinal` 组装处，约 L2247–2258）
- Test: Create `src/core/teaching/__tests__/conceptModeConstraint.test.ts`

**Interfaces:**
- Produces: `buildConceptModeConstraint(): string` —— 追加到 system prompt 的约束文本
- Produces: `detectConceptModeViolation(text: string): { violated: boolean; reason?: string; blockLines?: number }`
- Consumes（Task 4）: `BehaviorMonitor.getTaskCategory()` —— 通过 `LLMWikiService` 之外的新路径读取当前学生意图分类

### 需求（来自用户，逐字落实）

> 当在进入概念性问答的环境下，助手不应该给予完整代码，即使学生持续要求。可接受提供部分代码 ——
> 如学生在学习冒泡排序算法时，模型不应给予完整的可运行的冒泡排序算法，而是通过详细解释冒泡排序的
> 设计思路，其中可附带冒泡排序的关键步骤（交换顺序），而不是提供完整的循环代码。

- [ ] **Step 1: 写失败测试**

创建 `src/core/teaching/__tests__/conceptModeConstraint.test.ts`：

```ts
import { expect } from "chai"
import { buildConceptModeConstraint, detectConceptModeViolation } from "../conceptModeConstraint"

describe("buildConceptModeConstraint", () => {
	it("★ 必须明确禁止完整可运行实现，且明确允许关键步骤片段", () => {
		const t = buildConceptModeConstraint()
		expect(t).to.include("完整")
		expect(t).to.include("关键步骤")
		expect(t).to.include("交换")
	})

	it("★ 必须覆盖'即使学生反复要求也不给'这一条", () => {
		expect(buildConceptModeConstraint()).to.match(/反复|持续|仍然/)
	})

	it("必须包含冒泡排序这一具体示例（供弱模型照做）", () => {
		expect(buildConceptModeConstraint()).to.include("冒泡排序")
	})
})

describe("detectConceptModeViolation（仅可见化，不拦截）", () => {
	const completeImplementation = [
		"冒泡排序的完整实现：",
		"```python",
		"def bubble_sort(arr):",
		"    n = len(arr)",
		"    for i in range(n - 1):",
		"        for j in range(n - 1 - i):",
		"            if arr[j] > arr[j + 1]:",
		"                arr[j], arr[j + 1] = arr[j + 1], arr[j]",
		"    return arr",
		"```",
	].join("\n")

	const keyStepOnly = "关键就是相邻比较与交换这一步：`arr[j], arr[j+1] = arr[j+1], arr[j]` —— 循环结构留给你自己写。"

	it("★ 含双重循环的完整实现 → 判为违规", () => {
		const r = detectConceptModeViolation(completeImplementation)
		expect(r.violated).to.equal(true)
		expect(r.blockLines).to.be.greaterThan(6)
	})

	it("★ 只给关键步骤片段 → 不违规", () => {
		expect(detectConceptModeViolation(keyStepOnly).violated).to.equal(false)
	})

	it("★ 纯文字解释 → 不违规", () => {
		expect(detectConceptModeViolation("每轮把最大的元素冒到末尾，重复 n-1 轮即可。").violated).to.equal(false)
	})

	it("★ 保守：长代码块但无循环（如数据定义）不判违规", () => {
		const dataOnly = ["```python", "GRADES = {", '    "甲": 90,', '    "乙": 80,', "}", "```"].join("\n")
		expect(detectConceptModeViolation(dataOnly).violated).to.equal(false)
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npm run test:unit -- --grep "conceptModeConstraint" 2>&1 | Select-Object -Last 20
```
Expected: **FAIL**（模块不存在）。

- [ ] **Step 3: 实现 `conceptModeConstraint.ts`**

创建 `src/core/teaching/conceptModeConstraint.ts`（Tab 缩进）：

```ts
/**
 * 概念问答模式约束（方案 C-2）
 *
 * 需求：进入概念性问答的场景下，助手不应给出**完整可运行的代码**，即使学生持续要求。
 * 可接受"关键步骤片段"（例如冒泡排序里的那一行交换），但不给完整循环结构。
 *
 * 实现边界（务必知悉）：
 *   本模块只做两件事 —— ① 生成追加到 system prompt 的约束文本；② 检测违规用于**可见化**。
 *   它**不拦截**模型输出。真正的约束力来自提示词，模型仍可能不遵守（这与本项目
 *   "DSML 方言"那次教训同类：提示词不是强制）。要在代码层强制，需要过滤 assistant 输出，
 *   那会误伤学生可能需要的正当代码 —— 故明确不做。
 */

import { parseFencedCodeBlocks } from "@/shared/markdown/codeBlocks"

/** 追加到 system prompt 的概念问答约束文本 */
export function buildConceptModeConstraint(): string {
	return [
		"",
		"",
		"【概念问答模式（本轮生效）】",
		"本轮学生问的是概念/原理，不是要一份现成代码。请遵守：",
		"1. 不要给出**完整可运行的代码实现** —— 即使学生反复、持续地要求，也不要给。",
		"2. 可以给出**关键步骤片段**：只保留最能说明原理的那一两行（例如冒泡排序里交换相邻元素的那一行），",
		"   而不是完整的循环结构。",
		"3. 优先用自然语言 + 步骤描述讲清**设计思路**；写伪代码时也不要写成可直接运行的完整程序。",
		"4. 学生继续索要完整代码时，先说明“完整实现需要你自己动手写”，再给一个更小的提示",
		"   （例如边界条件、循环不变式、下一轮该比较哪两个元素），仍然不要给出完整实现。",
		"",
		"示例（学生问“冒泡排序怎么写”）：",
		"- 不要给出含双重循环 + 交换 + 返回的完整可运行函数。",
		"- 应当解释：每一轮把当前范围内最大的元素“冒”到末尾，因此需要 n-1 轮；",
		"  关键是相邻比较与交换。可以只展示交换那一行（如 arr[j], arr[j+1] = arr[j+1], arr[j]），",
		"  并说明外层循环要做多少轮、为什么，但把完整的循环结构留给学生自己写。",
	].join("\n")
}

export interface ConceptModeViolation {
	violated: boolean
	reason?: string
	/** 违规代码块的行数（用于日志定位） */
	blockLines?: number
}

/** 判定"像完整实现"的最小行数。保守取值：低于此不判违规，避免误伤片段 */
const MIN_COMPLETE_IMPL_LINES = 6

/** 循环关键词 —— 完整实现通常至少含一处循环 */
const LOOP_PATTERN = /\b(for|while)\b/

/**
 * 检测回复里是否出现了"完整可运行实现"（仅用于可见化，不用于拦截）。
 *
 * 判定条件（保守，两个都满足才算）：
 *   1. 存在 fenced 代码块，且其中**有效行数 ≥ 6**；
 *   2. 该代码块内含 `for` / `while` 循环。
 *
 * 为什么保守：长代码块也可能是数据结构定义、也可能是学生当前确实在写的代码。
 * 宁可漏报（少记一条日志），也不要误报。
 */
export function detectConceptModeViolation(text: string): ConceptModeViolation {
	// 复用 Task 3a 的公共解析器，不再自持一份围栏正则
	for (const block of parseFencedCodeBlocks(text)) {
		if (block.lineCount >= MIN_COMPLETE_IMPL_LINES && LOOP_PATTERN.test(block.inner)) {
			return {
				violated: true,
				reason: `fenced 代码块含循环且有效行数 ${block.lineCount} ≥ ${MIN_COMPLETE_IMPL_LINES}，疑似完整实现`,
				blockLines: block.lineCount,
			}
		}
	}
	return { violated: false }
}
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npm run test:unit -- --grep "conceptModeConstraint" 2>&1 | Select-Object -Last 20
```
Expected: `7 passing`。

- [ ] **Step 5: 接入 system prompt**

`src/core/task/index.ts`。在 `systemPromptFinal` 追加【教学约束】的那一段（约 L2247–2258）**之后**，新增：

```ts
		// 【方案 C-2】概念问答模式：禁止给出完整可运行代码，只给关键步骤片段。
		// 判定依据取"学生意图分类"（BehaviorMonitor 从用户侧事件捕获），
		// 而不是助手回复的分类 —— 后者是"AI 输出被分成什么"，不能代表学生意图。
		try {
			const monitor = this.getBehaviorMonitor()
			const category = monitor?.getTaskCategory()
			if (category === "explanation" || category === "algorithm") {
				systemPromptFinal = systemPromptFinal + buildConceptModeConstraint()
				Logger.log(`[Task] 概念问答模式约束已注入 (category=${category})`)
			}
		} catch (e) {
			Logger.warn("[Task] 概念问答模式约束注入失败，跳过:", e)
		}
```

并在文件顶部 import 区加入：

```ts
import { buildConceptModeConstraint } from "@/core/teaching/conceptModeConstraint"
```

（放在 `import { buildWikiSystemPrompt } from "@/core/teaching/wikiPrompt"` 相邻位置，保持 case-insensitive 字母序。）

- [ ] **Step 6: 在助手回合结束后做违规可见化**

`src/core/task/index.ts` 的 `persistAssistantTurnLog` 里，在 `const analysis = contentAnalyzer.analyze(assistantText)` 之后插入：

```ts
			// 【方案 C-2】概念问答模式下若给出疑似完整实现，只记录告警（不拦截、不改内容）。
			// 目的是让"提示词没拦住"这件事在日志里可见 —— 与项目其它地方"失败可见"的原则一致。
			try {
				const monitor = this.getBehaviorMonitor()
				const category = monitor?.getTaskCategory()
				if (category === "explanation" || category === "algorithm") {
					const violation = detectConceptModeViolation(assistantText)
					if (violation.violated) {
						Logger.warn(
							`[Task][概念问答违规] 助手给出了疑似完整实现: ${violation.reason} (taskId=${this.taskId}, turn=${turnIndex})`,
						)
					}
				}
			} catch {
				// 可见化失败不影响主流程
			}
```

> ⚠️ `turnIndex` 在该方法里是在后面才声明的常量；**必须把这段插入到 `const turnIndex = persister.getNextTurnIndex(this.taskId)` 这一行之后**，否则会 `TDZ` 报错。

同时给该文件顶部 import 补上 `detectConceptModeViolation`：

```ts
import { buildConceptModeConstraint, detectConceptModeViolation } from "@/core/teaching/conceptModeConstraint"
```

- [ ] **Step 7: 全量校验**

```powershell
npx tsc --noEmit 2>&1 | Select-Object -Last 10
npm run test:unit 2>&1 | Select-Object -Last 5
node esbuild.mjs 2>&1 | Select-Object -Last 4
```
Expected: `tsc` 无输出；`813 passing`、`0 failing`；esbuild 退出码 0。

- [ ] **Step 8: Commit**

```bash
git add src/core/teaching/conceptModeConstraint.ts src/core/teaching/__tests__/conceptModeConstraint.test.ts src/core/task/index.ts
git commit -m "feat(teaching): constrain concept-mode answers to key steps instead of full code"
```

---

## Task 6：方案 C-3 — 持续索要完整代码时意图翻转为 `code_generation`

**Files:**
- Create: `src/core/task/student-analytics/RequestIntentRefiner.ts`
- Modify: `src/core/task/index.ts`（`persistTurnLevelLog` 用 refiner；新增 `hasDeliveredKeyCode` 状态）
- Test: Create `src/core/task/student-analytics/__tests__/requestIntentRefiner.test.ts`

**Interfaces:**
- Produces: `refineStudentCategory(text: string, base: TaskCategory, hasDeliveredKeyCode: boolean): TaskCategory`
- Produces: `Task` 新增私有字段 `hasDeliveredKeyCode: boolean`（Task 3 的 `analysis.hasCodeBlock` 复用为置位条件）

### 需求（来自用户）

> 若学生仍持续要求提供完整代码（在已经提供代码的关键实现部分后仍要求提供代码），
> 则此次要求提供完整代码的提问不再分类至 `explanation`。

即：**一旦"关键实现已给出"且学生仍在索要完整代码，该提问应被视为 `code_generation`** —— 于是 Task 4 的分流会让代码类规则重新生效，干预回来。

- [ ] **Step 1: 写失败测试**

创建 `src/core/task/student-analytics/__tests__/requestIntentRefiner.test.ts`：

```ts
import { expect } from "chai"
import { refineStudentCategory } from "../RequestIntentRefiner"

describe("refineStudentCategory（方案 C-3）", () => {
	it("★ 关键实现已给出 + 学生索要「完整代码」→ 从 explanation 翻转为 code_generation", () => {
		expect(refineStudentCategory("还是不懂，直接把完整的冒泡排序代码给我", "explanation", true)).to.equal(
			"code_generation",
		)
		expect(refineStudentCategory("给我一份能跑的完整实现", "explanation", true)).to.equal("code_generation")
		expect(refineStudentCategory("把全部代码发我", "explanation", true)).to.equal("code_generation")
	})

	it("★ 尚未给出关键实现时不得翻转（避免过早放弃讲解）", () => {
		expect(refineStudentCategory("还是不懂，直接把完整的冒泡排序代码给我", "explanation", false)).to.equal("explanation")
	})

	it("★ 只是在问概念 / 问细节，不得翻转", () => {
		expect(refineStudentCategory("为什么外层循环是 n-1 轮？", "explanation", true)).to.equal("explanation")
		expect(refineStudentCategory("交换那一步是怎么保证顺序的？", "explanation", true)).to.equal("explanation")
	})

	it("★ algorithm 分类同样适用翻转规则", () => {
		expect(refineStudentCategory("直接给我完整可运行的实现", "algorithm", true)).to.equal("code_generation")
	})

	it("★ 本来就是 code_generation 的任务不受影响", () => {
		expect(refineStudentCategory("帮我写一个完整的排序程序", "code_generation", true)).to.equal("code_generation")
	})

	it("★ 跑题/其它分类不被翻转（只处理概念类）", () => {
		expect(refineStudentCategory("给我完整代码", "other", true)).to.equal("other")
		expect(refineStudentCategory("今天天气怎么样", "explanation", true)).to.equal("explanation")
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npm run test:unit -- --grep "refineStudentCategory" 2>&1 | Select-Object -Last 20
```
Expected: **FAIL**（模块不存在）。

- [ ] **Step 3: 实现 `RequestIntentRefiner.ts`**

创建 `src/core/task/student-analytics/RequestIntentRefiner.ts`（Tab 缩进）：

```ts
/**
 * 学生意图细化器（方案 C-3）
 *
 * 需求：若学生在**已经拿到关键实现部分之后**仍然索要完整代码，则该提问不再算"概念问答"，
 * 而是货真价实的 `code_generation` —— 于是规则分流（方案 C-1）会让代码类干预重新生效。
 *
 * 这是"概念模式不给完整代码"（方案 C-2）的**配套反馈回路**：
 * 只靠提示词约束模型是不够的（提示词不是强制），但如果学生持续索取，
 * 我们至少要承认"这已经是一次代码生成请求"，不能再用 explanation 的宽松策略对待。
 */

import type { TaskCategory } from "./types"

/** 会被翻转的"概念类"起点 */
const CONCEPTUAL_BASES: ReadonlySet<TaskCategory> = new Set<TaskCategory>(["explanation", "algorithm"])

/**
 * "索要完整实现"的显式标记。
 * 刻意只收"完整性要求"，不收普通的"怎么写" —— 后者是正常的概念提问。
 */
const COMPLETENESS_MARKERS: readonly RegExp[] = [
	/完整(的)?(代码|实现|程序|版本|算法|函数)/,
	/(全部|整套|整个)(的)?(代码|实现|程序|逻辑)/,
	/(可运行|能跑|能运行|可以直接跑|跑得起来)(的)?/,
	/(直接|干脆)(给我|发我|贴)(一份|个|代码|实现)/,
	/(把|将)(代码|实现)(都|全)?(给|发|贴)(我|过来)/,
	/不要(解释|废话|讲原理)/,
]

/**
 * 细化学生的提问分类。
 *
 * @param text 学生原始提问
 * @param base `TaskClassifier.classify()` 的原始结果
 * @param hasDeliveredKeyCode 本轮之前，助手是否已经给过关键实现（fenced 代码块）
 *
 * 翻转条件（三者同时满足）：
 *   1. 原始分类属于概念类（explanation / algorithm）；
 *   2. 已经给过关键实现 —— 否则学生会"还没看到东西就被当成要代码"；
 *   3. 提问里出现显式的"完整性要求"标记。
 */
export function refineStudentCategory(text: string, base: TaskCategory, hasDeliveredKeyCode: boolean): TaskCategory {
	if (!CONCEPTUAL_BASES.has(base) || !hasDeliveredKeyCode) {
		return base
	}
	const normalized = (text ?? "").trim()
	if (!normalized) {
		return base
	}
	const wantsComplete = COMPLETENESS_MARKERS.some((re) => re.test(normalized))
	return wantsComplete ? "code_generation" : base
}
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npm run test:unit -- --grep "refineStudentCategory" 2>&1 | Select-Object -Last 20
```
Expected: `6 passing`。

- [ ] **Step 5: 在 `Task` 中接入状态与调用**

`src/core/task/index.ts`：

1. 顶部 import：
```ts
import { refineStudentCategory } from "@/core/task/student-analytics/RequestIntentRefiner"
```
（`@core/task/...` 与 `@/core/task/...` 都可；与本文件既有风格保持一致。）

2. 新增私有字段（与 `behaviorMonitor` 声明相邻，约 L209 附近）：
```ts
	/** 【方案 C-3】本任务内助手是否已经给过关键实现（fenced 代码块） */
	private hasDeliveredKeyCode = false
```

3. `persistTurnLevelLog` 里把分类改为经 refiner：
```ts
			// 【方案 C-3】概念问答里"拿到关键实现后仍索要完整代码"的提问，按 code_generation 对待。
			const rawCategory = taskClassifier.classify(text)
			const category = refineStudentCategory(text ?? "", rawCategory, this.hasDeliveredKeyCode)
			if (category !== rawCategory) {
				Logger.info(`[StudentTurnLog] 意图翻转: ${rawCategory} → ${category} (已给出关键实现)`)
			}
```
（保留原有 `const analysis = contentAnalyzer.analyze(text)` 一行不动。）

4. `persistAssistantTurnLog` 里，在 `const analysis = contentAnalyzer.analyze(assistantText)` 之后置位：
```ts
			// 【方案 C-3】记录"关键实现已给出"，供后续学生提问的意图翻转判定使用
			if (analysis.hasCodeBlock) {
				this.hasDeliveredKeyCode = true
			}
```

- [ ] **Step 6: 写并跑端到端反馈回路测试**

创建 `src/core/task/student-analytics/__tests__/interventionRegression.test.ts` —— 这份文件的**完整内容在第 7 Task 给出**，本步骤先写其中"场景 5"：

```ts
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { refineStudentCategory } from "../RequestIntentRefiner"
import { getRulePolicy } from "../rulePolicy"
import type { StudentInteractionLog, TaskCategory } from "../types"

const ev = (
	taskId: string,
	role: "user" | "assistant",
	idx: number,
	category: TaskCategory,
	extra: Partial<StudentInteractionLog> = {},
): StudentInteractionLog => ({
	ts: new Date().toISOString(),
	taskId,
	eventType: "turn_message",
	role,
	category,
	contentLength: 10,
	hasCode: false,
	languageHint: "python",
	imageCount: 0,
	fileCount: 0,
	turnIndex: idx,
	...extra,
})

describe("场景 5 — 概念问答的反馈回路（方案 C-2 + C-3）", () => {
	it("★ 拿到关键实现后持续索要完整代码 → 分类翻转 → 代码类规则重新生效", () => {
		// ① 起始：概念提问
		const base: TaskCategory = "explanation"
		let hasDeliveredKeyCode = false

		// ② 助手给出关键实现（fenced 代码块）
		hasDeliveredKeyCode = true

		// ③ 学生索要完整代码 → 翻转
		const flipped = refineStudentCategory("直接把完整的冒泡排序代码给我", base, hasDeliveredKeyCode)
		expect(flipped).to.equal("code_generation")

		// ④ 翻转后，代码类规则重新可用
		expect(getRulePolicy("consecutive_code_generation", flipped).enabled).to.equal(true)
		expect(getRulePolicy("consecutive_code_generation", base).enabled).to.equal(false)

		// ⑤ 并且真的会被 monitor 触发
		const m = new BehaviorMonitor("loop1", { cooldownMs: 0 })
		m.ingest({ ...ev("loop1", "user", 0, flipped), eventType: "task_start" })
		for (let i = 1; i <= 3; i++) {
			m.ingest(ev("loop1", "assistant", i, flipped, { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})

	it("★ 未给出关键实现时不翻转（不得过早放弃讲解）", () => {
		const c = refineStudentCategory("直接把完整的冒泡排序代码给我", "explanation", false)
		expect(c).to.equal("explanation")
		expect(getRulePolicy("consecutive_code_generation", c).enabled).to.equal(false)
	})
})
```

Run:
```powershell
npm run test:unit -- --grep "场景 5" 2>&1 | Select-Object -Last 20
```
Expected: `2 passing`。

- [ ] **Step 7: 全量校验**

```powershell
npx tsc --noEmit 2>&1 | Select-Object -Last 10
npm run test:unit 2>&1 | Select-Object -Last 5
node esbuild.mjs 2>&1 | Select-Object -Last 4
```
Expected: `tsc` 无输出；`821 passing`、`0 failing`；esbuild 退出码 0。

- [ ] **Step 8: Commit**

```bash
git add src/core/task/student-analytics/RequestIntentRefiner.ts src/core/task/student-analytics/__tests__/requestIntentRefiner.test.ts src/core/task/student-analytics/__tests__/interventionRegression.test.ts src/core/task/index.ts
git commit -m "feat(intervention): reclassify repeated demands for complete code as code generation"
```

---

## Task 7：回归验收 — 确保干预机制仍然发挥作用

**Files:**
- Modify: `src/core/task/student-analytics/__tests__/interventionRegression.test.ts`（补齐场景 1–4）

**Interfaces:**
- Consumes: `BehaviorMonitor`、`TeachingInterventionManager`、`generateBlockingInterventionMessage`、`refineStudentCategory`、`getRulePolicy`
- Produces: 一个可作为**发版门槛**的回归套件

> **这是用户明确要求的验收标准**："以不影响原有功能为标准，需确保教学干预机制仍能发挥作用"。
> 因此本套件必须同时包含**反向用例**（该干预时必须干预），不能只有"不误触发"的用例。

- [ ] **Step 1: 补齐场景 1–4**

在 `interventionRegression.test.ts` 顶部补 import：

```ts
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import { generateBlockingInterventionMessage } from "../InterventionMessageGenerator"
```

并在文件末尾追加：

```ts
describe("场景 1 — 概念问答不得误触发（原始 bug 的回归）", () => {
	it("★ 概念问答：即使助手连续给出真代码块，也不触发代码类规则", () => {
		const m = new BehaviorMonitor("s1", { cooldownMs: 0 })
		m.ingest({ ...ev("s1", "user", 0, "explanation"), eventType: "task_start" })

		// ★ 前提断言：确认分流真的生效了，而不是 monitor 什么都没做。
		// 否则下面两条 not.include 会“真空通过” —— 这正是 wiki 检索验证脚本踩过的坑。
		expect(m.getTaskCategory()).to.equal("explanation")

		// 刻意用 hasCodeBlock: true（真正的代码块），把 Task 3 的作用排除掉，
		// 让这个用例只验证 Task 4 的“分类分流”是否生效。
		for (let i = 1; i <= 5; i++) {
			m.ingest(ev("s1", "assistant", i, "explanation", { hasCode: true, hasCodeBlock: true }))
		}
		const rules = m.getPendingAlerts().map((a) => a.ruleId)
		expect(rules).to.not.include("consecutive_code_generation")
		expect(rules).to.not.include("no_edit_streak")

		// ★ 反向对照：同一事件形状，仅分类不同 → 必须触发。
		// 无此对照，上面的 not.include 无法区分“分流生效”与“monitor 坏了”。
		const ctrl = new BehaviorMonitor("s1c", { cooldownMs: 0 })
		ctrl.ingest({ ...ev("s1c", "user", 0, "code_generation"), eventType: "task_start" })
		for (let i = 1; i <= 5; i++) {
			ctrl.ingest(ev("s1c", "assistant", i, "code_generation", { hasCode: true, hasCodeBlock: true }))
		}
		expect(ctrl.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})
})

describe("场景 2 — 真实依赖必须仍然干预", () => {
	it("★ 学生连续索要完整代码（起始即 code_generation）→ 触发 consecutive_code_generation", () => {
		const m = new BehaviorMonitor("s2", { cooldownMs: 0 })
		m.ingest({ ...ev("s2", "user", 0, "code_generation"), eventType: "task_start" })
		for (let i = 1; i <= 3; i++) {
			m.ingest(ev("s2", "assistant", i, "code_generation", { hasCode: true, hasCodeBlock: true }))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})

	it("★ 连续无编辑（真在写代码的任务）→ 触发 no_edit_streak", () => {
		const m = new BehaviorMonitor("s3", { cooldownMs: 0 })
		m.ingest({ ...ev("s3", "user", 0, "debugging"), eventType: "task_start" })
		for (let i = 1; i <= 8; i++) {
			m.ingest(ev("s3", "assistant", i, "debugging"))
		}
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("no_edit_streak")
	})
})

describe("场景 3 — 阻断仍可升级，且时长与文案一致", () => {
	it("★ 代码类任务下累计 6 次触发 → 阻断，冷却为 60s", () => {
		const m = new BehaviorMonitor("s4", { cooldownMs: 0, escalationBlockingThreshold: 6 })
		// 显式抬高单任务限额、并放宽循环轮数：让这个用例只验证“阻断能否升级”，
		// 不因限额/轮数这类无关参数而假失败（此路径上默认 10 其实够用，此处为防御性余量）。
		const mgr = new TeachingInterventionManager("s4", {
			globalCooldownMs: 0,
			blockingCooldownMs: 60_000,
			maxInterventionsPerTask: 30,
		})

		m.ingest({ ...ev("s4", "user", 0, "code_generation"), eventType: "task_start" })

		let blockingText: string | null = null
		let turn = 1
		for (let round = 0; round < 20 && blockingText === null; round++) {
			m.ingest(ev("s4", "assistant", turn++, "code_generation", { hasCode: true, hasCodeBlock: true }))
			const text = mgr.checkAndGenerateIntervention(m, turn)
			if (text && text.includes("interventionType=\"blocking\"")) {
				blockingText = text
			}
		}

		expect(blockingText, "阻断未能在合理轮次内触发").to.not.equal(null)
		expect(blockingText).to.include("冷却倒计时: 1 分钟")
		expect(blockingText).to.not.include("3 分钟")
		expect(mgr.isBlockingActive()).to.equal(true)
		// 剩余时间应在 60s 以内（允许执行耗时）
		expect(mgr.getBlockingEndsAt() - Date.now()).to.be.at.most(60_000)
		expect(mgr.getBlockingEndsAt() - Date.now()).to.be.greaterThan(55_000)
	})
})

describe("场景 4 — 阻断消息的结构与反射问题不得丢失", () => {
	it("★ generateBlockingInterventionMessage 仍带反思问题与禁用功能声明", () => {
		const msg = generateBlockingInterventionMessage(
			{
				ruleId: "no_edit_streak",
				message: "x",
				triggeredAt: new Date().toISOString(),
				metricValue: 8,
				threshold: 8,
				escalationCount: 6,
			},
			60_000,
		)
		expect(msg.interventionType).to.equal("blocking")
		expect(msg.severity).to.equal("strong")
		expect(msg.reflectionQuestions?.length ?? 0).to.be.greaterThan(0)
		expect(msg.disabledFeatures ?? []).to.include("code_generation")
	})
})
```

- [ ] **Step 2: 跑回归套件**

```powershell
npm run test:unit -- --grep "场景" 2>&1 | Select-Object -Last 30
```
Expected: **全部 passing**（场景 1–5，共 7 条）。
若场景 3 未能在 12 轮内触发阻断，先确认 Task 1 的 `escalationBlockingThreshold` 已生效（测试里显式传了 6，应不受默认值影响）。

- [ ] **Step 3: 全量校验 + 构建**

```powershell
npx tsc --noEmit 2>&1 | Select-Object -Last 10
Push-Location webview-ui; npx tsc --noEmit 2>&1 | Select-Object -Last 6; Pop-Location
npm run test:unit 2>&1 | Select-Object -Last 5
node esbuild.mjs 2>&1 | Select-Object -Last 4
```
Expected: 两侧 `tsc` 无输出；`826 passing`、`111 pending`、`0 failing`；esbuild 退出码 0。

- [ ] **Step 4: Lint**

```powershell
npx biome lint --reporter=github src/core/task/student-analytics src/core/teaching src/core/task/index.ts 2>&1 | Select-String -Pattern "title=" | ForEach-Object { $_.Line }
```
Expected: **新增文件中 0 条**。`src/core/task/index.ts` 与 `BehaviorMonitor.ts` 的既有告警数不得增加（基线：`BehaviourMonitor`/`index.ts` 目前各为 0；`src/core/teaching/LLMWikiService.ts` 有 7 条既有 `useBlockStatements`，本次不应触及）。

- [ ] **Step 5: Commit**

```bash
git add src/core/task/student-analytics/__tests__/interventionRegression.test.ts
git commit -m "test(intervention): regression suite covering false positives and real dependency"
```

---

## 3. 人工验收（开发宿主，全部自动化通过后执行）

**前置**：`node esbuild.mjs` → 按 F5 启动扩展开发宿主；后端 `npx tsx src/server.ts` 在 4001 监听。

| # | 操作 | 期望 | 失败特征 |
|---|---|---|---|
| M1 | 提问「第一周学了什么」 | **全程无任何干预提示**；`ragChars` 保持百位量级 | 出现 💡/🤔/🎯 任一提示 |
| M2 | week=1 提问「什么是装饰器」（资料在第 5 周） | 无干预；仍正确告知周次；**不展开高级语法** | 无干预但直接讲装饰器实现 |
| M3 | 连续 3 次「帮我写一个完整的 XXX 程序」 | **仍触发** gentle → moderate 干预 | 完全不干预（说明修过头了） |
| M4 | 上一步之后继续索要 | 累计到 6 次后触发**阻断**；横幅倒计时**从 1:00 开始** | 横幅显示 3:00，或注入文本写"3 分钟" |
| M5 | 概念问答里问「冒泡排序怎么写」 | 只给设计思路 + **交换那一行**；**不给**含双重循环的完整函数 | 直接给出完整可运行实现 |
| M6 | M5 之后继续说「直接把完整代码给我」 | 分类翻转为 `code_generation`（日志出现 `意图翻转` 行）；再继续索要会触发干预 | 一直不干预 |
| M7 | 阻断期间发消息 | 被拦截并显示剩余时间；**60 秒后自动恢复**，MCP 检索恢复可用 | 恢复不了，或时长仍为 180s |

> M2 与 M3 是**方向相反**的一对，必须都通过 —— 只过 M2 说明干预被修没了。

---

## 4. 明确不做（本计划范围外）

- **感知层重构**（`teaching-intervention-fix-options.md` §5）：不改"以 agent 行为为中心"的现状，不改 `task_start` 计数口径，不动 `high_recent_ai_dependency` 的分子分母定义。
- **方案 B、F**：工具回合豁免、干预文案与最终答案隔离 —— 保留不动。
- **方案 G**（DSML 方言归一化）：保留不动。
- **不实现 `disabledFeatures` 的代码级强制**：保留"提示词级"现状，文案已在 Task 2 收敛为可核查的表述。
- **不拦截模型输出**：Task 5 只做提示词约束 + 违规可见化，不做输出过滤（会误伤学生正当需要的代码）。
