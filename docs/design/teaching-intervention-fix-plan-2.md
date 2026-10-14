# 教学干预修订（F1–F13）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `docs/design/teaching-intervention-acceptance-and-revisions.md` §9 的 F1–F13 按 P0→P3 落地，使「第 3 次索要完整代码即进入阻断」这一验收口径真正成立，并让干预文案由模型受契约产出、降级路径永不失手。

**Architecture:** 三层不变式 —— **决策留在代码**（`BehaviorMonitor` 决定 `ruleId`/`severity`，`TeachingInterventionManager` 决定冷却/限额/升级/阻断），**措辞交给模型**（F13 写作任务书 + 回执块），**失败必降级**（回执缺失或确定性校验不过 → 现有 `TEMPLATE_REGISTRY` 文案）。周数边界（F4/F7）与联网（F8）只放行"可见面"，不改"知识生产方式"。

**Tech Stack:** TypeScript + VS Code Extension API + mocha 10.8.2 / ts-node / chai（`npm run test:unit`）、Biome 2.4.15、esbuild、pnpm。

## Global Constraints

- **测试基线（不可回归）**：`npm run test:unit` 入口 **827 passing / 111 pending / 0 failing**。每个 Task 完成后必须复测并保持 `0 failing`。
- **类型门槛**：`npx tsc --noEmit`（扩展侧）与 `pnpm --dir webview-ui exec tsc --noEmit` 均须 **0 error**。
- **缩进**：本仓库用 **Tab**（`biome.jsonc` 的 `indentStyle: "tab"`、`indentWidth: 4`）；新增/修改代码不得引入 4 空格缩进。
- **日志**：禁止新增 `console.*`，统一用 `Logger`（`@/shared/services/Logger`）；扩展代码禁止直接调 `vscode.window.*`，走 `HostProvider`（`src/dev/grit/*.grit` 会拦截）。
- **阈值权威值（只改 `BehaviorMonitor.DEFAULT_OPTIONS`，另一个副本仅同步注释）**：`escalationBlockingThreshold` **3**、`cooldownMs` **120_000**、`noEditTurnStreakThreshold` 8、`aiDependencyThreshold` 0.85、`consecutiveAssistantCodeThreshold` 3、`blockingCooldownMs` **60_000**。
- **F13 硬约束（数值照抄 spec §9.5）**：文案总长 **≤ 120 字**（不含 emoji）；**不得含 fenced 代码块**；必须含"留白"；不得改力度档；不得提及"系统/检测/自动"。
- **向后兼容**：`StudentInteractionLog` 新增字段一律**可选**，缺失时按旧语义处理。
- **禁止**：`npx biome format --write` 作用于 Tab 文件；提交 `docs/design/**` 前需用户明确指示。

## 0. 测试纪律（三层，缺一不可）

| 层 | 时机 | 范围 | 通过标准 |
|---|---|---|---|
| **L1 单元** | **每个 Step 内** | 本 Task 新增/修改的纯逻辑 | 新测试先红后绿；该文件全绿 |
| **L2 优先级综合** | **一个 P 全部 Task 完成后**（G0/G1/G2/G3） | 该 P 全部改动 + 其上下游链路 + 边界 | `npm run test:unit` 全绿 **且** `tsc --noEmit` 0 错 **且** 专项断言全绿 |
| **L3 全量综合** | **P0–P3 全部完成后**（G-ALL） | 全仓库 | 同 L2，外加"核心流程可跑通"的端到端断言 |

**L2/L3 必须同时覆盖四类检查**（每类的正例 + 反例）：① **正常路径**；② **边界条件**（空值/缺字段/超长/并发/时序）；③ **回归**（既有 827 条不变红）；④ **核心流程可跑通**（断言 `BehaviorMonitor → TeachingInterventionManager → index.ts 注入/阻断` 与 `wikiPrompt → 资料索引` 两条链路端到端可用）。

**文档中给出的行号为写作时的锚点（用于定位），执行时必须按符号名定位，不得盲信行号。**

---

## 1. 文件结构

### 新建

| 文件 | 职责 | Task |
|---|---|---|
| `src/core/task/student-analytics/ConceptModeGate.ts` | **纯函数**：`nextConceptMode(prev, signal)` —— 概念模式的任务级粘性判定（F3） | T3 |
| `src/shared/markdown/interventionCopy.ts` | **纯函数**：`extractInterventionCopy(text)`（解析回执块）+ `stripInterventionCopyBlock(text)`（剥离）；`index.ts` 与 `AttemptCompletionHandler.ts` 共用（F13） | T13 |
| `src/core/task/student-analytics/InterventionCopyContract.ts` | **纯函数**：`buildCopyTaskSheet(...)`（写作任务书）+ `validateCopy(copy, ctx)`（三条确定性校验 + 一条启发性校验）（F13） | T13 |
| `src/core/assistant-message/dialectNormalize.ts` | **纯函数**：`normalizeAssistantDialect(raw)` —— 把模型的 DSML 方言归一化为 Cline 规范 XML（F12，**P4**） | T12 |
| `src/core/assistant-message/__tests__/dialectNormalize.test.ts` | F12：方言归一化（含恒等变换 / 半畸形 / 不得凭空造出工具调用） | T12 |
| `src/core/task/student-analytics/__tests__/escalationReachability.test.ts` | F1：升级阈值可达性（含边界） | T1 |
| `src/core/task/student-analytics/__tests__/codeEditAttribution.test.ts` | F2：AI/人 编辑归属（含缺字段兼容） | T2 |
| `src/core/task/student-analytics/__tests__/ConceptModeGate.test.ts` | F3：粘性判定正反例 | T3 |
| `src/core/task/student-analytics/__tests__/priorityGate.p0.test.ts` | **G0 综合**：P0 全链路 + 边界 | G0 |
| `src/core/task/student-analytics/__tests__/interventionCopyContract.test.ts` | F13：任务书 + 校验（含超长/含代码块/无留白） | T13 |
| `src/shared/markdown/__tests__/interventionCopy.test.ts` | F13：回执解析（命中/缺失/畸形/多块/超长） | T13 |

> 其余 P1–P3 的测试文件：沿用既有文件追加（F4 扩 `src/core/teaching/__tests__/wikiPrompt.test.ts`；F5 扩 `rulePolicy.test.ts` + 新建 `categoryStickiness.test.ts`；F6 扩 `interventionMessages.test.ts`；F9 扩 `behaviorMonitor.taskCategory.test.ts`；F11 新建 `categoryKeywordBoundary.test.ts`），以及 `priorityGate.p1/p2/p3.test.ts`、`fullRegression.gate.test.ts`。

### 修改

| 文件 | 涉及 Task |
|---|---|
| `src/core/task/student-analytics/BehaviorMonitor.ts` | T1（计数脱钩）、T2（归属）、T5（粘性）、T9（指标） |
| `src/core/task/student-analytics/TeachingInterventionManager.ts` | T1（阻断不依赖 `pendingAlerts`） |
| `src/core/task/student-analytics/CodeEditTracker.ts` | T2（`editor` 归属）、T11（`role` 修正） |
| `src/core/context/context-tracking/FileContextTracker.ts` | T2（新增只读查询，**不得改动既有 `recentlyEditedByCline` 语义**） |
| `src/core/task/student-analytics/types.ts` | T2（`editor`）、T13（`interventionCopy` 事件类型） |
| `src/core/task/student-analytics/InterventionMessageGenerator.ts` | T6（不进历史）、T13（任务书化） |
| `src/core/task/student-analytics/TaskClassifier.ts` | T5、T11（词边界） |
| `src/core/task/student-analytics/AdoptionTracker.ts` | T11 |
| `src/core/task/student-analytics/rulePolicy.ts` | T9 |
| `src/core/task/index.ts` | T3（粘性）、T6、T7（周数通知）、T10、T13（两处挂点） |
| `src/core/task/tools/handlers/AttemptCompletionHandler.ts` | T13（回执剥离第二挂点） |
| `src/core/teaching/wikiPrompt.ts` | T4（三档策略） |
| `src/core/teaching/LLMWikiService.ts` | T4（`buildIndexGroups` 全周） |
| `src/core/teaching/mcp-wiki-server.ts` | T4（工具描述）、T7（热读周数） |
| `src/core/teaching/mcp/args.ts` | T7（`--week` 降级为回退） |

---

## 2. 执行顺序与门槛

```
P0：T2(F2) → T1(F1) → T9-b(F1回归) → T3(F3)  → G0  综合
P1：T4(F4) → T5(F5) → T6(F6)         → G1  综合
P2：T7(F7) → T8(F8) → T9(F9)         → G2  综合
P3：T10(F10) → T11(F11) → T13(F13)   → G3  综合
                                         ↓
                                  G-ALL 全量综合（P0–P3）
                                         ↓
                                  ★ git 存档（checkpoint）
                                         ↓
P4：T12(F12 方言归一化)               → G4  综合
                                         ↓
                                  最终复测（G-ALL'）
                                         ↓
                                 人工验收 M1–M14'
```
- **P0 内部顺序为 F2 → F1 → F3**：F2 让 AI 落盘不再清零 streak，F1 才谈得上"计数可达"；F3 让护栏不被索要撤销。顺序颠倒会导致 T1 的测试无法构造出"3 次索要即阻断"。
- **T9-b 前提到 P0 收尾（T1 之后、T3 之前）**：它是 **F1 自身引入的回归**（`notify()` 移出计数后 `high_adoption_low_self_modification` 计数恒为 0），属于 T1 的完整交付范围；放在 P0 可让 **G0 直接覆盖该回归**。
  - 若留在 P2 才修，则 P0/P1 的综合性门禁会在"已知能力回退"状态下通过，意义打折。
- **P4（F12）必须最后做**：它改的是**感知层**（`parseAssistantMessageV2` 的输入），一旦出错会连带影响**所有**工具调用，因此：
  1. 只有在 **G-ALL（P0–P3）全绿**之后才能开工；
  2. 开工前必须先做 **git 存档**：`git commit -am "chore: checkpoint before P4 dialect normalization"` + `git tag -a pre-f12-checkpoint -m "G-ALL (P0-P3) 全绿基线"`；
  3. 存档是**回退点**，不是发布点 —— 若 P4 失败或引入回归，`git reset --hard pre-f12-checkpoint` 即可完整回到 P0–P3 的可用状态。
- **门槛**：进入下一个优先级的**唯一**条件是上一个 G 全绿（L2）。任一 G 红 → 修复后重跑该 G，不得跳过。
- **F13 依赖 P0**：F13 的 M11' 要求"触发一次真实干预"，而干预可达性由 F1/F2/F3 提供。
- **每个 Task 结束都要 commit**（commit message 见各 Task 末尾）。

---

## 3. P0 任务

### Task 2（F2）：`code_edit` 区分编辑者 —— **本次最关键的一项**

**Files:**
- Modify: `src/core/context/context-tracking/FileContextTracker.ts`（新增只读查询）
- Modify: `src/core/task/student-analytics/CodeEditTracker.ts`（新增纯函数 `resolveEditEditor`，`setContext` 增设第 5 参）
- Modify: `src/core/task/student-analytics/types.ts`（`StudentInteractionLog.editor?: "user" | "ai"`）
- Modify: `src/core/task/student-analytics/BehaviorMonitor.ts`（`updateRealtimeStreaks` 的 `code_edit` 分支，约 115–148）
- Modify: `src/core/task/index.ts:1348`（`setContext` 传 `this.fileContextTracker`）
- Test: `src/core/task/student-analytics/__tests__/codeEditAttribution.test.ts`

**Interfaces:**
- Consumes: `asRelativePath`（`@/utils/path`，`flushEdit` 已在用）；`FileContextTracker.markFileAsEditedByCline`（已被 `WriteToFileToolHandler.ts:295`、`ApplyPatchHandler.ts:334` 调用）
- Produces: `FileContextTracker.wasRecentlyWrittenByCline(filePath, windowMs?): boolean`；`CodeEditTracker.resolveEditEditor(relPath, tracker?): "user" | "ai"`；`StudentInteractionLog.editor?`

**⚠️ 关键约束**：`recentlyEditedByCline` 是**一次性标志**（被 `setupFileWatcher` 的 `change` 分支消费后删除）。**不得复用它** —— 否则 Cline 自己的写盘会被判成"用户外部修改"，并向模型发出假警告。必须新增独立的 `Map`。

- [ ] **Step 1: 写失败测试**

```ts
// src/core/task/student-analytics/__tests__/codeEditAttribution.test.ts
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { resolveEditEditor } from "../CodeEditTracker"
import type { StudentInteractionLog } from "../types"

const ev = (over: Partial<StudentInteractionLog>): StudentInteractionLog => ({
	ts: new Date().toISOString(), taskId: "t1", eventType: "code_edit", role: "user",
	category: "other", contentLength: 0, hasCode: true, languageHint: "python",
	imageCount: 0, fileCount: 0, turnIndex: -1, ...over,
})
const asstCode = () => ev({ eventType: "turn_message", role: "assistant", hasCodeBlock: true })

describe("F2 · code_edit 编辑者归属", () => {
	it("tracker 缺失 → 人工（向后兼容）", () => {
		expect(resolveEditEditor("a.py", undefined)).to.equal("user")
	})
	it("tracker 判定为 AI 写盘 → 'ai'", () => {
		expect(resolveEditEditor("a.py", { wasRecentlyWrittenByCline: () => true })).to.equal("ai")
	})
	it("tracker 抛错 → 回退人工，不向上抛", () => {
		expect(resolveEditEditor("a.py", { wasRecentlyWrittenByCline: () => { throw new Error("x") } })).to.equal("user")
	})
	it("★ AI 落盘不再清零 streak（旧行为会清零）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(asstCode()); m.ingest(asstCode())
		m.ingest(ev({ editor: "ai" }))              // ← AI 写盘
		m.ingest(asstCode())                        // 第 3 个含代码块回合
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.include("consecutive_code_generation")
	})
	it("人工编辑仍然清零", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(asstCode()); m.ingest(asstCode())
		m.ingest(ev({ editor: "user" }))
		m.ingest(asstCode())
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("consecutive_code_generation")
	})
	it("缺省 editor（旧日志/旧事件）按人工处理", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m.ingest(asstCode()); m.ingest(asstCode())
		m.ingest(ev({}))                            // 无 editor
		m.ingest(asstCode())
		expect(m.getPendingAlerts().map((a) => a.ruleId)).to.not.include("consecutive_code_generation")
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:unit -- --grep "F2 · code_edit 编辑者归属"`
Expected: FAIL —— `resolveEditEditor` 不是函数；且第 4 条断言失败

- [ ] **Step 3: 实现（4 处改动）**

```ts
// ① FileContextTracker.ts —— 与 recentlyEditedByCline 并存的新状态
private readonly writeAttributionWindowMs = 10_000
private recentlyWrittenByClineAt = new Map<string, number>()

markFileAsEditedByCline(filePath: string): void {
	this.recentlyEditedByCline.add(filePath)
	this.recentlyWrittenByClineAt.set(filePath, Date.now())          // ← 新增
	const cutoff = Date.now() - this.writeAttributionWindowMs        // 防止长任务里无界增长
	for (const [p, t] of this.recentlyWrittenByClineAt) {
		if (t < cutoff) this.recentlyWrittenByClineAt.delete(p)
	}
}

/** 【F2】windowMs 内是否由 Cline 写过。**只读、不清除** —— 见 Task 2 顶部的关键约束。 */
public wasRecentlyWrittenByCline(filePath: string, windowMs: number = this.writeAttributionWindowMs): boolean {
	const at = this.recentlyWrittenByClineAt.get(filePath)
	return at !== undefined && Date.now() - at <= windowMs
}
```

```ts
// ② CodeEditTracker.ts —— 纯函数，便于单测（不依赖 vscode 实例）
export interface FileContextTrackerLike {
	wasRecentlyWrittenByCline(filePath: string, windowMs?: number): boolean
}

export function resolveEditEditor(relPath: string, tracker: FileContextTrackerLike | undefined): "user" | "ai" {
	if (!tracker) return "user"
	try {
		return tracker.wasRecentlyWrittenByCline(relPath) ? "ai" : "user"
	} catch {
		return "user" // 归属判定失败不得影响日志主流程
	}
}
```

```ts
// ③ BehaviorMonitor.ts —— updateRealtimeStreaks 的 code_edit 分支
if (event.eventType === "code_edit") {
	// 【F2】只有"人"的编辑才算学生动手：AI 的 write_to_file / apply_patch 也会产生 code_edit，
	// 旧逻辑在此清零 streak，使 consecutive_code_generation 永远到不了 3（见 spec §7.4）。
	// 缺省 editor（旧日志）按人工处理，保持向后兼容。
	if (event.editor !== "ai") {
		this.turnsSinceLastEdit = 0
		this.assistantCodeStreak = 0
	}
	// AI 落盘：既不清零也不额外计数（该回合已由 assistant turn_message 的 hasCodeBlock 计入）
	return
}
```

```ts
// ④ types.ts + 两处接线
// types.ts：StudentInteractionLog 增加（可选，避免破坏既有构造点）
editor?: "user" | "ai"

// CodeEditTracker.flushEdit 组装 log 时（file_save 分支同理，供 F11 用）
editor: resolveEditEditor(relativePath, this.fileContextTracker),

// index.ts:1348 —— setContext 增第 5 参
Task.codeEditTracker.setContext(
	this.taskId, this.getStudentLogPersister(), this.adoptionTracker,
	this.getBehaviorMonitor(), this.fileContextTracker,
)
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npm run test:unit -- --grep "F2 · code_edit 编辑者归属"` → Expected: **6 passing**
Run: `npm run test:unit` → Expected: **≥833 passing / 111 pending / 0 failing**
Run: `npx tsc --noEmit` → Expected: **0 error**

- [ ] **Step 5: 非回归边界 —— 既有 watcher 语义未被破坏**

同文件追加一条：连续调用 `wasRecentlyWrittenByCline(p)` 两次，两次都为 `true`（证明它**不消费**状态）。
`FileContextTracker.test.ts` 追加一条：`markFileAsEditedByCline(p)` 之后 `recentlyEditedByCline` 仍含 `p`。

- [ ] **Step 6: 提交**

```bash
git add src/core/context/context-tracking/FileContextTracker.ts src/core/task/student-analytics/CodeEditTracker.ts \
  src/core/task/student-analytics/types.ts src/core/task/student-analytics/BehaviorMonitor.ts src/core/task/index.ts \
  src/core/task/student-analytics/__tests__/codeEditAttribution.test.ts src/core/context/context-tracking/FileContextTracker.test.ts
git commit -m "fix(analytics): attribute code_edit to AI vs student so AI writes stop resetting the streak"
```

---

### Task 1（F1）：升级计数与提醒冷却脱钩 + 阈值 6→3

**Files:**
- Modify: `src/core/task/student-analytics/BehaviorMonitor.ts`（`DEFAULT_OPTIONS.escalationBlockingThreshold` 约 50；`evaluateRules` 约 150；`checkConsecutiveCodeGenerationRule` 约 172；`checkNoEditStreakRule` 约 185；`notify` 约 279；新增 `bumpEscalation` / `getRuleIdsAtBlockingThreshold`）
- Modify: `src/core/task/student-analytics/TeachingInterventionManager.ts`（`checkAndGenerateIntervention` 约 91–200）
- Modify: `src/core/task/student-analytics/__tests__/interventionParams.test.ts`（阈值断言 6 → 3）
- Test: `src/core/task/student-analytics/__tests__/escalationReachability.test.ts`

**Interfaces:**
- Consumes: `getRulePolicy(ruleId, category)`（`rulePolicy.ts`，门控优先于计数）
- Produces: `BehaviorMonitor.getRuleIdsAtBlockingThreshold(): BehaviorRuleId[]`；`BehaviorMonitor.bumpEscalation(ruleId)`（私有）

**违规单位定义（必须与测试一致）**：一条违规 = **一个 `turn_message` 事件命中规则条件**。
`adoption_infer` / `file_save` / `code_edit` / `task_start` **不计**（否则单轮会因伴随事件被重复计数）。

- [ ] **Step 1: 写失败测试**

```ts
// src/core/task/student-analytics/__tests__/escalationReachability.test.ts
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import type { StudentInteractionLog } from "../types"

const ev = (over: Partial<StudentInteractionLog>): StudentInteractionLog => ({
	ts: new Date().toISOString(), taskId: "t1", eventType: "turn_message", role: "assistant",
	category: "code_generation", contentLength: 0, hasCode: true, hasCodeBlock: true,
	languageHint: "python", imageCount: 0, fileCount: 0, turnIndex: -1, ...over,
})

describe("F1 · 升级阈值可达性", () => {
	it("★ 阈值恰为 3：第 2 次不升级，第 3 次升级（边界）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({})); m.ingest(ev({}))
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(2)
		expect(m.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
		m.ingest(ev({}))
		expect(m.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(true)
	})

	it("★ 计数与提醒冷却解耦：冷却期内仍逐轮计数", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 120_000, escalationBlockingThreshold: 3 })
		m.ingest(ev({})); m.ingest(ev({})); m.ingest(ev({}))
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(3)
		expect(m.getPendingAlerts().length).to.equal(1) // 提醒仍受 120s 冷却限制
	})

	it("非 turn_message 事件不计数", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({})); m.ingest(ev({}))
		m.ingest(ev({ eventType: "adoption_infer" }))
		m.ingest(ev({ eventType: "file_save" }))
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(2)
	})

	it("★ 阻断不依赖 pendingAlerts（队列被清空后仍能阻断）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({})); m.ingest(ev({})); m.ingest(ev({}))
		m.consumePendingAlerts() // 模拟"本轮无新警报"
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		const text = mgr.checkAndGenerateIntervention(m, 1)
		expect(text).to.be.a("string").and.to.include("阻断模式")
		expect(mgr.isBlockingActive()).to.equal(true)
	})

	it("概念问答下仍不可升级（rulePolicy 门控优先于计数）", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({ eventType: "task_start", role: "user", category: "algorithm" }))
		m.ingest(ev({})); m.ingest(ev({})); m.ingest(ev({}))
		expect(m.getEscalationCount("consecutive_code_generation")).to.equal(0) // 规则被停用 → 不计数
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:unit -- --grep "F1 · 升级阈值可达性"`
Expected: FAIL —— 第 1/2/4 条断言失败（当前计数发生在 `notify()` 内，被 120s 冷却节流）；`getRuleIdsAtBlockingThreshold` 不存在

- [ ] **Step 3: 实现 —— 计数与通知分离**

```ts
// ① BehaviorMonitor.DEFAULT_OPTIONS（约 50）
escalationBlockingThreshold: 3,   // 【F1】6 → 3：对齐「第 3 次违规即阻断」

// ② ingest() 把事件传下去；evaluateRules 用 isTurn 界定"违规单位"
this.evaluateRules(event)

private evaluateRules(event: StudentInteractionLog): void {
	const isTurn = event.eventType === "turn_message"   // 【F1】一个 turn_message = 一次违规机会
	// …policy 门控不变…
	if (policy("consecutive_code_generation")) this.checkConsecutiveCodeGenerationRule(isTurn)
	if (policy("no_edit_streak")) this.checkNoEditStreakRule(isTurn)
	// 其余两条规则不变
}

private bumpEscalation(ruleId: BehaviorRuleId): number {
	const n = (this.escalationCounter[ruleId] ?? 0) + 1
	this.escalationCounter[ruleId] = n
	return n
}

private checkConsecutiveCodeGenerationRule(isTurn: boolean): void {
	if (this.assistantCodeStreak < this.options.consecutiveAssistantCodeThreshold) return
	if (isTurn) this.bumpEscalation("consecutive_code_generation")   // ★ 不受冷却影响
	// 下面这次调用与改动前**逐字相同**（message 保持现有文案），只在其前插入一行计数
	this.notify(
		"consecutive_code_generation",
		`检测到你连续 ${this.assistantCodeStreak} 次请求代码生成，建议先尝试自行修改一小段，再让 AI 帮你 review。`,
		this.assistantCodeStreak,
		this.options.consecutiveAssistantCodeThreshold,
	)
}

private checkNoEditStreakRule(isTurn: boolean): void {
	if (this.turnsSinceLastEdit < this.options.noEditTurnStreakThreshold) return
	if (isTurn) this.bumpEscalation("no_edit_streak")
	// 同上：message 逐字保留
	this.notify(
		"no_edit_streak",
		`你已经连续 ${this.turnsSinceLastEdit} 轮没有代码编辑，建议动手验证或微调一处关键实现。`,
		this.turnsSinceLastEdit,
		this.options.noEditTurnStreakThreshold,
	)
}

// ③ notify()：删除自增，改为读取当前计数（冷却**只挡提示**，不再挡计数）
private notify(ruleId: BehaviorRuleId, message: string, metricValue = 0, threshold = 0): void {
	const now = Date.now()
	if (now - (this.lastReminderAt[ruleId] ?? 0) < this.options.cooldownMs) return
	this.lastReminderAt[ruleId] = now
	const escalationCount = this.getEscalationCount(ruleId)   // ← 原为 `?? 0) + 1`
	// …以下构造 alert 的代码不变…
}

// ④ 暴露「已达阻断阈值」的规则（供管理器使用）
public getRuleIdsAtBlockingThreshold(): BehaviorRuleId[] {
	return (Object.keys(this.escalationCounter) as BehaviorRuleId[])
		.filter((r) => this.shouldEscalateToBlocking(r))
}
```

```ts
// ⑤ TeachingInterventionManager —— 把原阻断分支抽成 triggerBlocking()（DRY），并新增独立入口
// 在"检查是否有待处理的警报"**之前**插入：
const blockingRule = monitor.getRuleIdsAtBlockingThreshold()[0]
if (blockingRule) {
	const count = monitor.getEscalationCount(blockingRule)
	return this.triggerBlocking(monitor, {
		ruleId: blockingRule, message: "", triggeredAt: new Date().toISOString(),
		metricValue: count, threshold: monitor.getEscalationBlockingThreshold(), escalationCount: count,
	}, turnIndex)
}
// 原 `alerts.find((a) => monitor.shouldEscalateToBlocking(a.ruleId))` 分支改为调用同一个 triggerBlocking()。
// triggerBlocking() 的代码体 = 现有阻断分支原样搬移：
//   generateBlockingInterventionMessage → monitor.markBlockingTriggered() → blockingActive/blockingEndsAt
//   → 写两个全局静态 → lastBlockingIntervention → formatInterventionForInjection → Logger.info → recordIntervention
```

```ts
// ⑥ 同步两处配置副本 + 既有断言
// TeachingInterventionManager.DEFAULT_OPTIONS.escalationBlockingThreshold: 6 → 3
// __tests__/interventionParams.test.ts: `to.equal(6)` → `to.equal(3)`（两处）
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npm run test:unit -- --grep "F1 · 升级阈值可达性"` → Expected: **5 passing**
Run: `npm run test:unit` → Expected: **≥838 passing / 111 pending / 0 failing**
Run: `npx tsc --noEmit` → Expected: **0 error**

- [ ] **Step 5: 边界补充（必须）**

在测试文件追加两条：
① `escalationBlockingThreshold: 1` 时首个 `turn_message` 即升级（下界）；
② `reset()` 之后计数归零、`shouldEscalateToBlocking() === false`（复用 `BehaviorMonitor.reset()`，约 379）。

- [ ] **Step 6: 提交**

```bash
git add src/core/task/student-analytics/BehaviorMonitor.ts src/core/task/student-analytics/TeachingInterventionManager.ts \
  src/core/task/student-analytics/__tests__/escalationReachability.test.ts \
  src/core/task/student-analytics/__tests__/interventionParams.test.ts
git commit -m "fix(intervention): decouple escalation counting from the reminder cooldown and lower the threshold to 3"
```

---

### Task 3（F3）：概念护栏不得因"索要"而撤销

**Files:**
- Create: `src/core/task/student-analytics/ConceptModeGate.ts`
- Create: `src/core/task/student-analytics/__tests__/ConceptModeGate.test.ts`
- Modify: `src/core/task/student-analytics/BehaviorMonitor.ts`（持有 `conceptModeState`，在 `ingest` 内推进；新增 `getConceptModeState()`）
- Modify: `src/core/task/index.ts`（**两处**：① 注入点 —— 注入条件由单轮 `isConceptModeCategory(category)` 改为粘性 `monitor.getConceptModeState().active`；② **违规可见化点** —— 必须与注入点**同口径**，否则粘性化后可见化会在目标场景静默失效，见本 Task 的「落地记录」）
- Modify: `src/core/teaching/conceptModeConstraint.ts`（补"例外通道"文本）

**Interfaces:**
- Consumes: `StudentInteractionLog.category`（**已是 `refineStudentCategory` 之后的分类**，见 `index.ts:1054`）、`StudentInteractionLog.editor`（Task 2 产出）
- Produces: `nextConceptMode(prev, signals): ConceptModeState`；`BehaviorMonitor.getConceptModeState(): ConceptModeState`；`ConceptModeState.completeImplDemands`（供 T1 的计数使用）

**语义（务必与测试一致）**：
- **进入**：`task_start` 或 user `turn_message` 的分类 ∈ `{explanation, algorithm}`；
- **退出**（仅两条）：① 学生**本人**编辑了代码（`code_edit` 且 `editor !== "ai"`）；② 学生消息分类 ∈ `{debugging, refactoring, testing, language_request}`（说明已在处理**具体已有代码**）；
- **索要完整代码不退出**（这是本次修订的核心反例）；仅令 `completeImplDemands += 1`。

- [ ] **Step 1: 写失败测试**

```ts
// src/core/task/student-analytics/__tests__/ConceptModeGate.test.ts
import { expect } from "chai"
import { INITIAL_CONCEPT_MODE_STATE, nextConceptMode } from "../ConceptModeGate"

const s = (o: Partial<Parameters<typeof nextConceptMode>[1]>) => ({
	category: undefined, studentEdited: false, wantsCompleteImpl: false, ...o,
})

describe("F3 · 概念模式粘性", () => {
	it("起始为概念类 → 进入", () => {
		expect(nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" })).active).to.equal(true)
	})
	it("起始为 code_generation → 不进入", () => {
		expect(nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "code_generation" })).active).to.equal(false)
	})
	it("category 缺失 → 不进入", () => {
		expect(nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: undefined })).active).to.equal(false)
	})
	it("★ 连续 5 次索要完整代码也不退出（旧行为会撤销护栏）", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		for (let i = 0; i < 5; i++) {
			st = nextConceptMode(st, s({ category: "code_generation", wantsCompleteImpl: true }))
			expect(st.active).to.equal(true)
		}
		expect(st.completeImplDemands).to.equal(5)
	})
	it("学生本人编辑代码 → 退出", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		st = nextConceptMode(st, s({ category: "algorithm", studentEdited: true }))
		expect(st.active).to.equal(false)
	})
	it("转为 debugging（在处理已有代码）→ 退出", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		st = nextConceptMode(st, s({ category: "debugging" }))
		expect(st.active).to.equal(false)
	})
	it("★ 退出后需新的概念信号才可重新进入（非概念提问不得复活）", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		st = nextConceptMode(st, s({ category: "debugging" }))
		expect(st.active).to.equal(false)
		// ① 非概念分类不得复活
		expect(nextConceptMode(st, s({ category: "other" })).active).to.equal(false)
		expect(nextConceptMode(st, s({ category: "code_generation", wantsCompleteImpl: true })).active).to.equal(false)
		// ② 学生再次提出概念问题 ⇒ 按"学生侧分类"口径重新进入
		expect(nextConceptMode(st, s({ category: "algorithm" })).active).to.equal(true)
	})
	it("completeImplDemands 只增不减", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		st = nextConceptMode(st, s({ category: "code_generation", wantsCompleteImpl: true }))
		st = nextConceptMode(st, s({ category: "algorithm" }))
		expect(st.completeImplDemands).to.equal(1)
	})
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm run test:unit -- --grep "F3 · 概念模式粘性"` → Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// ① 新建 src/core/task/student-analytics/ConceptModeGate.ts
import type { TaskCategory } from "./types"

const CONCEPTUAL: ReadonlySet<TaskCategory> = new Set<TaskCategory>(["explanation", "algorithm"])
/** 表示"学生在处理已有的具体代码" → 概念护栏退出 */
const CODE_WORK: ReadonlySet<TaskCategory> = new Set<TaskCategory>([
	"debugging", "refactoring", "testing", "language_request",
])

export interface ConceptModeSignals {
	category: TaskCategory | undefined
	studentEdited: boolean
	wantsCompleteImpl: boolean
}
export interface ConceptModeState {
	active: boolean
	completeImplDemands: number
}
export const INITIAL_CONCEPT_MODE_STATE: ConceptModeState = { active: false, completeImplDemands: 0 }

export function nextConceptMode(prev: ConceptModeState, s: ConceptModeSignals): ConceptModeState {
	const demands = prev.completeImplDemands + (prev.active && s.wantsCompleteImpl ? 1 : 0)
	// 退出只有两条 —— **索要完整代码不退出**（这是本次修订的核心）
	if (prev.active && (s.studentEdited || (s.category !== undefined && CODE_WORK.has(s.category)))) {
		return { active: false, completeImplDemands: demands }
	}
	const active = prev.active || (s.category !== undefined && CONCEPTUAL.has(s.category))
	return { active, completeImplDemands: demands }
}
```

```ts
// ② BehaviorMonitor：持有并推进状态
private conceptModeState: ConceptModeState = INITIAL_CONCEPT_MODE_STATE

// ingest() 内（紧跟 currentTaskCategory 赋值之后）
// ⚠️ 分类**只在学生侧事件上读**：实测 adoption_infer 事件也带 category（如 language_request），
//    若不加这个门，助手事件会误触发 CODE_WORK 退出 —— 必须与 currentTaskCategory 同一口径。
const isStudentIntent =
	event.eventType === "task_start" || (event.eventType === "turn_message" && event.role === "user")
this.conceptModeState = nextConceptMode(this.conceptModeState, {
	category: isStudentIntent ? event.category : undefined,
	studentEdited: event.eventType === "code_edit" && event.editor !== "ai",
	wantsCompleteImpl: isStudentIntent && event.category === "code_generation",
})

public getConceptModeState(): ConceptModeState {
	return this.conceptModeState
}
// reset() 内追加： this.conceptModeState = INITIAL_CONCEPT_MODE_STATE
```

```ts
// ③ index.ts:2308 —— 注入条件改为粘性状态（不再看单轮分类）
const conceptState = this.getBehaviorMonitor()?.getConceptModeState()
if (conceptState?.active) {
	systemPromptFinal += buildConceptModeConstraint()
	Logger.log(`[Task] 概念问答模式约束已注入 (sticky, demands=${conceptState.completeImplDemands})`)
}
// ⚠️ `isConceptModeCategory()` **不再是注入判定/可见化判定的门控**：粘性化后，在"学生反复索要
//    完整实现"这一目标场景里单轮分类会变成 code_generation，若还用它做门控，可见化会在最需要时
//    静默失效。函数本体保留在 conceptModeConstraint.ts 供既有单测与向后兼容使用。
// 【同一轮内两个读取点的口径必须一致】注入点与违规可见化点都用 getConceptModeState()?.active。
```

```ts
// ④ conceptModeConstraint.ts —— 在**第 4 条规则之后、示例块之前**补一条（保持规则编号连续、
//    插入到示例之后会让"5."出现在示例下方，阅读顺序错乱）
"5. 即使学生反复、持续索要完整代码，也不得因此放弃上述约束；可给的上限是：关键步骤片段 + 伪代码骨架（不含完整循环与返回）。",
```

- [ ] **Step 4: 跑测试 + 补两条关键边界**

Run: `npm run test:unit -- --grep "F3 · 概念模式粘性"` → Expected: **8 passing**
在 `ConceptModeGate.test.ts` 追加：
① `nextConceptMode(active, { category: undefined, studentEdited: false, wantsCompleteImpl: false })` → **仍 active**（缺分类不得误退出）；
② 结合 monitor 的集成断言：`ingest` 一条 `adoption_infer`（`category: "language_request"`）后 `getConceptModeState().active` **仍为 true**（防助手事件误退出）。
Run: `npm run test:unit` → Expected: **≥846 passing / 111 pending / 0 failing**
Run: `npx tsc --noEmit` → Expected: **0 error**

- [ ] **Step 5: 提交**

```bash
git add src/core/task/student-analytics/ConceptModeGate.ts src/core/task/student-analytics/__tests__/ConceptModeGate.test.ts \
  src/core/task/student-analytics/BehaviorMonitor.ts src/core/task/index.ts src/core/teaching/conceptModeConstraint.ts
git commit -m "fix(teaching): make the concept-mode guard sticky so demanding full code no longer lifts it"
```

**✅ 落地记录（2026-10-12）**：`8389c117`（实现）+ `897d0499`（第一轮复审后的修复）—— 两轮复审最终 **Approved**。

实际与本文有三处不同（**以代码为准，本文已同步订正**）：
1. **`index.ts` 改了两处而不是一处**。除了注入点，**违规可见化点**也必须换成粘性 `active`：可见化原文用 `isConceptModeCategory(monitor?.getTaskCategory())`，而本 Task 的目标场景（学生反复索要 → 单轮分类变 `code_generation`）恰好会让它恒为 false ⇒ 护栏最该被检验的那一轮反而**不进日志**。
   - 方向安全：不存在"新门控触发但护栏从未注入"的序列（`active` 只能由学生侧 `explanation`/`algorithm` 置真，该事件必前置于被判定的助手轮次）。
   - 副作用：`isConceptModeCategory` 在 `src/` 内只剩测试引用（函数本体保留不删）。
2. **测试名订正**：本文 Step 1 原写的"退出后不会因后续概念提问而自动复活"与实际语义相反（`nextConceptMode` 在后续新概念信号下**会**重新进入，这是有意行为）；已改为断言**双方向**。`nextConceptMode` 的判定逻辑未改。
3. **第 5 条规则的位置**：本文原写"在返回数组末尾补一条"，实测会落在"示例"块**之后**（编号 5 出现在示例下方）。已改为插在第 4 条之后、示例之前。

实际测试：`ConceptModeGate.test.ts` 共 **13 例**（8 验收 + 2 边界 + 3 补缺）；`--grep "F3"` = 13 passing。

---

## 4. L2 优先级综合测试（统一模板 + 各优先级专项断言）

**每次进入下一优先级前，必须新增并跑通一个 `priorityGate.pN.test.ts`。** 文件骨架（四个 P 共用，只换 `describe` 名与专项断言）：

```ts
// src/core/task/student-analytics/__tests__/priorityGate.pN.test.ts
import { expect } from "chai"
import { BehaviorMonitor } from "../BehaviorMonitor"
import { TeachingInterventionManager } from "../TeachingInterventionManager"
import { getRulePolicy } from "../rulePolicy"
import { ev } from "./__fixtures__/events"   // 抽出的公共事件构造器（见 Step 1）

describe("GN · 优先级综合（可跑通 + 边界）", () => {
	it("★ 核心流程端到端：违规 → 计数 → 升级 → 阻断文本 → 阻断态生效", () => {
		const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m.ingest(ev({})); m.ingest(ev({})); m.ingest(ev({}))
		const mgr = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		const text = mgr.checkAndGenerateIntervention(m, 3)
		expect(text).to.be.a("string").and.to.include("阻断模式")
		expect(mgr.isBlockingActive()).to.equal(true)
	})

	it("★ 边界：阈值前一轮不阻断、恰好阈值阻断", () => {
		const m2 = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		m2.ingest(ev({})); m2.ingest(ev({}))
		expect(m2.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
		m2.ingest(ev({}))
		expect(m2.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(true)
	})

	it("★ 边界：概念问答下规则被门控停用（rulePolicy）", () => {
		expect(getRulePolicy("consecutive_code_generation", "algorithm").enabled).to.equal(false)
		expect(getRulePolicy("consecutive_code_generation", "code_generation").enabled).to.equal(true)
	})

	it("★ 边界：冷却不影响计数、只影响提示条数", () => {
		const m3 = new BehaviorMonitor("t1", { cooldownMs: 120_000, escalationBlockingThreshold: 3 })
		m3.ingest(ev({})); m3.ingest(ev({})); m3.ingest(ev({}))
		expect(m3.getEscalationCount("consecutive_code_generation")).to.equal(3)
		expect(m3.getPendingAlerts().length).to.equal(1)
	})

	it("★ 兜底路径：警报队列被清空后，阻断仍生效且文本非空（阻断不依赖 pendingAlerts）", () => {
		const m4 = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m4.ingest(ev({})); m4.ingest(ev({})); m4.ingest(ev({}))
		// ★ 必须先消费掉队列：命中阈值时阻断分支在 `hasPendingAlerts()` **之前**就已 return，
		//   不消费的话这条用例只是例 ① 的复述，观察不到"阻断不依赖警报队列"。
		m4.consumePendingAlerts()
		expect(m4.hasPendingAlerts()).to.equal(false)
		const mgr4 = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		expect(mgr4.checkAndGenerateIntervention(m4, 3)).to.be.a("string").and.to.not.be.empty
	})

	it("★ 边界：有警报但未达升级阈值，且队列被消费后 ⇒ 不注入（返回 null）", () => {
		// 真正的"无警报兜底"是 `if (!monitor.hasPendingAlerts()) return null`（**不注入**）；
		// 上一条的"文本非空"来自**阻断路径**，两者不是同一条路径，必须分别覆盖。
		const m6 = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
		for (let i = 0; i < 8; i++) m6.ingest(ev({ hasCodeBlock: false }))
		expect(m6.getEscalationCount("no_edit_streak")).to.equal(1) // 1 < 3 ⇒ 不阻断
		expect(m6.hasPendingAlerts()).to.equal(true)
		m6.consumePendingAlerts()
		const mgr6 = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		expect(mgr6.checkAndGenerateIntervention(m6, 3)).to.equal(null)
	})

	it("★ 关掉特性开关后行为回到旧口径（enabled=false）", () => {
		const m5 = new BehaviorMonitor("t1", { enabled: false, cooldownMs: 0, escalationBlockingThreshold: 3 })
		m5.ingest(ev({})); m5.ingest(ev({})); m5.ingest(ev({}))
		expect(m5.getPendingAlerts()).to.have.length(0)
		expect(m5.shouldEscalateToBlocking("consecutive_code_generation")).to.equal(false)
	})
})
```

- [ ] **Step 0（G0 之前一次）**：新建 `src/core/task/student-analytics/__tests__/__fixtures__/events.ts`，导出上文各文件复用的 `ev()` 构造器（DRY），并把 T2/T1/T3 测试改为从它导入。

### 各优先级的专项断言（每个 G 必须全部覆盖）

| G | 优先级 | 除统一模板外**必须**包含的专项断言 |
|---|---|---|
| **G0** | P0 | ① `escalationBlockingThreshold === 3`；② AI 落盘事件带 `editor: "ai"` 且不清零 streak；③ 真人编辑清零 streak（但**不清零** `escalationCounter`，计数单调）；④ 概念模式在"索要完整代码 ×5"后 `active` 仍为 `true`；⑤ 学生本人编辑后 `active === false`；⑥ 阻断态可被外部观察到（`isBlockingActive()` / `getBlockingEndsAt()`，**不是** `getBlockingState()`）；⑦ **【T9-b】**`high_adoption_low_self_modification` 在窗口聚合条件成立时**逐轮计数并可达阻断阈值**（不得恒为 0） |
| **G1** | P1 | ① `buildIndexGroups()` 返回**全 18 周**；② `buildWikiSystemPrompt` 三档策略命中（A/B/C 各一条）；③ 分类粘性：短消息不覆盖强分类；④ 干预文本**不进入** `apiConversationHistory`；⑤ `countMatches("排序与实现")` 词边界不误配 |
| **G2** | P2 | ① MCP 周数热读：文件改 `week=18` 后无需重启即生效；② 切换周数时 userContent 追加变更通知（仅一次）；③ `--week` 缺省仍可用（向后兼容）；④ `ai_dependency` 新指标在"1 问 6 答"下**不再**恒真触发 |
| **G3** | P3 | ① `extractInterventionCopy` 六类用例全绿；② 三条确定性校验失败 → 降级模板 + `copy_rejected`；③ 主题锚定失败 → **不降级**、只记 `copy_topic_unanchored`；④ 两条显示路径（`text` / `completion_result`）都能剥离回执块；⑤ `hasDeliveredKeyCode` 可由工具落盘置位 |

### G0 门槛（P0 完成时必须输出）

Run: `npm run test:unit -- --grep "G0 · 优先级综合"` → Expected: **全绿**
Run: `npm run test:unit` → Expected: **0 failing**（passing 数 ≥ 852）
Run: `npx tsc --noEmit` → Expected: **0 error**
❌ 任一红 → 修复后重跑，**不得进入 P1**。

**✅ 落地记录（2026-10-12）**：`b35b637e`（门禁本体 + 公共构造器）+ `03848e00`（第一轮复审后的修复）—— 两轮复审最终 **Approved**。

- 新增 `__tests__/__fixtures__/events.ts`（`ev()` + `editEv()`）。它位于 `__fixtures__/` 子目录，**不在** `.mocharc.json` 的 `src/**/__tests__/*.ts` glob 内（`*` 不跨 `/`），因此不会被当作 spec 执行。
- 三个既有 spec 改为导入公共构造器（净 −50 行重复）：`escalationReachability.test.ts` 与 `ConceptModeGate.test.ts` 导入 `ev`；`codeEditAttribution.test.ts` 导入 `editEv as ev`（它的本地 builder 默认值本就不同：`eventType/role/category` 不同、无 `hasCodeBlock`）。**三者断言体零改动**，分文件计数不变（F2=8 / F1=14 / F3=13）。
- `priorityGate.p0.test.ts` 实际 **14 例**：统一模板 6 例 + 专项 ①–⑦ + **1 例新增的"不注入"边界**（见下）。
  - ⚠️ **模板例 ⑤ 的措辞已订正**：本文原写"即使无新警报，干预文本仍非空"，但实际 API 的"无警报兼底"是 `if (!monitor.hasPendingAlerts()) return null`（**不注入**）；"文本非空"来自**阻断路径**（阻断判定不依赖警报队列）。两例已分别覆盖：一条先 `consumePendingAlerts()` 再断言非空字符串；一条在"计数 1 < 阈值 3 且队列已消费"下断言返回 `null`。
  - ⚠️ **专项断言 ③ 的语义已补注**：学生本人编辑只清零 `assistantCodeStreak`，**不清零** `escalationCounter`（计数单调，即 spec §9.6-B 的已登记残留）。因此该例断言的是"不再发提醒"（`getPendingAlerts()` 不含该规则），而不是"计数回落"。
- 全局静态阻断态的隔离：`beforeEach` 归零 + `after()` **还原模块加载时的快照**（不是简单归零），确保同进程内字母序在后的 `requestIntentRefiner` / `rulePolicy` 不被汄染。
- 实测：`--grep "G0"` = **14 passing**；全量 **877 passing / 111 pending / 0 failing**；`tsc --noEmit` 0 错。

---

## 5. P1 任务

### Task 4（F4）：全周目录索引 + 三档应答策略

**Files:** Modify `src/core/teaching/wikiPrompt.ts`（整文件重写策略段）、`src/core/teaching/LLMWikiService.ts`（`buildIndexGroups` 约 205–245）、`src/core/teaching/mcp-wiki-server.ts`（`search_wiki` 的 description 约 29–31）、`src/core/teaching/__tests__/wikiPrompt.test.ts`（断言随策略更新）。

**Interfaces:** Produces `buildWikiSystemPrompt({week, index, mcpAvailable}): string`（签名不变，**语义变**）；`buildIndexGroups(): {week, titles}[]` 由"≤ currentWeek"放宽为**全周**。

```ts
// ① LLMWikiService.buildIndexGroups —— 删除周数过滤，改为全周（只含标题，仍无正文）
const push = (week: number, rawTitle: string): void => {
	// 【F4】不再 `if (week > this._currentWeek) return`：模型需要知道"后面还有什么"，
	//        否则只能说"未发布"，无法给出"这属于第 N 周"的定位。仍只注入标题元数据。
	const title = normalizeIndexTitle(rawTitle)
	if (!title) return
	// …（原有 byWeek 去重逻辑不变）…
}
```

```ts
// ② wikiPrompt.ts —— 二值"命中/拒答"改为 A/B/C 三档
parts.push([
	"# 认知边界约束（不可违反）",
	`1. 你只能引用通过 search_wiki / read_wiki_chunk 检索到的资料作为**教材依据**。`,
	`2. 若检索结果为空，按下列三档处理（**不要一律拒答**）：`,
	`   - 【A 在进度内】第 ${week} 周及更早且检索命中 → 以资料为依据，教材对齐。`,
	`   - 【B 超纲、无资料】→ **可以讲解**，但必须：① 标注「📌 这属于第 N 周内容，你现在学到第 M 周」；`,
	`     ② 先补齐当前进度内的前置基础；③ **不给完整可运行实现**（关键步骤 + 伪代码骨架为上限）。`,
	`   - 【C 超纲、可联网】→ 联网只用于**校验通用知识**；结论仍须回落到教材口径与当前阶段，`,
	`     不得用外部资料覆盖教材定义。`,
	`3. 可以使用超出第 ${week} 周的语法，但**必须先说明它超出当前进度**，并给出当前进度内的替代或前置。`,
].join("\n"))
```

```ts
// ③ mcp-wiki-server.ts：工具描述必须同步（它是"不要展开讲解"这句拒答指令的直接来源）
description:
	"在课程资料库中按关键词检索。只返回当前教学周之前（含）已发布的资料。" +
	"返回 0 条表示该知识点尚未在当前进度内发布 —— 此时**仍可讲解**，但需标注所属周次、" +
	"补齐当前进度内的前置基础，并**不要给出完整可运行实现**。",
```

- [ ] **Steps:** ① 先在 `wikiPrompt.test.ts` 改/加断言（A/B/C 三档各一条 + 索引含 week>currentWeek 的标题）→ 跑 `npm run test:unit -- --grep "wikiPrompt"` 确认红；② 落上面三处改动；③ 跑绿；④ `npm run test:unit` 与 `tsc --noEmit` 全绿；⑤ commit `fix(teaching): index all weeks and replace blanket refusal with a three-tier answer policy`。

**✅ 落地记录（2026-10-13，`31f94dd3` + 修复波 `11b2b7eb` + 裁定波 `42446237`）**

1. **本 Task 漏了一环（已在修复波补上）**：只删 `buildIndexGroups()` 的周数过滤是**空操作** —— 客户端只按 `fetchWikiForWeek(getCurrentWeek())` 拉取，而后端 `server.ts` 的 SQL 硬过滤 `applicable_week <= max_week`（且校验 1~18）。⇒ 修复：拉取改用 `INDEX_FETCH_MAX_WEEK = 18`，**返回值仍过滤 `<= currentWeek`**（"能取用"边界由 MCP `--week` + 后端 SQL 强制）。
2. **本文若写"整文件重写策略段"，实际只需替换认知边界约束块**；A/B/C 三档、工具描述、`knowledge` 段均已落地。
3. **`MAX_INDEX_CHARS` 仍是 2400，但截断策略已改为「分级截断」**（裁定 b，`42446237`）：
   - 进度内（`week <= 当前周`）列标题；超前周只列 `- 第 N 周：（M 个主题）`；
   - 超预算时**优先把详细行降级为简略行，而不是 `break`** —— 旧实现按周升序 `break`，被砍掉的正是"当前周之后"的周次，**恰好与 F4 目标相反**；
   - 实测：18 周×8 条长标题 = 2775 字符且 18 周全在；400 条长标题 = 2865 字符且占位串仍出现。

### Task 5（F5）：分类口径粘性化

**Files:** Modify `src/core/task/student-analytics/BehaviorMonitor.ts`（`ingest` 的 `currentTaskCategory` 赋值）、`src/core/task/student-analytics/TaskClassifier.ts`（`countMatches` 词边界）；Test `__tests__/categoryStickiness.test.ts`（新建）、扩 `rulePolicy.test.ts`。

```ts
// BehaviorMonitor.ingest —— 只在"强信号"时覆盖分类
const STRONG: ReadonlySet<TaskCategory> = new Set(["code_generation", "debugging", "refactoring", "testing"])
if (isStudentIntent) {
	const prev = this.currentTaskCategory
	// 【F5】短消息（如「再实现一个快速排序」被判成 algorithm）不得覆盖已有的强分类
	if (prev === undefined || STRONG.has(event.category!) || prev !== "code_generation") {
		this.currentTaskCategory = event.category
	}
}
```
> 口径说明（与测试一致）：`code_generation` 一旦确立即**粘住**，只有 `debugging/refactoring/testing` 这类"在新代码上工作"的强信号才可覆盖它；`algorithm/explanation/other` 不再覆盖它。

```ts
// TaskClassifier.countMatches —— 加词边界（F5 第 2 条 + F11 第 1 条同源修复）
private countMatches(text: string, keywords: string[]): number {
	let count = 0
	for (const kw of keywords) {
		const k = kw.toLowerCase()
		// 【F5/F11】ASCII 拉丁词用词边界；CJK 无词边界概念，保持 includes
		const re = /^[a-z0-9+#.]+$/.test(k) ? new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null
		if (re ? re.test(text) : text.includes(k)) count++
	}
	return count
}
```
> 边界用例（必须写进 `categoryKeywordBoundary.test.ts`）：`"c#"` 不应命中 `"c#abc"` 之外无意义文本；`"go"` 不应命中 `"going"`/`"algorithm"`；`"js"` 不应命中 `"json"`；`"排序与实现"` 应同时命中 algorithm 与 code_generation。

### Task 6（F6）：干预不进对话历史

**Files:** Modify `src/core/task/index.ts`（约 2932–2960 的干预注入块）、`src/core/task/student-analytics/InterventionMessageGenerator.ts`（`formatInterventionForInjection` 的引导语）。

```ts
// index.ts —— 普通干预：只作为**本轮**的一次性文本，不写进持久化历史
if (interventionText) {
	userContent.push({ type: "text", text: interventionText })
	this.ephemeralBlockIndices.add(userContent.length - 1)   // 新增私有字段：Set<number>
}
// 在 `messageStateHandler.addToApiConversationHistory({ role: "user", content: userContent })` 之前：
const persistedContent = userContent.filter((_, i) => !this.ephemeralBlockIndices.has(i))
await this.messageStateHandler.addToApiConversationHistory({ role: "user", content: persistedContent })
this.ephemeralBlockIndices.clear()
```
> ⚠️ **不变量**：`apiConversationHistory` 中**永远不得**出现 `<teaching_intervention`。该不变量由 G1 的专项断言④守护（读 history → `expect(JSON.stringify(history)).to.not.include("teaching_intervention")`）。

```ts
// formatInterventionForInjection —— 取消"改写成像你自己给的"，改为显式标记 + 禁止自由改写
"请在你的回复开头，用 <teaching_intervention_copy> 块给出本轮的干预文案（格式见任务书）。",
"注：不要提及这是系统自动插入的消息；但**必须**使用上述块，不得只在正文里自由发挥。",
```
> P1 阶段先只做"不进历史 + 显式块要求"，**校验/降级在 T13 落地**；此阶段块内容缺失时按现有模板文案渲染（行为与今天一致，不引入回归）。

> **G1 门槛**：`npm run test:unit -- --grep "G1 · 优先级综合"` 全绿 + 全量 0 failing + `tsc --noEmit` 0 错。不绿不得进入 P2。

---

## 6. P2 任务

### Task 7（F7）：周数热更新 + 切换通知

**Files:** Create `src/core/teaching/weekStateFile.ts`；Modify `src/core/teaching/mcp/args.ts`、`src/core/teaching/mcp-wiki-server.ts`、`src/core/teaching/mcp/wikiBackend.ts`、`src/core/task/index.ts`。

```ts
// ① weekStateFile.ts —— 插件与 MCP 进程之间的唯一共享状态（MCP 是独立进程，读不到 VS Code 配置）
export interface WeekState { week: number; updatedAt: string }
/** 路径必须与 McpHub 用同一个目录函数推导，禁止硬编码扩展 ID */
export async function weekStatePath(): Promise<string>
export async function writeWeekState(week: number): Promise<void>     // 插件侧（周数变更时调用）
export async function readWeekState(): Promise<number | null>          // MCP 侧（只读，失败返回 null）
```

```ts
// ② mcp-wiki-server.ts —— 每次工具调用前热读；失败回退 spawn 参数（向后兼容）
let effectiveWeek = week
try { effectiveWeek = (await readWeekState()) ?? week } catch { effectiveWeek = week }
const r = await callSearchWiki(serverUrl, effectiveWeek, String(args.query ?? ""), Number(args.limit ?? 5))
```

```ts
// ③ index.ts —— 周数变更时一次性注入通知（直接对抗"对话历史自我锚定"，见 spec §8.3）
private lastInjectedWeek: number | undefined
// attemptApiRequest 组装 userContent 时：
const wk = LLMWikiService.getInstance().getCurrentWeek()
if (this.lastInjectedWeek !== undefined && this.lastInjectedWeek !== wk) {
	userContent.push({ type: "text", text:
		`⚠️ 教学周已由第 ${this.lastInjectedWeek} 周切换为第 ${wk} 周；此前基于旧进度的回答请以新进度为准。` })
}
this.lastInjectedWeek = wk
```

**边界**：① `teaching-week.json` 缺失/损坏 → 用 `--week`（不抛错）；② 同周重复注入 → **不重复**通知；③ `clampWeek` 仍限 1..18。

### Task 8（F8）：联网检索 MCP server（provider 无关）

**Files:** Create `src/core/teaching/mcp-web/webSearchServer.ts`、`src/core/teaching/WebMcpRegistrar.ts`；Modify `src/core/teaching/WikiMcpRegistrar.ts`（抽公共注册器）或并列实现；新增配置 `clineTeaching.webSearchEnabled`（**默认 `false`**，教师端可统一下发）。

**要点（与 wiki 范式逐条对齐，不得自创）**：stdio + chokidar 自动重载 + 禁用可控（移除而非 `disabled:true`）+ 工具失败返回结构化错误 JSON（**不阻断对话**）+ 工具描述写明"仅用于校验通用知识，回答口径仍以教材与当前周为准"。
**理由（必须写进代码注释）**：`web_search`/`web_fetch` 的暴露条件是 `providerInfo.providerId === "cline"`（`system-prompt/tools/web_search.ts:19`），学生端用 DeepSeek ⇒ 原生工具**永远不出现**，只能走 MCP。

### Task 9（F9）：`ai_dependency` 指标改造

**Files:** Modify `src/core/task/student-analytics/BehaviorMonitor.ts`（新增 `assistantTurnsWithoutUser`；重写 `checkHighRecentAiDependencyRule`）、`src/core/task/student-analytics/rulePolicy.ts`（概念问答下该规则 `enabled: false`）；扩 `__tests__/behaviorMonitor.taskCategory.test.ts`。

```ts
// ① 新增计数字段，在 ingest 中维护
private assistantTurnsWithoutUser = 0
if (event.eventType === "turn_message") {
	if (event.role === "assistant") this.assistantTurnsWithoutUser++
	else this.assistantTurnsWithoutUser = 0   // 学生一发言即归零
}

// ② 规则改为**绝对回合数**（比例指标在 Cline 多工具循环下分母极小、恒真，见 spec §8.6）
private checkHighRecentAiDependencyRule(isTurn: boolean): void {
	if (!isTurn) return
	if (this.assistantTurnsWithoutUser < this.options.minTurnsForDependency) return
	this.bumpEscalation("high_recent_ai_dependency")
	this.notify("high_recent_ai_dependency", /* 原 message 不变 */ "", this.assistantTurnsWithoutUser,
		this.options.minTurnsForDependency)
}

// ③ rulePolicy.ts：概念问答下该规则**不提示**（它原本只禁用了升级）
if (CONCEPTUAL_CATEGORIES.has(category) && ruleId === "high_recent_ai_dependency") {
	return { enabled: false, canEscalateToBlocking: false }
}
```

**边界**：① `assistantTurnsWithoutUser === 5` 不触发、`=== 6` 触发（阈值边界）；② 学生插话后立即归零；③ 概念问答下**零**提示（M2' 的通过条件）；④ `reset()` 归零。

> **G2 门槛**：`--grep "G2 · 优先级综合"` 全绿 + 全量 0 failing + `tsc --noEmit` 0 错。

---

## 7. P3 任务

### Task 10（F10）：`hasDeliveredKeyCode` 兼容工具落盘

```ts
// index.ts:1101 附近 —— 置位条件由"仅消息文本 fenced 块"扩展为"文本块 **或** 落盘工具"
private static readonly FILE_WRITING_TOOLS = new Set(["write_to_file", "apply_patch", "replace_in_file"])
// persistAssistantTurnLog 内：
if (analysis.hasCodeBlock || toolsUsed.some((t) => Task.FILE_WRITING_TOOLS.has(t))) {
	this.hasDeliveredKeyCode = true
}
```
**边界**：① 只落盘、文本无代码块 → 仍置位；② 只读文件（`read_file`）→ **不**置位；③ `hasDeliveredKeyCode` 单任务内单调（不回落，与现状一致，注释明示）。

### Task 11（F11）：三处数据质量修正

① `countMatches` 词边界 —— **已在 T5 落地**，此处只补 `categoryKeywordBoundary.test.ts` 的完整用例集；
② `AdoptionTracker` 恒 `adopted`：`onUserMessage()` 的判定加"同一主题"前提，非同一主题返回 `"unknown"`（并补测：换题后不再记 `adopted`）；
③ `code_edit` / `file_save` 的 `role`：`editor === "ai"` 时写 `role: "assistant"`（供教师端区分"AI 的劳动"与"学生动手"）。

```ts
// CodeEditTracker.flushEdit / onDocumentSave —— 归属与 role 一并写
const editor = resolveEditEditor(relativePath, this.fileContextTracker)
const log: StudentInteractionLog = { /* … */, editor, role: editor === "ai" ? "assistant" : "user" }
```
> ⚠️ **影响面**：`user_edit_count` 与看板"学生动手情况"口径变化（spec §11 已登记），需在 CHANGELOG 说明。

### Task 12（F12）：方言（DSML）归一化 —— **P4，最后执行**

> 实施细节与步骤见 **§7.5 P4 任务**。此前写作阶段曾定为"仅登记、不改代码"，**用户已于 2026-10-11 裁决纳入本次范围并独立为 P4**。

**Files:** 无。在 `docs/design/teaching-intervention-acceptance-and-revisions.md` §9.4 保持"需单独排期"。
**本 Task 的唯一交付**：在 `CHANGELOG.md` 的 `[Unreleased]` 下补一条"已知问题"，说明 M1 类用例受方言问题制约、验收结论以 M11'–M13' 为准。**不得在此 Task 改任何感知层代码**（治本改造风险高、须单独排期）。

### Task 13（F13）：让模型成为干预文案的叙述层

**Files:**
- Create: `src/shared/markdown/interventionCopy.ts` + `src/shared/markdown/__tests__/interventionCopy.test.ts`
- Create: `src/core/task/student-analytics/InterventionCopyContract.ts` + `__tests__/interventionCopyContract.test.ts`
- Modify: `src/core/task/student-analytics/InterventionMessageGenerator.ts`（`formatInterventionForInjection` 任务书化）
- Modify: `src/core/task/index.ts:2606`（text 路径：解析 + 校验 + 降级 + 落事件）
- Modify: `src/core/task/tools/handlers/AttemptCompletionHandler.ts:37 / 120 / 150`（completion 路径：**仅剥离**）
- Modify: `src/core/task/student-analytics/types.ts`（新增 `eventType: "intervention_copy"`）

**Interfaces:**
- Consumes: `parseFencedCodeBlocks`（`@/shared/markdown/codeBlocks`）、T6 产出的 `lastInjectionTemplate`
- Produces: `extractInterventionCopy(text): { found: {rule?, severity?, copy} \| null; rest }`；`validateCopy(copy, ctx): CopyValidation`；`buildCopyTaskSheet(input): string`

```ts
// ① interventionCopy.ts —— 解析 + 剥离（纯函数）
const BLOCK_RE = /<teaching_intervention_copy\b([^>]*)>([\s\S]*?)<\/teaching_intervention_copy>/g
const ATTR_RE = /(\w+)="([^"]*)"/g

export interface ExtractedCopy { rule?: string; severity?: string; copy: string }

/** 命中返回首个块 + **剥离后**的正文；未命中 found 为 null、rest 为原文（恒等变换）。 */
export function extractInterventionCopy(text: string): { found: ExtractedCopy | null; rest: string } {
	if (!text || !text.includes("<teaching_intervention_copy")) return { found: null, rest: text }
	let found: ExtractedCopy | null = null
	const rest = text.replace(BLOCK_RE, (_m, attrs: string, inner: string) => {
		if (!found) {
			const a: Record<string, string> = {}
			for (const m of attrs.matchAll(ATTR_RE)) a[m[1]] = m[2]
			found = { rule: a.rule, severity: a.severity, copy: inner.trim() }
		}
		return "" // 所有块一律剥离（含多块），学生只看到文案
	})
	return { found, rest: rest.replace(/\n{3,}/g, "\n\n").trim() }
}
```
> **边界（必须写进测试）**：① 未闭合标签 → `found === null` 且 `rest === 原文`；② 多块 → 取首个为 copy、其余一并剥离；③ 块在正文中间 → 两侧文字保留、空行归一；④ 空块 → `copy === ""`（交由校验拒绝）。

```ts
// ② InterventionCopyContract.ts —— 三条**确定性**校验（失败→降级）+ 一条**启发性**校验（只记账）
const MAX_COPY_CHARS = 120
const FORBIDDEN = [/系统|检测|自动插入/, /(下次|以后).{0,6}(直接|再).{0,6}(完整|全部)代码/]

export interface CopyValidation { ok: boolean; downgrade: boolean; reasons: string[]; advisories: string[] }

export function validateCopy(copy: string, ctx: { recentTexts: string }): CopyValidation {
	const reasons: string[] = []
	const advisories: string[] = []
	// emoji 不计入长度
	const stripped = copy.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim()
	if ([...stripped].length > MAX_COPY_CHARS) reasons.push("too_long")
	if (parseFencedCodeBlocks(copy).length > 0) reasons.push("has_fenced_code")
	if (!/[?？]|试|想|请|先|动手|写一/u.test(copy)) reasons.push("no_blank")
	if (FORBIDDEN.some((re) => re.test(copy))) reasons.push("forbidden_phrase")
	// 启发性：与最近 2 轮（学生提问 + 助手回复）的实义词交集 ≥ 1 —— **只记账，不降级**（用户裁定）
	const words = new Set((ctx.recentTexts.match(/[\u4e00-\u9fa5]{2,}|[A-Za-z_]{3,}/g) ?? []).map((w) => w.toLowerCase()))
	if (![...words].some((w) => copy.toLowerCase().includes(w))) advisories.push("topic_unanchored")
	return { ok: reasons.length === 0, downgrade: reasons.length > 0, reasons, advisories }
}
```

```ts
// ③ InterventionMessageGenerator.formatInterventionForInjection —— 交付「任务书」而非成品文案
`<teaching_intervention rule="${ruleId}" severity="${severity}">`,
`力度档（**不得更改**）：${severity} —— ${SEVERITY_VOICE[severity]}`,
`必须包含三要素：① 中性的"我（AI）做了什么"的观察（不得指控学生）；`,
`② **锚定当前主题**的可执行建议（必须引用本轮的具体知识点/代码，禁止泛泛的"改个变量名"）；`,
`③ 一句把主动权交回学生的话。`,
`硬约束：总长 ≤ ${MAX_COPY_CHARS} 字（emoji 不计）；**不得含代码块**；不得承诺；不得提及"系统/检测/自动"。`,
`输出格式（必须）：`,
`<teaching_intervention_copy rule="${ruleId}" severity="${severity}">…文案…</teaching_intervention_copy>`,
`参考样例（仅作力度锚点，不要照抄）：${templateText}`,
`</teaching_intervention>`,
```

```ts
// ④ index.ts:2606 —— text 路径：解析 → 校验 → 降级 → 落结构化事件
const { found, rest } = extractInterventionCopy(content)
content = stripLeakedToolCallMarkup(rest)
if (found) {
	const v = validateCopy(found.copy, { recentTexts: this.recentCopyContext() })
	const fallback = this.lastInjectionTemplate ?? ""
	const shown = v.ok ? found.copy : fallback
	content = shown ? `${shown}\n\n---\n\n${content}` : content
	void this.persistStudentInteractionLog({ /* eventType: "intervention_copy" */ 
		ruleId: found.rule, severity: found.severity, voice: v.ok ? "model" : "template",
		reasons: v.reasons, advisories: v.advisories })
}
this.lastInjectionTemplate = null   // 一轮即失效，避免跨轮串味
```
```ts
// ⑤ AttemptCompletionHandler.ts（3 处）—— 该路径**只剥离**，呈现交给 text 路径
const { rest } = extractInterventionCopy(result)
await config.callbacks.say("completion_result", config.callbacks.removeClosingTag(block, "result", rest), undefined, undefined, block.partial)
```
> `intervention_copy` 事件就是 spec §6.5「`intervention_evaluation` 无人写入」缺失的那个写入方 —— 本仓库先落本地日志，教师端消费列为跨仓跟进项。

- [ ] **Step 1**：先写 `interventionCopy.test.ts`（六类用例）+ `interventionCopyContract.test.ts`（超长 121 字 / 含 fenced 代码 / 无留白 / 违禁语 / **主题未锚定应当 `ok===true && downgrade===false`**）→ 跑 `--grep "F13"` 确认红。
- [ ] **Step 2**：落 ①–⑤ → 跑绿；再补一条**集成断言**：注入含回执块的 `content` 到 text 路径后，`say` 出去的内容**不含** `<teaching_intervention_copy`（两条路径都要断言）。
- [ ] **Step 3**：Run `npm run test:unit` → **0 failing**；`npx tsc --noEmit` → **0 error**。
- [ ] **Step 4**：commit `feat(intervention): let the model author intervention copy under a validated contract with template fallback`。

> **G3 门槛**：`--grep "G3 · 优先级综合"` 全绿 + 全量 0 failing + `tsc --noEmit` 0 错。

---

## 7.5 P4 任务（T12 / F12 方言归一化）—— **最后执行，前置 git 存档**

### 前置门禁（硬性，缺一不可）

```bash
# 1) G-ALL（P0–P3）必须全绿；2) 存档作为回退点
git add -A
git commit -m "chore: checkpoint before P4 dialect normalization"
git tag -a pre-f12-checkpoint -m "G-ALL (P0-P3) 全绿基线"
```

### Task 12（F12）：把模型的 DSML 方言归一化为 Cline 规范 XML

**Files:**
- Create: `src/core/assistant-message/dialectNormalize.ts`
- Create: `src/core/assistant-message/__tests__/dialectNormalize.test.ts`
- Modify: `src/core/task/index.ts:3189`（`parseAssistantMessageV2(assistantMessage)` → `parseAssistantMessageV2(normalizeAssistantDialect(assistantMessage))`）
- Modify: `CHANGELOG.md`（原「已知问题」条目改为「已修复」）

**根因（实测，spec §7.5）**：`parseAssistantMessageV2` 对 `<tool>` / `<param>` / `</param>` 做**精确 `startsWith`** 匹配；
而 DeepSeek 系模型输出的方言形如：

| 真实样本（来自 `student_interactions.log`，`｜` = 全角竖线 U+FF5C） | 现状 |
|---|---|
| `｜｜DSML｜｜ calls｜｜` / `｜｜/｜｜DSML｜｜ calls｜｜` | 包裹层，无名字 |
| `｜｜DSML｜｜ invoke name="use_mcp_tool"｜｜` / `｜｜/invoke｜｜` | 工具名在**属性**里 |
| `｜｜DSML｜｜ parameter name="tool_name" string="true"｜｜list_wiki_weeks｜｜/｜｜DSML｜｜ parameter｜｜` | 参数名在属性里，且带 `string="true"` |
| `<use_mcp_tool>\n<server_name>wiki｜｜DSML｜｜ parameter>\n<parameter name="tool_name">…` | **DSML 与 XML 混排**（半畸形） |

⇒ 解析器一个 `tool_use` 都产不出 ⇒ `consecutiveMistakeCount++` ⇒ `index.ts:2710` 输出「AI 连续 N 次没能正确调用工具」（实测 M1 整轮作废）。

**设计约束（与既有 `stripLeakedToolCallMarkup` 同一保守原则）**
1. **不含全角竖线 ⇒ 恒等变换**（覆盖正常回复与合法 XML 的绝大多数情况）；
2. **只在"含标记"的片段上改写**，`write_to_file` 的 `content` 正文行**原样保留**（防止误改学生代码里的符号）；
3. **不得凭空造出工具调用**：只有在同一片段里同时看到"invoke 级"与"parameter 级"标记时才产出标签；
4. 闭合用**栈匹配**：DSML 的闭合标记不带名字（`｜｜/invoke｜｜`），必须靠栈回填；
5. 归一化后**必须再跑一次既有 `stripLeakedToolCallMarkup`**，保证 UI 不出现残渣。

- [ ] **Step 1: 用真实样本写失败测试**

```ts
// src/core/assistant-message/__tests__/dialectNormalize.test.ts
import { expect } from "chai"
import { normalizeAssistantDialect } from "../dialectNormalize"
const P = "\uFF5C" // 全角竖线

describe("F12 · 方言归一化", () => {
	it("★ 恒等变换：正常正文与合法 XML 一字不改", () => {
		const ok = "我先看资料。\n<use_mcp_tool>\n<server_name>wiki</server_name>\n</use_mcp_tool>"
		expect(normalizeAssistantDialect(ok)).to.equal(ok)
	})
	it("★ 实测样本 S1：三次 DSML 调用 → 规范 XML", () => {
		const s1 = [
			`<${P}${P}DSML${P}${P} calls>`,
			`<${P}${P}DSML${P}${P} invoke name="use_mcp_tool">`,
			`<${P}${P}DSML${P}${P} parameter name="server_name">wiki</${P}${P}DSML${P}${P} parameter>`,
			`<${P}${P}DSML${P}${P} parameter name="tool_name" string="true">list_wiki_weeks</${P}${P}DSML${P}${P} parameter>`,
			`<${P}${P}DSML${P}${P} parameter name="arguments">{}</${P}${P}DSML${P}${P} parameter>`,
			`</${P}${P}DSML${P}${P} invoke>`,
			`</${P}${P}DSML${P}${P} calls>`,
		].join("\n")
		const out = normalizeAssistantDialect(s1)
		expect(out).to.include("<use_mcp_tool>")
		expect(out).to.include("<tool_name>list_wiki_weeks</tool_name>")
		expect(out).to.include("</use_mcp_tool>")
		expect(out).to.not.include(P)
		// 交回解析器后必须真的产出 tool_use（端到端判别力，避免"真空通过"）
	})
	it("★ 实测样本 S2：DSML 与 XML 混排也能归一", () => { /* 用日志里 `我确认一下…` 那条 */ })
	it("★ 不得凭空造出工具调用：只有 calls 包裹层时 → 无标签产出", () => {
		const onlyWrap = `<${P}${P}DSML${P}${P} calls>\n</${P}${P}DSML${P}${P} calls>`
		expect(normalizeAssistantDialect(onlyWrap).trim()).to.equal("")
	})
	it("★ write_to_file 的 content 正文含全角竖线时不被改写", () => {
		const body = `<content>\nprint("${P}${P}")\n</content>`
		expect(normalizeAssistantDialect(body)).to.equal(body)
	})
	it("缺省/空串 → 原样返回", () => {
		expect(normalizeAssistantDialect("")).to.equal("")
	})
})
```

- [ ] **Step 2: 跑测试确认失败** `npm run test:unit -- --grep "F12 · 方言归一化"` → FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/core/assistant-message/dialectNormalize.ts
const FULLWIDTH_PIPE = "\uFF5C"
const MARK_G = new RegExp(`${FULLWIDTH_PIPE}{2}DSML${FULLWIDTH_PIPE}{2}`, "g")

/**
 * 把 DSML 方言归一化为 Cline 规范 XML。**对不含标记的文本为恒等变换**。
 * 仅用于 `parseAssistantMessageV2` 的**输入**；不是通用 XML 清洗器（刻意的）。
 */
export function normalizeAssistantDialect(raw: string): string {
	if (!raw || !raw.includes(FULLWIDTH_PIPE)) return raw
	MARK_G.lastIndex = 0
	const stack: string[] = []          // 栈匹配：DSML 的闭合标记不带名字
	const out: string[] = []
	for (const line of raw.split("\n")) {
		if (!MARK_G.test(line)) { MARK_G.lastIndex = 0; out.push(line); continue }
		MARK_G.lastIndex = 0
		// 一行里可能有多个标记（开/值/闭），按标记切成片段逐个处理
		const segments = line.split(new RegExp(`${FULLWIDTH_PIPE}{2}DSML${FULLWIDTH_PIPE}{2}`))
		let rebuilt = ""
		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i]
			const name = seg.match(/name\s*=\s*"([^"]*)"/)?.[1]?.trim()
			const isClosing = /^\/|\/\s*$/.test(seg.trim()) || /^\s*\//.test(seg.replace(/^[^/]*/, ""))
			if (seg.includes("invoke") || seg.includes("parameter")) {
				if (isClosing) { const top = stack.pop(); if (top) rebuilt += `</${top}>` }
				else if (name) { rebuilt += `<${name}>`; stack.push(name) }
				// invoke/parameter 外壳之外的杂散片段（值本身）原样保留
				else rebuilt += seg.replace(/\s+(name|string)\s*=\s*"[^"]*"/g, "")
			} else {
				rebuilt += seg.replace(/\s+(name|string)\s*=\s*"[^"]*"/g, "")
			}
		}
		out.push(rebuilt)
	}
	return out.join("\n")
}
```
> ⚠️ 上面的骨架是**起点而非终稿**：实现者必须**以 Step 1 的真实样本测试为准**迭代（尤其 `isClosing` 的判定与"值片段"保留）。凡测试未覆盖的方言变体，**不得**靠猜测放宽匹配 —— 放宽即意味着可能误改学生代码。

- [ ] **Step 4: 接线 + 端到端判别力**

```ts
// index.ts:3189
this.taskState.assistantMessageContent = parseAssistantMessageV2(normalizeAssistantDialect(assistantMessage))
```
在测试文件补一条**判别力**断言（防止"真空通过"）：把样本 S1 归一化后喂给 `parseAssistantMessageV2`，断言结果里**存在** `{ type: "tool_use", name: "use_mcp_tool" }` 且其 `params.tool_name === "list_wiki_weeks"`。

- [ ] **Step 5: 回归（**风险最高**）**

Run: `npm run test:unit` → **0 failing**（既有解析器相关测试一条不得红）
Run: `npx tsc --noEmit` → 0 error
Run: 手工把 `src/core/assistant-message/__tests__` 下**全部**既有快照/解析测试跑一遍
若任一红：`git reset --hard pre-f12-checkpoint` 回到 P0–P3 可用基线，再重做。

- [ ] **Step 6: G4 综合 + 提交**

Run: `npm run test:unit -- --grep "G4 · 优先级综合"` → 全绿（断言：方言归一化开启后，S1 样本可端到端产出 `tool_use`；关闭归一化时同一输入**产不出** → 证明改动有效而非"本来就通过"）。
```bash
git add src/core/assistant-message/dialectNormalize.ts src/core/assistant-message/__tests__/dialectNormalize.test.ts \
  src/core/task/index.ts CHANGELOG.md
git commit -m "fix(assistant-message): normalize the DSML tool-call dialect before parsing"
```

---

## 7.6 复审裁定落地的追加改动（2026-10-12）

> 依据 `teaching-intervention-acceptance-and-revisions.md` **§9.6** 的三项裁定：**A / B 不改代码**（按原方案 + 登记残留），**C 必须落地**。

### T9-b（裁定 C）：恢复 `high_adoption_low_self_modification` 的升级能力

**性质**：**计划遗漏的静默能力回退** —— `notify()` 移出自增后全仓只剩 2 个 `bumpEscalation` 调用点，该规则计数**恒为 0**，在 `rulePolicy` 判定 `canEscalateToBlocking: true` 的分类下再也无法升级为阻断。

**Files:** Modify `src/core/task/student-analytics/BehaviorMonitor.ts`（`checkHighAdoptionLowSelfModificationRule` + 其调用点）；Test 追加到 `__tests__/escalationReachability.test.ts`。

**✅ 落地记录（2026-10-12）**：已随 **P0 收尾**实现，commit **`2c350a01`**。
- 签名定为 `checkHighAdoptionLowSelfModificationRule(event: StudentInteractionLog)`，计数条件复用 **`this.isAssistantCodeTurn(event)`**（与本文件另两条规则同一口径），而非布尔 `isTurn`。
- 专项 `--grep "T9-b"` **4 passing**；F1 组 **14 passing**；全量 **850 passing / 111 pending / 0 failing**；`tsc --noEmit` 0 error。
- 该修复已纳入 **G0** 的断言范围（见 §4）。

```ts
private checkHighAdoptionLowSelfModificationRule(event: StudentInteractionLog): void {
	// …原有判定（minAdoptionSamples / adoptionRate / selfModificationRate）逐字不变…
	if (
		adoptionRate >= this.options.adoptionRateThreshold &&
		selfModificationRate <= this.options.selfModificationThreshold
	) {
		// 【裁定 C】与其它两条规则同口径：命中即计数，不受提醒冷却影响。
		// ★ 必须做单位约束：本规则命中条件来自滚动窗口的聚合量，若"每次 ingest 命中即 +1"，
		//   一次提问（约 5~11 条事件）就会把阈值推满。
		if (this.isAssistantCodeTurn(event)) {
			this.bumpEscalation("high_adoption_low_self_modification")
		}
		this.notify(
			"high_adoption_low_self_modification",
			`近期建议采纳率较高（${(adoptionRate * 100).toFixed(0)}%），但自主修改偏少，建议在采纳后再做一次本地优化。`,
			adoptionRate,
			this.options.adoptionRateThreshold,
		)
	}
}
// evaluateRules 内的调用点同步改为：this.checkHighAdoptionLowSelfModificationRule(event)
```

**必测（阈值可达性；改动前必红）** —— 共 4 例，全部落在 `__tests__/escalationReachability.test.ts`：
① 采纳率高 + 自主修改少 → 逐轮计数并达阈值；② 自主修改率达标 → 不计数；
③ 采纳样本 < `minAdoptionSamples` → 不计数（边界）；④ 学生回合不计数（违规单位边界）。

```ts
it("★【T9-b】采纳率高 + 自主修改少时逐轮计数，可达阻断阈值", () => {
	const m = new BehaviorMonitor("t1", { cooldownMs: 0, escalationBlockingThreshold: 3 })
	m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
	m.ingest(ev({ eventType: "adoption_infer", adoptionStatus: "adopted" }))
	for (let i = 0; i < 3; i++) {
		m.ingest(ev({ role: "assistant", hasCode: true, hasCodeBlock: true }))
	}
	expect(m.getEscalationCount("high_adoption_low_self_modification")).to.equal(3)
	expect(m.shouldEscalateToBlocking("high_adoption_low_self_modification")).to.equal(true)
})
```

> ⚠️ 构造事件序列时必须**以 `checkHighAdoptionLowSelfModificationRule` 的真实条件为准**：`determinedAdoptions.length >= minAdoptionSamples(2)`、`assistantWithCodeCount > 0`（注意该分母用的是 `hasCode`，不是 `hasCodeBlock`）、`codeEditCount/assistantWithCodeCount <= selfModificationThreshold`。可用 `debug: true` 看 `[BehaviorMonitor][debug] adoption rule:` 行校准。**不得为了过测试而放宽规则条件。**

### 裁定 A / B：不改代码，登记为已知残留

- **A**：不采纳"学生本人编辑时计数 `−1`"——三条否决理由见 spec §9.6（解决不了根因 / 计数器须单调可断言 / 与 `blockingTriggered` 叠加后无意义）⇒ 计数语义**维持原方案**。
- **B**：接受"长期间歇编辑仍可累计到阻断"这一残留。若要消除，正确形式是 **学生本人 `code_edit` → 清零两个代码规则的 `escalationCounter`**（**不是 `−1`**）。已在 spec §9.6 登记，**本次不实施**，留给 1.0.7 之后按需决定。

### M4' 的判据补强（人工验收时必填）

M4' **必须记录"第几次索要触发阻断"**：

| 实测 | 处置 |
|---|---|
| **第 3 次**触发 | 违规单位维持现状 ✓（现状：正文含 fenced 块的助手回合，实测一次请求约 +1） |
| **第 1 或第 2 次**触发 | 该规则的违规单位改为「**每个学生回合**」（一次索要最多 +1），作为**新计划项**处理 |

### 断言归属调整（因 T9-b 前提到 P0）

- **G0**：新增专项断言 ⑦ —— `high_adoption_low_self_modification` 逐轮计数并可达阻断阈值（T9-b 已落地 `2c350a01`，其 4 例测试已在 `escalationReachability.test.ts` 中生效）。
- **G2**：仅保留一条补强 —— `high_recent_ai_dependency` 由 T9 改造后同样可达阈值（对应 F9）。

---

## 8. G-ALL 全量综合测试

> **执行两次**：**G-ALL（P0–P3）** 在 P3 之后、git 存档之前；**G-ALL'（最终）** 在 P4 之后、人工验收之前。两次都跑同一套命令与断言。


- [ ] **Step 1: 自动化全量**

| 命令 | 期望 |
|---|---|
| `npm run test:unit` | **0 failing**；passing ≥ 827 + 本次新增（逐 Task 累加，最终以实测为准） |
| `npx tsc --noEmit` | **0 error** |
| `pnpm --dir webview-ui exec tsc --noEmit` | **0 error** |
| `node esbuild.mjs` | 退出码 **0** |
| `pnpm run build:webview` | 退出码 **0** |
| 全新 `npx tsc --watch`（**并行** `npm run protos`） | **`Found 0 errors`**（回归验证 spec §2.3 的竞态修复） |

- [ ] **Step 2: 四条核心链路端到端断言**（新建 `src/core/task/student-analytics/__tests__/fullRegression.gate.test.ts`）

| 链路 | 断言 |
|---|---|
| **① 干预闭环** | 3 个含代码块回合 + 3 次 AI 落盘 → `getEscalationCount === 3` → `checkAndGenerateIntervention` 返回含「阻断模式」的文本 → `isBlockingActive() === true` |
| **② 概念护栏** | 概念模式激活 → 连续 5 次 `code_generation`（索要完整代码）→ `getConceptModeState().active` **仍为 `true`** |
| **③ 周数边界** | `buildIndexGroups()` 含 > 当前周的标题；`buildWikiSystemPrompt` 在 A/B/C 三种输入下分别产出对应档位文案；MCP `--week` 缺省仍可用 |
| **④ 文案契约** | 合法回执块 → 剥离且 `voice === "model"`；超长/含 fenced 代码/无留白 → `voice === "template"` 且 `reasons` 非空；**主题未锚定 → `ok === true`**（只记 `advisories`） |
| **反向** | 所有特性关闭（`BehaviorMonitor.setEnabled(false)` / `webSearchEnabled=false`）→ 不抛错、不注入、行为回到旧口径 |

- [ ] **Step 3: 边界矩阵（逐条勾选，缺一不可）**

| # | 边界 | 期望 |
|---|---|---|
| 1 | `escalationBlockingThreshold = 1` | 首个 `turn_message` 即升级 |
| 2 | 计数恰好 = 阈值−1 / = 阈值 | 不升级 / 升级 |
| 3 | `editor` 缺失（旧日志） | 按人工编辑处理 |
| 4 | `recentlyWrittenByClineAt` 超过窗口 | 归属回退 `"user"` |
| 5 | `category === undefined` | 概念模式**不退出** |
| 6 | 助手侧事件带 `category`（`adoption_infer`） | 概念模式**不退出** |
| 7 | 概念模式下学生本人 `code_edit` | 退出概念模式 |
| 8 | `teaching-week.json` 缺失/损坏 | 回退 `--week`，不抛错 |
| 9 | 周数同值重复切换 | 不重复注入变更通知 |
| 10 | 回执块未闭合 / 多块 / 空块 | 未闭合→按无回执降级；多块→取首剥其余；空块→降级 |
| 11 | 回执文案恰好 120 / 121 字 | 通过 / 降级 |
| 12 | `countMatches` 短词（`go`/`js`/`c#`） | 不误命中 `going`/`json` 等 |
| 13 | `apply_patch` 落盘（非 `write_to_file`） | 同样置位 `hasDeliveredKeyCode` |
| 14 | 阻断冷却到期 | `isBlockingActive()` 转 false，MCP 检索恢复 |

- [ ] **Step 4: 门禁** ❌ 任一 Step 红 → 修复后重跑 G-ALL，**不得进入人工验收**。

---

## 9. 人工验收映射（测试全绿后由用户执行）

| # | 前置 | 动作 | 期望 | 覆盖 |
|---|---|---|---|---|
| **M1'** | week=1 | 「第一周学了什么」 | 正常作答、**零干预** | F6、F9 |
| **M2'** | week=1 | 「什么是装饰器」 | **给出讲解** + 标注「这属于第 N 周」+ 当前进度内前置；不给完整实现；**零干预** | F4、F3、F9 |
| **M3'** | week=1，同对话内切到 18 | 追问「冒泡排序怎么写」 | **即时生效**，不再延续旧拒答 | F7 |
| **M4'** | 任意 | 连续 3 次「帮我写一个完整的 XXX 程序」 | **第 3 次即阻断**，横幅从 `1:00` 倒数 | F1、F2、F3 |
| **M5'** | 概念问答 | 「冒泡排序怎么写」 | 设计 + 仅交换那一行（**回归，须保持**） | — |
| **M6'** | 紧接 M5' | 「直接把完整代码给我」 | **仍不给完整实现**；日志出现 `意图翻转` 与 `demands=1` | F3 |
| **M7'** | 阻断激活中 | 发任意消息 | 被拦截并显示剩余时间；**60s 后自动恢复** | F1 |
| **M8'** | 任意 | AI 连写 3 个文件后看 `student_interactions.log` | 出现 `consecutive_code_generation`；AI 落盘事件的 `editor === "ai"`、`role === "assistant"` | F2、F11 |
| **M9'** | 任意 | 统计用户可见干预文案数 | 与 `api_conversation_history.json` 中 `<teaching_intervention` 条数**一致**（应为 **0** —— 已不进历史） | F6 |
| **M10'** | 开启联网 | 问需外部资料的问题 | 联网仅校验，结论回落教材口径 | F8 |
| **M11'** | 内容密集轮 | 触发一次真实干预 | 文案**锚定当前主题**；**看不到回执块**；日志出现 `intervention_copy` 事件 | F13 |
| **M12'** | 任意 | 构造无回执块的一轮（如纯工具调用） | **模板文案照常出现** | F13 |
| **M13'** | 同规则连续 3 次 | — | 文案措辞**不完全相同** | F13 |
| **M14'** | G-ALL 全绿 + 已存档 | 让模型复现方言回合（或直接问「第一周学了什么」） | ① **不再**出现「AI 连续 N 次没能正确调用工具」；② 聊天里看不到 `｜｜DSML｜｜` 残渣；③ 工具调用**真实执行**（检索 / 列周有结果） | F12（P4） |

---

## 10. 计划自检（写完后已执行）

| 检查 | 结果 |
|---|---|
| **Spec 覆盖** | F1–F13 全部有对应 Task（F12 为 **P4**，见 §7.5）；M1'–M14' 全部映射到 Task |
| **占位符扫描** | 无 TBD/TODO；每个 Step 含实际代码或实际命令 |
| **类型一致性** | `editor` / `hasCodeBlock` / `conceptModeState` / `ExtractedCopy` / `CopyValidation` 在定义 Task 与消费 Task 间名称一致 |
| **口径一致性** | 「违规单位 = 一个 `turn_message`」在 T1 与 G0 断言中一致；「主题锚定只记账」在 T13 与 G3 中一致 |
| **已知未覆盖** | 无 —— F12 已纳入 **P4（T12）**，并在其前插入 git 存档门禁；M1 恢复为方言归一化后的正式验收用例（M14'） |

---

## 11. P5 —— M1'–M14' 实测复核后的修复（2026-10-14 定稿）

> **前置事实**：G-ALL'（P0–P4）全量 **1048 passing / 111 pending / 0 failing**、`npx tsc --noEmit` 0 错；
> 存档点 `pre-f12-checkpoint` → `6d4c692d`；实测所用 HEAD 为 `7b12db26`。
> **证据来源**：`d:\test-work\test.txt`（手测会话全文）+ `d:\test-work\.cline-logs\student_interactions.log`（真实 JSONL）。
> **书写约定**：本文档里的尖括号一律写作 `‹ ›`，避免文本被当成标签解析。

### 11.1 实测结论总表

| 用例 | 预期 | 实测 | 判定 |
|---|---|---|---|
| **M1'**（week=1「第一周学了什么」） | 答第 1 周内容 + **零干预** | 内容正确；但落下 **2 条 `intervention_decision`**（`high_recent_ai_dependency` 与 `no_edit_streak` 各 1，均 gentle）——学生**没看到**（模型那两轮只有工具调用、没有正文） | ⚠️ **未通过**（决策发生了，只是没送达） |
| **M1**（方言回合） | 不再出现「AI 连续 N 次没能正确调用工具」 | 首轮仍出现一次（`server_name` 缺失 ⇒ 重试），之后正常完成 | ⚠️ 部分通过（F12 漏了第 5 类形态，见 11.3-C） |
| **M2'**（week=1「什么是装饰器」） | 概念讲解 + 标周次 + 不给完整实现 + 零干预 | 完全符合（`task_start.category = explanation` ⇒ 代码类规则停用） | ✅ 通过 |
| **M3'**（同对话 week1→18 追问冒泡排序） | 即时生效、检索 week ≤ 18 | 出现「教学周已切换到第 18 周」并按其口径讲解（F7 生效） | ✅ 通过 |
| **M4'**（「帮我写一个完整的 XXX 程序」） | 连续 **3 次请求** ⇒ 第 3 次阻断（横幅 `1:00` 倒数） | **1 次请求就被阻断**；该请求 12 个助手回合**全无正文** | ❌ **未通过**（见 11.3-A） |
| **M6'**（追问「直接把完整代码给我」） | 分类翻转、**仍不给完整实现**、计入升级计数 | **立刻给出完整实现**；全程零干预；`completeImplDemands` 未沉淀为任何事件 | ❌ **未通过**（见 11.3-B） |
| **M7'**（阻断激活中发消息） | 被拦截 + 显示剩余时间 + 60s 后自动恢复 | 拦截与倒计时正常；但**同一轮 D/T 被记 3 次** | ⚠️ 部分通过（见 11.3-D） |
| **M10'**（「今天北京天气」） | 联网检索作答 | 模型告知无法获取实时天气（未调用 F8 的 `web_search`）；教学后端仍无端点 ⇒ 结构性不可通过 | ⛔ 阻塞（跨仓） |
| **M11'**（week=1 直接问冒泡排序） | 指出超纲、不给完整实现 | 符合 | ✅ 通过 |
| **M12'–M13'**（文案不重复 / 措辞不重复） | 同规则连续 3 次措辞不同 | 本轮实测的干预全是 blocking 模板，**没有 F13 文案轮次被触发** | ⏸ 未覆盖 |

### 11.2 两个反例的时间线（日志原文摘要）

**M4'（task `1791978179978`，学生只发 1 条消息）**

| 时间 | 事件 |
|---|---|
| 11:42:59 | `task_start`「帮我写一个完整的冒泡排序程序」（`category: code_generation`） |
| 11:43:10 → 11:43:34 | 6 个助手回合，全部是 `use_mcp_tool`（`search_wiki`/`read_wiki_chunk`），**无正文** |
| 11:43:34.605 | `intervention_decision` `high_recent_ai_dependency` gentle（第 7 个助手回合即满足 `minTurnsForDependency: 6`） |
| 11:43:45.831 | `intervention_decision` `no_edit_streak` gentle |
| **11:43:56.370** | `intervention_decision` `no_edit_streak` **strong / blocking** ⇒ **仅一次请求即阻断** |
| 11:43:56 → 11:44:32 | 冷却期提醒：**9 对** D/T（3 簇 × 3 对），期间学生只发了 1 条「阻隔测试」 |

**M6'（task `1791977948882`，`turnIndex` 多次从 0 重启 ⇒ 实例被重建）**

| 时间 | 事件 |
|---|---|
| 11:39:08 | `task_start`「冒泡排序怎么写」（`algorithm`）→ 11:39:34/41 **未给完整实现**（护栏生效） |
| 11:40:13 → 11:40:22 | 周数切到 18 后追问 → 仍只给原理 + 关键片段 ✅ |
| 11:41:45 | 「直接把完整代码给我」——**`turnIndex` 回到 0**（新实例）→ **直接给完整实现**，无干预 |
| 11:46:29 / 11:47:06 / 11:47:29 | 「那选择排序呢 / 那插入排序呢 / 希尔排序呢」→ **每次都给完整实现**；仅 `high_adoption_low_self_modification` 提示 1 次（`NEVER_BLOCKING`） |

### 11.3 根因（均给出代码行号）

#### A. `no_edit_streak` 的计数单位是「回合」而不是「请求」（M4' 失败）

1. `BehaviorMonitor.updateRealtimeStreaks()`（`BehaviorMonitor.ts:196-215`）：`turn_message` **不分角色**都 `turnsSinceLastEdit++`；只有**学生本人 `code_edit`** 才归零。
2. `checkNoEditStreakRule()`（`:278-298`）：越过阈值后**每个回合**都 `bumpEscalation("no_edit_streak")`；F1 已把 bump 与 `notify()` 的 120s 冷却**解耦**，并把阻断阈值由 6 降到 3。
3. ⇒「一次 12 回合的请求」= 3 次违规 = 阻断。日志实证：`:43:34` 提示 → `:43:45` 提示 → `:43:56` **阻断**。

#### B. 追问丢失全部干预状态（M6'/M11' 失败）

| 子因 | 证据 |
|---|---|
| **B1 状态按 `Task` 实例存放** | `index.ts:1044-1072`：`behaviorMonitor` / `interventionManager` 是实例字段，**没有按 taskId 的缓存**（只有阻断到期时间用了静态兜底）。日志中同一 taskId 的 `turnIndex` 多次从 0 重启 ⇒ 每次「恢复任务」都新建实例 ⇒ streak / 升级计数 / **概念护栏粘性**全部归零 |
| **B2 学生消息的 ingest 是 fire-and-forget** | `say("user_feedback") → void this.persistTurnLevelLog(...)`（`index.ts:761-762`），而 `monitorBehavior()` 在该函数 `await fs.appendFile` **之后**才执行（`:1196`）⇒ 提示词组装读概念状态（`:2428`）时本回合的 ingest 可能尚未落地 |
| **B3 概念分类下代码类规则按设计停用** | `rulePolicy.ts`：`algorithm`/`explanation` ∈ `CONCEPTUAL_CATEGORIES` ⇒ `consecutive_code_generation` / `no_edit_streak` **enabled=false**（连计数都没有）⇒「索要完整实现」在概念任务里**没有任何可计数、可升级的规则** |
| **B4 护栏只是提示词** | `buildConceptModeConstraint()` 是 prompt 级约束，模型可以不听；一旦给过一次完整实现，**对话历史自我锚定**会让它继续给（F7 对治的是同一种机制，但只覆盖了周数） |

#### C. F12 仍漏一类真实形态（M1 的 `server_name` 缺失）

- **新样本 S5**：`‹｜｜DSML｜｜ parameter name="server_name›wiki‹/server_name›`（**属性引号未闭合**，名字与值粘在一起）。
- `dialectNormalize.ts` 的 `BLOCK_RE` 要求成对引号 ⇒ 该标签整体不匹配 ⇒ 解析器只能命中后面的 `‹tool_name›` / `‹arguments›` ⇒ `use_mcp_tool` **缺 `server_name`** ⇒ UI 报
  「Cline tried to use use_mcp_tool without value for required parameter 'server_name'. Retrying...」⇒ 多耗若干回合（又反过来喂给根因 A）。

#### D. 记账重复与「注入未送达」（M9' 偏差）

| 子因 | 证据 |
|---|---|
| **D1 同一轮被记 3 次** | 冷却期出现 **9 对** D/T，而学生在冷却内只发了 1 条消息；时间戳成 3 簇 × 3 对（需插桩查清"3 次进入生成器"的具体路径） |
| **D2 注入了但没送达** | 模型回合只有工具调用、没有 text 块 ⇒ 一次性注入的提示被消费掉，且**不产生 `intervention_copy` 事件** ⇒ M9' ③ 不成立（§19.7 已登记的残留，本轮实测真实发生） |

### 11.4 M9' 对账实测（用真实日志直接算）

| 任务 | `D` | `C` | `T` | `N` | `V`（人工可见） | ①`V=C+T` | ②`D≥C+T` | ③`C+T+N≥D` |
|---|---|---|---|---|---|---|---|---|
| M1 `1791977753079` | 2 | 0 | 0 | 0 | 0 | `0=0` ✅（平凡成立） | `2≥0` ✅ | **`0≥2` ❌**（两条提示从未送达） |
| M4 `1791978179978` | 11 | 0 | 9 | 0 | ≈1~4 | **`V≠9` ❌**（重复记账，左侧偏小） | `11≥9` ✅ | **`9≥11` ❌**（两条提示未送达） |

> 三条守恒式**各自指向了真实的失败原因**（①→重复记账、③→注入未送达），说明可对账性设计本身是有效的。

### 11.5 任务清单（P5，T14–T19）

**前置（先插桩，后改代码）**：三处**只读**插桩（仅 `Logger.info`，不改行为）——
① 提示词组装处打印 `conceptState`（是否 active）与 `pendingInterventionText` 是否为空；
② `recursivelyMakeClineRequests` 打印进入次数与 `apiRequestCount`；
③ `checkAndGenerateInterventionDecision` 打印 rule/severity/是否 reminder。
手工复现 M4/M6/M7 各一次，把「3 次记账」「概念护栏是否被注入」从推断变成事实。

| Task | 内容（根因） | Files | 门禁 |
|---|---|---|---|
| **T14** | **计数单位修正**（A）：`no_edit_streak` 改为「每个学生请求最多记一次违规」（选项见 11.6） | `BehaviorMonitor.ts`（`updateRealtimeStreaks`/`checkNoEditStreakRule`）、`__tests__/escalationReachability.test.ts`、`priorityGate.p0..p2` 的相关断言 | 新增 4 例：12 回合单请求只记 1 次 / 3 次请求触发阻断 / 学生编辑归零 / 用户回合不再额外 bump；G0–G4 全绿 |
| **T15** | **状态跨实例存续 + 消除 ingest 竞态**（B1/B2）：按 taskId 缓存 monitor/manager（沿用 `globalBlockingEndsAt` 模式）；学生回合「先算后写」（先 `monitorBehavior` 再异步落盘） | `index.ts`、`BehaviorMonitor.ts`、`TeachingInterventionManager.ts` | 纯函数 + 结构断言；跨实例存续需同进程双实例（若无基建则如实标注为变更探测器） |
| **T16** | **「索要完整实现」可计数**（B3/B4）：`completeImplDemands` 落成结构化事件（新事件类型 `intent_demand`）；M6' 场景下把「完整实现请求」升格为一次可升级违规 | `ConceptModeGate.ts`、`BehaviorMonitor.ts`、`types.ts`、`index.ts` | 新增 3 例 + M6' 手工复现 |
| **T17** | **记账去重**（D1）：同一轮只落一次 D/T；冷却期提醒标 `reminder: true` 或按 `apiRequestCount` 去重 | `index.ts`、`interventionDisplay.ts`、`types.ts` | 新增 2 例 + 手工复现 M7' 对账 |
| **T18** | **F12 补形态 S5**（C）：属性引号未闭合时按「值 = 名字之后到 `›`」兜底；仍坚持**不臆造**（仅当同一行能找到该名字的闭合标记才补） | `dialectNormalize.ts`、其测试 | 新增 2 例（S5 归一化 / 不得臆造）；全量回归 |
| **T19** | **提示送达性 + M1' 零干预**（D2）：未送达的干预在下一轮**重新注入**（上限 K 轮）；`high_recent_ai_dependency` 在单次请求内即触发与 T14 属同一类单位问题，一并裁定 | `index.ts`、`BehaviorMonitor.ts`、`rulePolicy.ts` | 新增 3 例 |

**建议顺序**：插桩 → T14 → T19 → T15 → T17 → T16 → T18 → G5 全量 → 重跑 M1'–M14'。

### 11.6 计数单位：三个选项（**需用户裁定**）

| 选项 | 定义 | 一次 12 回合的请求 | M4' 的「连续 3 次请求」 | 成本 / 风险 |
|---|---|---|---|---|
| **A（推荐）** | `turnsSinceLastEdit` 只在**学生回合** +1（学生 `code_edit` 时归零）；阈值 8 的语义变为「连续 8 次提问」 | 记 **1** 次 | 需重新定标阈值（当前 8 次提问偏长，与"及时干预"相悖） | 语义最清晰；但要同步改文案与阈值 |
| **B（最小改动）** | 保持按回合计数，但 **bump 后归零**（或记 `lastBumpedStreak`），使每个「8 回合窗口」只记 1 次 | 记 **1** 次 | 需 3×8=24 回合 ≈ 2–3 次请求 | 改动面最小、回归风险最低；但「轮」的含义仍是回合，与文案直觉不符 |
| **C**（「纯工具调用不计」） | 只在「有学生可见正文」的回合计数 | 1–2 次 | 仍不确定 | **不推荐**（理由见 11.7） |

### 11.7 「调用 DSML 工具时不要计数」—— 为什么不建议这样做

1. **指标层看不到方言**：`StudentInteractionLog` 只有 `hasCodeBlock` / `toolsUsed` / `rawContent`，**没有方言字段**。若按「是不是 DSML」豁免，就得在**指标层嗅探原始文本**，与 F12「方言只属于感知层」的分层直接冲突。
2. **会造出一个黑洞**：豁免之后，模型只要**一直以方言形式调工具**，学生就永远不会被计数 ⇒ 干预机制可被"格式化输出"绕过。
3. **方向对、对象错**：`no_edit_streak` 度量的是**学生行为**（有没有动手改代码），而**一次请求内的所有回合，学生都没有机会动手** ⇒ 它天然应当按「**请求**」计数，而不是按「回合」或「是否方言」。这正对应 11.6 的选项 A。
4. **多回合不是 DSML 造成的**（见 11.8），所以修 DSML 也解决不了 M4'。

### 11.8 为什么一次提问会产出 12 个助手回合？

- **回合 = 一次 API 往返**。Cline 的工具循环是「模型请求 → 执行工具 → 把结果回灌 → 再请模型」，**每次工具调用天然多一个回合**。
  日志实证（task `1791978179978`）：10 次 `use_mcp_tool`（`search_wiki`×6 + `read_wiki_chunk`×4）+ 若干次重试 ⇒ 12 个回合，最后才是 `attempt_completion`；学生全程只发了 1 条消息。
- **DSML 不是主因**：F12 已让这些调用**真实解析成功**（`toolsUsed: ["use_mcp_tool"]`），回合数来自「多步检索 + 结果不满足而继续搜」。DSML 只在**畸形形态**（根因 C）上多制造了 1–2 次重试。
- ⇒ **「单请求 12 回合」是 agent 循环的正常形态**。任何按「回合」计数的**行为**指标，都必须先换算成「按请求」，否则阈值再大也会被一次长检索击穿。

### 11.9 明确不做

- 不按「是否 DSML / 是否含方言标记」豁免计数（理由见 11.7）。
- 不通过调低 `escalationBlockingThreshold` 来掩盖问题（阈值本身不是根因）。
- 不动 `src/core/prompts/**`；不改 `CHANGELOG.md` 的 `[Unreleased]` 日期行。
- M10'（联网检索）跨仓阻塞，不在本计划范围。



