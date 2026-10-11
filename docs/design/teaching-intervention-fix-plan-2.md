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
P0：T2(F2) → T1(F1) → T3(F3)         → G0  综合
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
- Modify: `src/core/task/index.ts:2308`（注入条件由 `isConceptModeCategory(category)` 改为 `monitor.getConceptModeState().active`）
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
	category: undefined as never, studentEdited: false, wantsCompleteImpl: false, ...o,
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
	it("退出后不会因后续概念提问而自动复活（需重新进入判定）", () => {
		let st = nextConceptMode(INITIAL_CONCEPT_MODE_STATE, s({ category: "algorithm" }))
		st = nextConceptMode(st, s({ category: "debugging" }))
		expect(nextConceptMode(st, s({ category: "other" })).active).to.equal(false)
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
// `isConceptModeCategory()` 仍保留给 index.ts:1128 的违规可见化使用，不删。
```

```ts
// ④ conceptModeConstraint.ts —— 在 buildConceptModeConstraint() 返回数组末尾补一条
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

	it("★ 兜底路径：即使无新警报，干预文本仍非空（P3/T13 后改为断言降级为模板文案）", () => {
		const m4 = new BehaviorMonitor("t1", { cooldownMs: 0 })
		m4.ingest(ev({})); m4.ingest(ev({})); m4.ingest(ev({}))
		const mgr4 = new TeachingInterventionManager("t1", { blockingCooldownMs: 60_000 })
		expect(mgr4.checkAndGenerateIntervention(m4, 3)).to.be.a("string").and.to.not.be.empty
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
| **G0** | P0 | ① `escalationBlockingThreshold === 3`；② AI 落盘事件带 `editor: "ai"` 且不清零 streak；③ 真人编辑清零；④ 概念模式在"索要完整代码 ×5"后 `active` 仍为 `true`；⑤ 学生本人编辑后 `active === false`；⑥ 阻断态下 `getBlockingState()` 返回 `{active: true}` |
| **G1** | P1 | ① `buildIndexGroups()` 返回**全 18 周**；② `buildWikiSystemPrompt` 三档策略命中（A/B/C 各一条）；③ 分类粘性：短消息不覆盖强分类；④ 干预文本**不进入** `apiConversationHistory`；⑤ `countMatches("排序与实现")` 词边界不误配 |
| **G2** | P2 | ① MCP 周数热读：文件改 `week=18` 后无需重启即生效；② 切换周数时 userContent 追加变更通知（仅一次）；③ `--week` 缺省仍可用（向后兼容）；④ `ai_dependency` 新指标在"1 问 6 答"下**不再**恒真触发 |
| **G3** | P3 | ① `extractInterventionCopy` 六类用例全绿；② 三条确定性校验失败 → 降级模板 + `copy_rejected`；③ 主题锚定失败 → **不降级**、只记 `copy_topic_unanchored`；④ 两条显示路径（`text` / `completion_result`）都能剥离回执块；⑤ `hasDeliveredKeyCode` 可由工具落盘置位 |

### G0 门槛（P0 完成时必须输出）

Run: `npm run test:unit -- --grep "G0 · 优先级综合"` → Expected: **全绿**
Run: `npm run test:unit` → Expected: **0 failing**（passing 数 ≥ 852）
Run: `npx tsc --noEmit` → Expected: **0 error**
❌ 任一红 → 修复后重跑，**不得进入 P1**。

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



