# 实验会话绑定与「提交实验 / 结束实验」实施计划

> 状态：已实施（2026-10-25；代码与自动化闸门通过，M-80~M-86 待人工验收）
> 日期：2026-10-25
> 关联：`docs/design/teaching-modes-and-behavior-metrics-design.md`（P1 双会话模式）、`docs/manual-test-plan.md` §8
> 本次只拟方案，不写实现代码。

---

## Goal

让「开始实验」真正进入并**保持**实验会话，同时补齐两个明确的退出入口：

1. 修复手动测试暴露的四个事实错误：
   - 点击「开始实验」后聊天任务仍被判为自由模式（实验模式从未被激活）；
   - 行为日志零写入（根日志停更、实验目录只有 0 字节空文件）；
   - 运行痕迹永远写根工作区（`<root>/.cline-logs/run_traces.jsonl`），子工作区永远没有；
   - 提交包也只读根工作区的日志/运行痕迹/代码，不读实验子目录。
2. 进入实验模式后，UI 出现**「提交实验」**与**「结束实验」**两个按钮：
   - 「提交实验」复用现有「🚀 一键提交实验结果至云端」的完整两段式链路（收集材料 → 出思考题 → 确认后上传）；
   - 「结束实验」直接退出实验模式；
   - 开始实验后，**只有**「提交成功」或「结束实验」才算退出；返回对话、关闭面板、重启 VS Code、新建聊天任务都不退出。

验收口径：实验模式判定正确 → 行为日志 / 运行痕迹 / 提交内容都落在 `experiments/<assignmentId>/` → 两个按钮可用且只在两种出口退出 → 自由模式行为保持原样（不记日志、不干预）。

## Architecture

### 会话状态的唯一来源

新增一个**工作区级**的会话文件（而不是 Task 内存或 workspaceState）：

```
<workspaceRoot>/.cline-logs/active-experiment.json
{
  "assignmentId": "task_week2_yufayu-variable-type",
  "assignmentTitle": "…",
  "language": "python",
  "template": "main.py",
  "startedAt": "2026-10-25T04:23:04.924Z",
  "status": "active"
}
```

选择理由：

- `.cline-logs/` 已在 `.gitignore`（第 50 行），不污染学生仓库；
- 聊天任务的 `cwd` 恒为工作区根（`controller/index.ts:278` → `Task.cwd`），根级文件是唯一能跨任务/跨重启看到的绑定；
- 纯 fs 读写，`resolveSessionContext` 可注入 reader 单测，不需要 vscode 依赖。

### 模式判定链（修改后）

`resolveSessionContext({ cwd, workspaceRoot?, mode?, experimentId?, taskReader?, sessionReader? })`：

1. 显式 `mode`
2. 显式 `experimentId`
3. `cwd` 路径含 `experiments/<id>/`
4. `cwd/.teaching/task.json` 的 `assignmentId`
5. **`<workspaceRoot>/.cline-logs/active-experiment.json` 的 `assignmentId`（本次新增）**
6. 都没有 → `free`

`experiment` 时 `logRoot = <workspaceRoot>/experiments/<id>`（原来错写成 `cwd`）；`free` 时 `logRoot = cwd` 仅用于定位、不写入。

### 写入侧 / 读取侧 / 提交侧统一用 logRoot

| 位置 | 现状 | 修改后 |
|---|---|---|
| `StudentLogPersister` | `new StudentLogPersister(this.cwd)` | 注入 `ctx.logRoot`，`getLogDir()` 用它 |
| `Task.buildTeachingContext` | 实验分支 `experimentDir = this.cwd` | `experimentDir = ctx.logRoot` |
| `RunTraceCollector.append` | 恒写 `pickWorkspaceRoot(...)` 的根 | 根目录有 active session 时改写到 `experiments/<id>/.cline-logs/run_traces.jsonl` |
| `AssignmentManager.handlePrepareSubmission` | 日志/runTraces/代码都取 `workspaceRoot` | 实验会话存在时改取 `experiments/<id>`（日志、runTraces、代码文件三处） |

### 退出语义（唯一出口）

- `submitExperiment` → 现有 `prepareSubmission` 两段式 → `confirmSubmission` 上传成功 → 清除会话文件 + 广播会话变更；
- `endExperiment` → 直接清除会话文件 + 广播（保留实验目录和已有日志，不做删除）；
- 其它动作（返回对话、关闭详情面板、切换视图、重启、新建任务）**都不清除**会话文件。

### UI 落点

- **聊天侧栏**：`ChatView` 顶部新增 `ExperimentSessionBar`（有活动实验时显示「🧪 实验中：<任务名>」+「提交实验」「结束实验」）。挂载时向扩展查询会话状态，并监听广播更新。
- **任务详情面板**（编辑器区，`AssignmentDetailForm`）：实验进行中显示「提交实验」「结束实验」；已开始但未在会话中显示「继续实验」；未开始显示「开始实验」。
- 两个入口都通过现有 `assignment_command` IPC 走 `AssignmentManager`，不新增第二套上传/退出逻辑。

## Tech Stack

- VS Code Extension（TypeScript，Cline 宿主，Node 20+）
- Webview：React 18 + TypeScript（`webview-ui`，esbuild/vite 打包）
- 测试：mocha + chai + ts-node（`tsconfig.unit-test.json`）
- 纯 fs 会话文件，无后端改动；教学端（`D:\web-dashboard`）零改动

## Spec

### S1 会话文件模块（`src/core/teaching/ExperimentSession.ts`，新建）

```ts
export const ACTIVE_EXPERIMENT_FILE = path.join(".cline-logs", "active-experiment.json")

export interface ExperimentSession {
  assignmentId: string
  assignmentTitle?: string
  language?: string
  template?: string
  startedAt: string
  status: "active"
}

export function activeExperimentPath(workspaceRoot: string): string
export function readActiveExperiment(workspaceRoot: string | null | undefined): ExperimentSession | null
export function startExperimentSession(input: {
  workspaceRoot: string
  assignmentId: string
  assignmentTitle?: string
  language?: string
  template?: string
  now?: Date
}): ExperimentSession
export function endExperimentSession(workspaceRoot: string): boolean   // 删除文件；不存在返回 false
export function experimentLogRoot(workspaceRoot: string, assignmentId: string): string  // experiments/<id>
```

约束：

- 读失败/JSON 损坏/字段类型不对 → 返回 `null`（**不抛**），等价没有活动会话；
- 写用 `mkdir -p` + 临时文件 + `rename` 原子替换；
- `assignmentId` 先 `sanitizeSegment`（复用 `ExperimentWorkspace.sanitizeSegment`），不允许 `..`/分隔符；
- 不依赖 `vscode`，可在 Node 单测。

### S2 模式判定扩展（`TeachingSessionMode.ts`）

```ts
export interface ResolveSessionInput {
  cwd: string
  workspaceRoot?: string
  experimentId?: string | null
  mode?: SessionMode | null
  taskReader?: (cwd: string) => ExperimentTaskFile | null
  sessionReader?: (workspaceRoot: string) => ExperimentSession | null   // 新增
}
```

- 判定链如 Architecture 所述；`workspaceRoot` 缺省取 `cwd`（聊天任务 cwd 即根）；
- `experiment` 时 `logRoot = experimentLogRoot(workspaceRoot, id)`（新增路径，保持 `SessionContext.logRoot` 字段语义终于生效）；
- 显式 `mode === "experiment"` 时也遵守同样的 logRoot 计算。

### S3 日志落盘根（`StudentLogPersister.ts`）

```ts
constructor(cwd: string, logRoot?: string)
public setLogRoot(logRoot: string): void
public getLogRoot(): string
```

- `getLogDir() = path.join(this.logRoot ?? this.cwd, ".cline-logs")`；
- 首次构造时由 `Task` 传入当前 `ctx.logRoot`，会话中途变化时调用 `setLogRoot`。

### S4 Task 每轮刷新（`src/core/task/index.ts`）

- `getTeachingSessionContext()` 不再永久缓存：改为按「cwd + 会话文件 mtime/内容签名」比对，变化时重建；
- 新增 `private refreshTeachingSession(): void`：
  - 重新 `resolveSessionContext({ cwd, workspaceRoot: this.cwd })`；
  - 若 `mode/experimentId/logRoot` 变化：更新 `this.teachingBaseContext`、`persister.setEnabled(logPersistEnabled(ctx))`、`persister.setContext(...)`、`persister.setLogRoot(ctx.logRoot)`；实验→自由时把 demand 计数清零并落盘；
- 调用点：`getStudentLogPersister()` 每次取用时、`attemptApiRequest` 开头；
- `buildTeachingContext` 实验分支改 `const experimentDir = ctx.logRoot`。

### S5 运行痕迹路由（`RunTraceCollector.ts`）

- 抽出纯函数便于单测：

```ts
export function resolveRunTraceRoot(
  workspaceRoot: string,
  sessionReader?: (root: string) => ExperimentSession | null,
): string   // 活动会话 → experiments/<id>；否则 workspaceRoot
```

- `handleEnd` 中 `const root = pickWorkspaceRoot(...)` 后改为 `const target = resolveRunTraceRoot(root)`，`append(target, record)`；
- 写入目标目录 `.cline-logs/` 不存在时创建（`append` 已有 mkdir -p）；
- 采集器启动/切换会话无需重启，每次写入时读取会话文件。

### S6 提交读侧切换（`AssignmentManager.ts`）

`handlePrepareSubmission` 增加：

```ts
const session = readActiveExperiment(workspaceRoot)
const submissionRoot = session && (!assignmentId || session.assignmentId === assignmentId)
  ? experimentLogRoot(workspaceRoot, session.assignmentId)
  : workspaceRoot
```

- 日志：`resolveStudentLogFile(submissionRoot)` → `collectLog` → `sliceLogForUpload`；
- 运行痕迹：`readRunTraces(submissionRoot)`；
- 代码文件：`collectCodeFiles({ workspaceRoot: submissionRoot, activeFilePath, ... })`；
- `PendingSubmission` 增加 `submissionRoot`（仅用于诊断/日志，不修改提交包字段）；
- 出题信号仍从上述同源数据计算（会自然拿到实验目录的 runTraces）。

### S7 新 IPC 命令与退出逻辑（`AssignmentManager.ts`）

`AssignmentMessage.command` 联合新增三个命令：

| 命令 | 行为 |
|---|---|
| `getExperimentSession` | 返回 `{active, assignmentId, assignmentTitle, language, template, startedAt, logRoot}` |
| `submitExperiment` | 若存在活动会话 → 以会话的 `assignmentId` 调用现有 `handlePrepareSubmission`（含出题面板）；否则返回错误「当前没有进行中的实验」 |
| `endExperiment` | 若存在活动会话 → `endExperimentSession(workspaceRoot)` 清除 + 信息提示 + 广播；否则返回错误 |

`startExperiment` 增强（`startExperiment()` 内、`ensureExperimentWorkspace` 成功后）：

- 若已有其它任务的 active session → 拒绝并提示「请先提交或结束当前实验」；
- 写入会话文件（`startExperimentSession`），用 `assignment.title/language/template`；
- 广播会话变更。

`confirmSubmission` 成功分支：

- 上传成功后（`postBundle` ok 且 `body.ok === true`）：
  - 若 `pending.assignment.id` 与当前 active session 的 `assignmentId` 一致 → `endExperimentSession(pending.workspaceRoot)` + 广播；
  - 成功提示追加一行「已退出实验模式（可在任务面板重新开始）」或单独 `showInformationMessage`。

`AssignmentResponse` 不变，广播复用其形状：`{ command: "getExperimentSession", success: true, data: { active: … } }`，由 `postMessageToWebview` 推给侧栏。

宿主注入：

```ts
public attachSessionBroadcaster(cb: ((data: ExperimentSessionView) => void) | null): void
```

`VscodeWebviewProvider` 在 `assignmentManager` IIFE 中：

```ts
m.attachSessionBroadcaster((data) =>
  this.postMessageToWebview({ command: "getExperimentSession", success: true, data } as unknown as ExtensionMessage),
)
```

（注意：`assignmentManager` IIFE 在 `postMessageToWebview` 定义之前执行，用箭头函数保留 `this`，运行时才调用，安全。）

### S8 详情面板载荷与处理器

`assignmentDetail.ts`：

- `AssignmentDetailPayload` 增加 `sessionActive: boolean`；
- `buildAssignmentDetailPayload` 入参增加 `sessionActive?: boolean`；
- `AssignmentManager.handleOpenAssignmentDetail` 构建载荷时传 `readActiveExperiment(workspaceRoot)?.assignmentId === assignmentId`。

`AssignmentDetailPanelProvider.ts`：

- `AssignmentDetailHandlers` 增加：
  ```ts
  submitExperiment: () => Promise<{ ok: boolean; message?: string }>
  endExperiment: () => Promise<{ ok: boolean; message?: string }>
  ```
- `_handleMessage` 新增 `submitExperiment` / `endExperiment` 两个 case：调用 handler → post 结果 → 成功后 `update({...payload, sessionActive:false, started:true})`（提交/结束都保留 started=true，按钮回到「继续实验」）。

### S9 Webview UI

1. 新建 `webview-ui/src/components/teaching/ExperimentSessionBar.tsx`：
   - props：`session: ExperimentSessionView | null` + `onSubmit/onEnd`;
   - 挂载时 `postMessage({ type: "assignment_command", command: "getExperimentSession" })`；
   - `window.addEventListener("message")` 监听 `command === "getExperimentSession"` 更新状态；
   - 提交中置灰防连点；结束前用 `window.confirm("结束实验后会回到自由问答模式（实验文件保留），确定结束？")`（需求要求直接退出，但避免误触；确认框属于交互细节，评审可改）。
2. `ChatView.tsx`：在 `<ChatLayout>` 内、`Navbar` 与 `TaskSection` 之间渲染 `<ExperimentSessionBar />`（无活动会话时返回 null）。
3. `AssignmentDetailForm.tsx`：
   - `PanelResponse` 增加 `submitExperiment` / `endExperiment` 两命令处理与状态提示；
   - 按钮区：`sessionActive` → 「提交实验」「结束实验」；`started && !sessionActive` → 「继续实验」；`!started` → 「开始实验」；
   - `submitExperiment` 点击后提示「正在收集实验材料并出题…」，后续由答题面板接管。
4. 文案修正：`AssignmentDetailForm.tsx:339` 的「并把日志根切到该目录」本次实现后为真，保留；`ExperimentWorkspace` 顶部注释同步。

### S10 文档与验收

- `docs/manual-test-plan.md` 新增 §9「实验会话与退出入口」（M-80~M-86）：
  - M-80 开始实验 → 会话文件存在、侧栏横幅出现；
  - M-81 返回对话/重启 VS Code → 仍是实验模式（日志继续写实验目录）；
  - M-82 实验目录内提问与编辑代码 → `experiments/<id>/.cline-logs/student_interactions.log` 增长、`mode=experiment`、`experimentId` 正确；
  - M-83 终端运行 `python main.py` → `experiments/<id>/.cline-logs/run_traces.jsonl` 出现、根目录不再新增；
  - M-84 提交实验（完整两段式）→ 提交成功且实验模式退出、横幅消失；
  - M-85 结束实验 → 直接退出、文件保留、模式变自由（对话不再记日志）；
  - M-86 边界：会话文件损坏判自由、另一任务开始实验被拒、旧实验目录「继续实验」重新建会话。
- 本计划文档落 `docs/design/experiment-session-and-actions-plan.md`；
- `CHANGELOG.md` 顶部 `## [Unreleased]` 增加 Fixed/Added 条目（会话绑定、日志/痕迹/提交目录、两个按钮、仅两出口退出）。

## Global Constraints

- 只改 `D:\cline`；`D:\web-dashboard` 零改动（提交包格式不变：`relPath` 仍相对提交根）。
- 不改提交包契约/字段；教学端 v3 迁移、指标公式、E2E 断言都不受影响。
- 自由模式行为保持不变：不写行为日志、不干预、阶梯 3 次；不得因本次修改让 free 模式开始写日志。
- 不新增第三方依赖；不修改 `package.json` 依赖。
- 会话文件损坏、目录缺失、无工作区等异常都必须降级为自由模式，**不阻断**聊天与提交。
- cline 仓库 pre-commit 有既有 biome 违规（HEAD 即存在），提交用 `git commit --no-verify`，并在 message 里注明「仅跳过格式化检查，tsc/mocha 已单独跑过」。
- 任何一步实现前先写测试并确认失败（TDD）；每完成一个 Task 跑对应定向测试与 `npx tsc --noEmit`。

## Review Focus

1. **模式判定链是否可能有歧义**：显式 mode/experimentId、路径、task.json、根会话文件的优先级；同一工作区两个任务目录同时存在时行为是否确定。
2. **退出语义是否真的只剩两个出口**：返回对话/关闭面板/重启/新建任务都不得清会话（重点检查 `startExperiment`、`handleExitToChat`、`clearTask`、面板 dispose 路径）。
3. **写入/读取/提交根是否统一**：`logRoot` 是否在 persister、runTrace、prepareSubmission 三处一致；是否还有地方写死 `<root>/.cline-logs`。
4. **Task 会话中途切换**：一个已存在的聊天任务里点「开始实验」后再对话，是否在同任务内生效（缓存刷新与 persister 重配）。
5. **提交成功才退出**：上传失败、取消答题、面板关闭都不能清会话；确认判断用的是 `response.ok && body.ok`。
6. **不做破坏性清理**：结束实验不删文件、不清日志；重新开始同一任务行为幂等（追加日志）。
7. **测试是否真的能捕获回归**：`resolveRunTraceRoot`、`experimentLogRoot`、`readActiveExperiment`、`resolveSessionContext` 的新分支、`StudentLogPersister.logRoot` 均有单测；失败路径（损坏 JSON、无工作区、跨任务会话不匹配）都覆盖。

---

## Task 1：会话文件模块

### Files

- 新建 `src/core/teaching/ExperimentSession.ts`
- 新建 `src/core/teaching/__tests__/experimentSession.test.ts`
- 复用 `src/core/teaching/ExperimentWorkspace.ts` 的 `sanitizeSegment`、`EXPERIMENT_ROOT`

### Interfaces

```ts
export const ACTIVE_EXPERIMENT_FILE: string
export interface ExperimentSession { /* S1 */ }
export function activeExperimentPath(workspaceRoot: string): string
export function readActiveExperiment(workspaceRoot: string | null | undefined): ExperimentSession | null
export function startExperimentSession(input: StartExperimentSessionInput): ExperimentSession
export function endExperimentSession(workspaceRoot: string): boolean
export function experimentLogRoot(workspaceRoot: string, assignmentId: string): string
```

### Steps

- [ ] 写测试：读取不存在 → null；正常读写 round-trip；损坏 JSON → null；字段类型错 → null；`assignmentId` 含 `/`、`..`、空串 → 兜底或 null（按 sanitize 规则测试）；`startExperimentSession` 重复调用幂等覆盖；`endExperimentSession` 删除后返回 true、再调用 false；`experimentLogRoot` 返回 `<root>/experiments/<sanitized>`；父目录不存在时自动创建。
- [ ] 运行 `npx mocha --grep "experimentSession"`，确认全部失败（尚无实现）。
- [ ] 实现 `ExperimentSession.ts`（原子写、损坏降级、无 vscode 依赖）。
- [ ] 再跑定向测试到全绿；`npx tsc --noEmit` 0 错误。
- [ ] 提交（`git commit --no-verify -m "feat(teaching): persist the active experiment session in the workspace"`）。

## Task 2：模式判定接入会话文件

### Files

- 修改 `src/core/teaching/TeachingSessionMode.ts`
- 修改/新增测试 `src/core/teaching/__tests__/sessionMode.test.ts`

### Interfaces

```ts
export interface ResolveSessionInput { /* 加 workspaceRoot?: string; sessionReader?: ... */ }
export function resolveSessionContext(input: ResolveSessionInput): SessionContext
// SessionContext.logRoot 语义：experiment → experiments/<id>；free → cwd
```

### Steps

- [ ] 写测试（追加到 `sessionMode.test.ts`）：
  - 根目录有 active session + cwd=根 → experiment，id 正确，logRoot=`<root>/experiments/<id>`；
  - 显式 `mode:"free"` 压过 active session；
  - cwd 在 `experiments/other/` 内且根会话是另一个任务 → 以路径为准；
  - active session 损坏/缺失 → free；
  - `sessionReader` 注入 mock 时优先级正确；
  - task.json 与 active session 同时存在且 id 不同 → task.json 优先（cwd 语义）。
- [ ] 跑 `npx mocha --grep "sessionMode"` 看新用例失败。
- [ ] 实现判定链与 logRoot 计算（import `readActiveExperiment`/`experimentLogRoot`，保持纯函数可注入）。
- [ ] 定向测试全绿 + tsc 0。
- [ ] 提交（`feat(teaching): resolve experiment mode from the workspace session file`）。

## Task 3：写侧统一 logRoot（persister + Task + RunTraceCollector）

### Files

- 修改 `src/core/task/student-analytics/StudentLogPersister.ts`（+ `src/core/task/student-analytics/__tests__/` 或 `src/core/teaching/__tests__/` 下新增透传/根测试）
- 修改 `src/core/task/index.ts`
- 修改 `src/core/teaching/submission/RunTraceCollector.ts`
- 修改 `src/core/teaching/__tests__/runTraceCollector.test.ts`

### Interfaces

```ts
// StudentLogPersister
constructor(cwd: string, logRoot?: string)
setLogRoot(logRoot: string): void
getLogRoot(): string

// RunTraceCollector
export function resolveRunTraceRoot(workspaceRoot: string, sessionReader?: (root: string) => ExperimentSession | null): string
```

### Steps

- [ ] 写测试：persister 指定 `logRoot` 后 `getLogDir()`/`getLogPath()` 指向该根；未指定回退 cwd；`resolveRunTraceRoot` 有活动会话 → 实验目录、无 → 根、reader 抛错 → 根（降级）。
- [ ] 跑定向测试确认失败。
- [ ] 实现 persister logRoot 注入与 `getLogDir` 改造；实现 `Task.refreshTeachingSession()`（含 demand 计数在模式切换时清零）并在 `getStudentLogPersister()`、`attemptApiRequest` 调用；`buildTeachingContext` 改用 `ctx.logRoot`；RunTraceCollector `handleEnd` 改用 `resolveRunTraceRoot`。
- [ ] 定向测试全绿 + 全仓 `npx tsc --noEmit` 0。
- [ ] 提交（`feat(teaching): write behavior logs and run traces into the experiment workspace`）。

## Task 4：提交读侧切换 + IPC 命令 + 退出逻辑

### Files

- 修改 `src/core/teaching/AssignmentManager.ts`
- 修改 `src/core/teaching/submission/SubmissionPackager.ts`（如需辅助函数）
- 新建 `src/core/teaching/__tests__/submissionRoots.test.ts`（纯函数测试）
- 修改 `src/hosts/vscode/VscodeWebviewProvider.ts`（广播注入）
- 修改 `src/core/teaching/assignmentDetail.ts`（payload 增加 `sessionActive`）与 `__tests__/assignmentDetail.test.ts`

### Interfaces

```ts
// 新增纯函数（放在 AssignmentManager 同层或 submission/）
export function resolveSubmissionRoot(workspaceRoot: string, session: ExperimentSession | null, assignmentId: string): string

// AssignmentManager
public attachSessionBroadcaster(cb: ((view: ExperimentSessionView) => void) | null): void
public async endExperiment(): Promise<{ ok: boolean; message?: string }>
// handleMessage 新增：getExperimentSession / submitExperiment / endExperiment
```

### Steps

- [ ] 写测试（纯函数）：`resolveSubmissionRoot` 无会话 → 根；会话同 assignment → 实验目录；会话不同 assignment → 根。
- [ ] 写测试（assignmentDetail）：`buildAssignmentDetailPayload` 输出 `sessionActive` 默认 false/显式 true。
- [ ] 跑定向测试确认失败。
- [ ] 实现 `resolveSubmissionRoot` 并在 `handlePrepareSubmission` 替换日志/runTraces/代码三处根；实现三个 IPC 命令与 `endExperiment`；`startExperiment` 写会话并拒绝跨任务；`confirmSubmission` 成功清会话 + 广播；注入 broadcaster。
- [ ] 更新 `PendingSubmission` 携带 `submissionRoot`（诊断用）。
- [ ] 定向测试全绿 + tsc 0。
- [ ] 提交（`feat(teaching): submit experiment bundles from the experiment workspace and end the session explicitly`）。

## Task 5：详情面板与侧栏 UI

### Files

- 修改 `src/hosts/vscode/AssignmentDetailPanelProvider.ts`
- 修改 `webview-ui/src/components/teaching/AssignmentDetailForm.tsx`
- 新建 `webview-ui/src/components/teaching/ExperimentSessionBar.tsx`
- 修改 `webview-ui/src/components/chat/ChatView.tsx`
- （可选）`webview-ui/src/components/teaching/AssignmentTab.tsx` 顶部复用同一条横幅

### Interfaces

```ts
// AssignmentDetailHandlers
submitExperiment: () => Promise<{ ok: boolean; message?: string }>
endExperiment: () => Promise<{ ok: boolean; message?: string }>

// ExperimentSessionBar props
interface Props { onSubmit: () => void; onEnd: () => void }
```

### Steps

- [ ] 先实现 provider 两个 case（无 UI 测试，可用类型/构建验证）。
- [ ] 实现 `ExperimentSessionBar`（查询 + 监听 + 防连点 + 结束确认）。
- [ ] ChatView 插入；DetailForm 按钮区按 `sessionActive/started` 分支；处理两个新响应命令。
- [ ] `cd webview-ui && npx tsc --noEmit` 0；`npm run build` 通过。
- [ ] 提交（`feat(teaching): add submit and end experiment actions to the session UI`）。

## Task 6：文档、手动验收与最终闸门

### Files

- 修改 `docs/manual-test-plan.md`（新增 §9 M-80~M-86）
- 修改 `CHANGELOG.md`（`## [Unreleased]`）
- 本计划文档状态改为「已实施」

### Steps

- [ ] 写手册 §9 与 CHANGELOG（Fixed：模式未激活/日志与运行痕迹写错目录/提交读错目录；Added：两按钮、会话文件、仅两出口退出）。
- [ ] 全量闸门：`npx tsc --noEmit`（cline + webview-ui）0；`$env:TS_NODE_PROJECT='./tsconfig.unit-test.json'; npx mocha` 全绿；`node esbuild.mjs`；`cd webview-ui && npm run build`；`node scripts/verify/mcp-wiki-server.mjs`、`node scripts/verify/wiki-recall.mjs`。
- [ ] 手工执行 M-80~M-86（真 VS Code + 测试工作区），记录到 `docs/manual-test-plan-results.md`。
- [ ] 提交（`docs(changelog): 记录实验会话绑定与提交/结束入口`）。
- [ ] 最终 `git log --oneline -6` 复核 + 报告（提交清单、闸门数字、手工结果、已知限制）。

---

## 评审结论（2026-10-25 已确认）

1. **「结束实验」弹一次确认框**：确认后直接退出实验模式，实验目录与日志保留。
2. **旧「🚀 一键提交实验结果至云端」按钮保留，且上传成功后同样结束会话**：它与新「提交实验」走同一条 `prepareSubmission → confirmSubmission` 链路，语义一致；实现上统一在 `confirmSubmission` 成功分支清会话，不区分来源。
3. **多任务并存：拒绝**。同一工作区已有 A 实验进行中时点 B 的「开始实验」→ 报错提示「请先提交或结束当前实验」，不自动结束 A。
4. **自由模式运行痕迹**：保持现状（自由模式仍可能写根目录 `run_traces.jsonl`），本次只修实验模式的目录路由。
5. **实验目录内直接打开聊天**：`detectExperimentId(cwd)` 仍会判实验模式，但聊天任务 cwd 实际是根，此路径仅影响未来「在实验目录里新开窗口」的用法，本次不改。
