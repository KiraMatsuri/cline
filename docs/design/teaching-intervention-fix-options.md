# 教学干预误触发修复 — 方案对比文档

> **面向执行者**：选定方案后，再据此产出逐 Task 的实施计划（含 TDD 步骤与勾选框）。
> 本文档只做**方案对比与决策**，不含实施步骤。
>
> **Goal**：消除"学生纯提问讲解却被告知『你在连续请求代码生成』并升级为 3 分钟阻断"的误触发。
>
> **Architecture**：问题横跨 5 层（指标判定 → 规则语义 → 事件计数 → 升级参数 → 展示隔离）。各层有独立方案，可分别落地；但**只做参数层（方案 D）属于治标**。
>
> **Tech Stack**：TypeScript（VS Code 扩展宿主）、mocha + ts-node 单测、`docs/design/*.md` 设计文档约定。

## Global Constraints

- 单测命令：`npm run test:unit -- --grep "<suite>"`；全量基线 **768 passing / 111 pending / 0 failing**（不得引入失败）。
- 类型检查：`npx tsc --noEmit`（扩展侧）与 `cd webview-ui && npx tsc --noEmit` 均须 **0 错误**。
- Lint：改动文件须 **0 新增** Biome 问题（`npx biome lint --reporter=github <files>`）。
- **日志字段是外部契约**：`student_interactions.log` 的字段被 `teaching-server` 消费（`docs/design/teaching-intervention-and-llm-wiki.md`），改名/改语义须同步后端统计口径。
- 干预是**教学功能**，不是 bug：任何方案都不得把"真实的学生依赖代码生成"一起关掉。

---

## 0. 问题定性（结论先行）

### 0.1 症状

学生只问了 3 个概念性问题（"第一周需要学什么" / "如何安装python环境" / "什么是python函数装饰器"），却在约 100 秒内被升级到**阻隔式干预**（3 分钟锁定），且回复里被告知"你已经连续 N 次让我生成代码了"。

### 0.2 根因分层

| 层 | 缺陷 | 证据坐标 |
|---|---|---|
| **L1 指标层** | `hasCode` 把**工具调用标记**和**行内代码**都判成"代码" | `ContentAnalyzer.detectCode()` |
| **L2 规则层** | 指标是"AI 回复含代码"，文案却写"**学生**连续 **请求**代码生成" | `InterventionMessageGenerator.TEMPLATE_REGISTRY` |
| **L3 计数层** | `turnsSinceLastEdit` 对**每个** `turn_message` 都 +1，**助手回合也算**；一次提问膨胀成 7–11 个事件 | `BehaviorMonitor.updateRealtimeStreaks()` |
| **L4 升级层** | `cooldownMs=15s` + `escalationBlockingThreshold=4` 组合过激 | `BehaviorMonitor.DEFAULT_OPTIONS` |
| **L5 展示层** | 干预文案被模型写进 `attempt_completion` 的 `result`，混入最终学习内容 | 日志 task `1790693378616` turn11、`1790693716610` turn7 |

### 0.3 量化证据（由 `student_interactions.log` 复算）

`assistantCodeStreak` = 触发 `consecutive_code_generation` 的计数器（阈值 3）。

| 任务 | 学生提问 | streak 最终值 | 达成时机 |
|---|---|---|---|
| `1790691098981` | 第一周学了什么 | **3** | turn1、turn3 是**纯工具标记**回合 |
| `1790692089951` | 第一周学了什么 | **4** | **turn1/2/3 三个纯标记回合 → 同一次提问内即触发** |
| `1790693378616` | 3 个提问 | **6** | turn1/2/3 + turn6/7 |
| `1790693716610` | 什么是python函数装饰器 | **5** | turn1/2/3 + turn6/7 |

`hasCode=true` 的判定依据（复算所得，两类都是误判或不应计入）：

| 类别 | 命中的正则 | 实例 |
|---|---|---|
| **纯工具标记** | `codeIndicators` 第 2 条 `[{}[\]();]`（`arguments` 值为 `{}`）+ 第 5 条 `name=...` → **凑满 2 条即判真** | 4 个任务的 turn1/2/3 全部如此 |
| **行内代码** | `codeBlockPatterns` 第 2 条（**单个反引号即算**） | task `1790693378616` turn6：「资料库无法连接（`wiki_backend_unreachable`）」 |

> **关键修正**：不是"3 次提问触发阻断"，而是**1 次提问就能触发规则**（前 3 个回合都是工具回合且全部误判为含代码），**3 个提问足够攒满 4 次升级**。

### 0.4 其余两条规则同样"必然触发"

| 规则 | 阈值 | 为什么必然触发 |
|---|---|---|
| `no_edit_streak` | `turnsSinceLastEdit >= 5` | 计数器含**助手回合**，一次提问就有 7–11 个 `turn_message`；学生只是在问概念，本就不会编辑代码 |
| `high_recent_ai_dependency` | `assistantTurns/totalTurns > 0.7`，且 `>=4` 回合 | 一次提问产生 7 个助手回合、0 个用户 `turn_message`（`task_start` 不计入）→ 实测 **100%** |

确认的机制细节：
- `new BehaviorMonitor(this.taskId)`（`src/core/task/index.ts:938`）→ **按任务新建**，`escalationCounter` 随任务重置。
- 但 `blockingEndsAt` 是**全局静态**（`TeachingInterventionManager.globalBlockingEndsAt`，v2.7 跨会话设计）→ 一旦触发，**新开对话仍被阻断 3 分钟**。

### 0.5 与 wiki MCP 改造的关系

**不是改造引入的 bug，但改造显著加速了它。** 改造让每次提问的助手回合数变多，而**前几个回合恰好都是 MCP 工具调用回合** —— 在 DSML 方言下它们 100% 被判为"含代码"，于是规则在模型输出任何正文之前就已触发。

---

## 1. 改造点全景（文件级）

| 文件 | 角色 | 涉及方案 |
|---|---|---|
| `src/core/task/student-analytics/ContentAnalyzer.ts` | `hasCode` / `detectCode` 判定 | **A** |
| `src/core/task/student-analytics/BehaviorMonitor.ts` | streak 计数、规则评估、阈值 | **B / D** |
| `src/core/task/student-analytics/TaskClassifier.ts` | 学生提问分类（已存在且已产出正确分类） | **C** |
| `src/core/task/student-analytics/TeachingInterventionManager.ts` | 升级判定、阻断、注入 | **C / F** |
| `src/core/task/student-analytics/InterventionMessageGenerator.ts` | 文案模板（按 severity 三档） | **E** |
| `src/core/task/index.ts` | 事件产生点（`persistTurnLevelLog` / `persistAssistantTurnLog`）、monitor 构造 | **C / F** |
| `src/shared/storage/state-keys.ts` | `behaviorMonitorEnabled` 等开关 | D（可选） |

---

## 2. 方案清单

### 方案 A — 修正「含代码」判定

**解决的问题**：L1（指标层）。这是所有连锁反应的源头。

**改造项**

1. `ContentAnalyzer` 新增 `detectToolCallMarkup(text): boolean`
   - 命中特征（实测确认）：正文含**全角竖线 U+FF5C**；或含工具参数名成对出现（`server_name` + `tool_name`、`arguments` + `name=`）。
   - 复用 `assistantTextSanitizer` 里已确认的 U+FF5C 特征，保持两处口径一致。
2. `detectCode(text)` 改为**先剔除工具标记区段再做判定**：
   ```
   const scrubbed = stripLeakedToolCallMarkup(text)   // 或按行剔除含 U+FF5C 的行
   if (detectToolCallMarkup(text)) { /* 标记区段不参与代码判定 */ }
   ```
3. **拆分 `hasCode` 的语义**（关键）：
   - `hasCodeBlock`：含 fenced 代码块（` ```…``` `）→ 视为"AI 真的给出了代码"
   - `hasInlineCode`：仅含行内反引号 → 视为"提及"，**不计入** `assistantCodeStreak`
   - `hasCode` 保持为两者之或（不破坏 `student_interactions.log` 既有字段语义），但**streak 改用 `hasCodeBlock`**
   - 若允许改日志结构，更干净的做法是新增字段 `hasCodeBlock` 并让 `assistantCodeStreak` 只读它。
4. 新增单测：`ContentAnalyzer` 的用例覆盖——纯工具标记 → `hasCode=false`；含 fenced python → `true`；仅行内代码 → `hasCodeBlock=false`。

**优点**
- 改动集中在一个文件，**影响面最小、可测性最好**。
- 用日志可直接验证：4 个任务的 streak 预计从 `3 / 4 / 6 / 5` 降到 `0 / 1 / 1 / 1`（只剩真正的 fenced 代码块回合）。
- 对 `checkHighAdoptionLowSelfModificationRule` 也有正向收益（它也依赖 `hasCode`）。

**缺点 / 风险**
- 工具标记识别是**启发式**：模型换方言（不只 DSML）可能再漏。→ 需要定期用日志回归。
- "行内代码算不算代码"需要产品判断。本文档取"不算"，理由是学生问「list.append() 怎么用」时的行内提及不构成代码生成。
- `hasCode` 语义若变化，`teaching-server` 的历史统计会不连续（需在文档里标注口径变更点）。

**影响面 / 回归验证点**
- 需明确**顺序**：streak 应基于"模型是否产出代码"，因此剔除标记必须在 `detectCode` 内部完成，**不**依赖展示层的 `assistantTextSanitizer`（否则分析的是清洗后文本，语义漂移）。
- 回归：`scripts/analyze-student-log.ts` 的统计口径；`src/test` 下与 `ContentAnalyzer` 相关的既有用例。

---

### 方案 B — 工具回合不计入 streak

**解决的问题**：L3（计数层）。让"助手回合"不再等价于"学生轮次"。

**改造项**

1. `BehaviorMonitor.updateRealtimeStreaks(event)` 增加工具维度判断：
   - 定义 `READONLY_TOOLS = ["use_mcp_tool", "read_file", "search_files", "list_files", "list_code_definition_names"]`
   - `WRITE_TOOLS = ["write_to_file", "replace_in_file", "apply_patch", "execute_command"]`
   - 当 `role === "assistant"` 且 `toolsUsed` **命中只读集合且未命中写集合** → **既不计 `assistantCodeStreak`，也不计 `turnsSinceLastEdit`**。
2. `attempt_completion` 回合**仍需计数**（它常含真正的代码块，是"AI 生成代码"的真实信号）—— 显式排除在只读集合之外。
3. `StudentInteractionLog.toolsUsed` 已存在，无需改数据结构。
4. 新增单测：给定"检索回合 × N"序列 → `assistantCodeStreak` 与 `turnsSinceLastEdit` 均不增长；给定"写文件回合 × N" → 正常增长。

**优点**
- 语义准确：规则意图是"学生反复要代码"，而"AI 去检索/读文件"不属于该行为。
- 对 DSML 情况有**兜底**：即使方案 A 漏判，标记回合也会被工具维度挡掉。
- 不需要动 `ContentAnalyzer`。

**缺点 / 风险**
- 需要维护并同步"只读工具白名单"；新增工具（含 MCP 之外的）容易遗漏。
- 若 `attempt_completion` 的取舍判断错误，可能把真实信号一起挡掉 → 必须以单测锁定。
- **不解决** `high_recent_ai_dependency`（它用回合数比例，不读 streak）→ 需配合方案 C 或 D。

**影响面 / 回归验证点**
- 与方案 A 有**部分重叠**（都作用于 streak）；同时做时需确认不会双重豁免导致干预彻底失效。
- 回归：`no_edit_streak` 在"学生真的在写代码"时仍应正常触发（用写类工具的序列做正向用例）。

---

### 方案 C — 按任务类型分流（最对症）

**解决的问题**：L2（规则与用法不匹配）—— 表达"什么时候**应该**干预"。

**改造项**

1. 让 `BehaviorMonitor` 拿到**学生提问的分类**（`TaskClassifier.classify()` 的输出，`TaskCategory`）：
   - 在 `src/core/task/index.ts` 的 monitor 构造处（`:938`）或 `ingest` 时透传；
   - 分类只在**用户回合**更新（`persistTurnLevelLog` 里已有 `category`），助手回合沿用最近一次用户分类。
2. `evaluateRules()` 按分类决定启用集合：

   | 学生提问分类 | `consecutive_code_generation` | `no_edit_streak` | `high_recent_ai_dependency` |
   |---|---|---|---|
   | `explanation`（概念/原理问答） | **停用** | **停用** | 保留（降级为 gentle） |
   | `algorithm`（算法思路） | **停用** | 停用 | 保留 |
   | `code_generation` / `debugging` / `refactoring` / `testing` | 启用 | 启用 | 启用 |
   | `other` / `language_request` | 启用（保守） | 启用 | 启用 |

3. 明确**类型切换策略**：以"最近一次用户提问的分类"为准（动态），而不是首次分类。
4. 新增单测：`explanation` 分类下灌入"纯标记回合 + 讲解回合" → 断言 0 条 `consecutive_code_generation`；`code_generation` 分类下同序列 → 正常触发。

**优点**
- **最对症**：把产品意图（"学生在写代码时才做代码类干预"）直接编码进去。
- `TaskClassifier` **已存在且在跑**（日志里 user 回合已正确分类为 `explanation`），复用成本低。
- 从根上避免"概念提问被说成要代码"。

**缺点 / 风险**
- 需要把分类结果从 Task 层透传到 `BehaviorMonitor`（新增依赖/构造参数）。
- 依赖 `TaskClassifier` 的准确率：它是**关键词规则**，分类错误会导致干预该开不开、该关不关。建议同时保留 `high_recent_ai_dependency` 作为兜底，避免"分类错就完全无干预"。
- `explanation` 场景下若学生持续索要代码（"还是不懂，直接给我代码"），干预会被停用 → 这是**有意的取舍**，需产品确认。

**影响面 / 回归验证点**
- `TaskCategory` 类型（`student-analytics/types.ts`）需确认是否已含 `language_request` 等全部分类。
- 回归：真实"索要代码"场景必须仍然干预（用 `code_generation` 分类做正向用例）。

---

### 方案 D — 重新校准参数（止血）

**解决的问题**：L4（升级层）。**只治标。**

**改造项**（可独立或组合，均为 `BehaviorMonitor.DEFAULT_OPTIONS`）

| 参数 | 现值 | 建议 | 理由 |
|---|---|---|---|
| `cooldownMs` | `15_000` | `120_000` | 15 秒冷却让同规则几十秒内被重复计数 |
| `escalationBlockingThreshold` | `4` | `6`～`8` | 4 次太容易达到 |
| `noEditTurnStreakThreshold` | `5` | 按**用户提问数**计（见改造项 2） | 现口径含助手回合 |
| `aiDependencyThreshold` | `0.7` | `0.85`，或仅在用户回合 ≥3 时统计 | Cline 多工具循环下 0.7 恒被突破 |
| `blockingCooldownMs` | `180_000` | `60_000`～`90_000` | 3 分钟对概念问答过重 |

2. **改计数口径**：`turnsSinceLastEdit` / `high_recent_ai_dependency` 的统计单位从"`turn_message` 条数"改为"**用户提问轮次**"（仅 `role === "user"` 的 `turn_message`）。这是与方案 B 不同角度的同一问题。

**优点**
- 改动量最小（一个常量表 + 一处计数条件），可**立即止血**。
- 不需要新依赖，不需要改数据结构。

**缺点 / 风险**
- **不修指标**：`hasCode` 仍然把工具标记判成代码，规则仍会触发，只是慢一点。
- 阈值调高会让**真实**依赖行为（学生反复索要代码）的干预变迟钝。
- 基于"回合数"的阈值在多工具循环下**天然不稳定**（同一次提问的回合数取决于模型调几次工具）。

**影响面 / 回归验证点**
- 与方案 B 的"改计数口径"重叠，二者**择一**即可，不要都做。
- 回归：构造"学生连续索要代码"的序列，确认仍能在合理轮次内干预（不能因为调参变成永不触发）。

---

### 方案 E — 文案与指标对齐（成本最低，必做）

**解决的问题**：L2 的**表述部分**。不解决误触发，但消除"撒谎"。

**改造项**

1. `InterventionMessageGenerator.TEMPLATE_REGISTRY` 中 `consecutive_code_generation` 三档模板改口径：
   - 现：「**你**已经连续 {streak} 次**请求代码生成**了」
   - 改：「最近 {streak} 轮我的回复都包含代码内容」
   - 并把建议改为不与事实冲突的表述（如「先说说你的思路，我再补细节」）。
2. `no_edit_streak` 模板同理：学生本来就没在写代码，措辞应改为"如果你想动手试试…"（引导式）而非指控式。
3. 保留 `{streak}` 变量（便于日志关联），但**不再**用"你请求了…"这种主语错位的句式。
4. 无需单测（纯文案），但需人工核对三档 severity 的措辞一致性。

**优点**
- 零风险、零依赖，可与其他任何方案并行。
- 立即消除"学生被错误指控"的体验问题。

**缺点**
- 不解决误触发本身 → **必须与 A / B / C 之一同时做**，否则只是"错得好看一点"。

---

### 方案 F — 干预文案与最终答案隔离

**解决的问题**：L5（干预文案混进学习内容）。

**改造项**

1. 在 `TeachingInterventionManager` 的注入模板里，要求模型把建议放在**回复最开头**并用 `---` 与正文分隔（现状已出现 `---` 约定，可正式化）。
2. 在 `attempt_completion` 的结果处理处（`src/core/task/tools/handlers/AttemptCompletionHandler.ts` 或结果入队前）**剥离** `---` 之前的干预段。
3. 更稳的替代方案：干预文案**不进模型回复**，改为独立 UI 提示（类似 reasoning 的处理思路：`say` 一种专门类型，由 webview 单独渲染）。

**优点**
- 学生看到的最终学习内容是干净的。
- 采用 3（独立 UI 提示）时，还能顺带解决"模型把干预文案复述进后续上下文"的污染问题。

**缺点 / 风险**
- 方案 1+2 依赖模型照做 + 字符串解析，**较脆**。
- 方案 3 改动更大：需要新增 `say` 类型 / 复用现有类型 + webview 渲染分支 + 可能影响 `clineMessages` 结构与历史兼容。

**影响面 / 回归验证点**
- 回归：干预仍须**可见**（不能为了隔离把提示也弄丢了）；`filterVisibleMessages` 的过滤规则需同步。

---

### 方案 G — DSML 方言归一化（治本，需单独排期）

**解决的问题**：跨层根因。已在 `docs/design/teaching-features.md` §1bis ⑤ 与 `wiki-mcp-retrieval-acceptance.md` §7 记录为"暂缓"。

**改造项**
1. 在流式文本解析前，把模型私有方言（实测为全角竖线包围的 DSML 标记）**翻译成 Cline 自己的 XML 工具标签**。
2. 需覆盖多种方言形态（实测已见 3 种混杂：完整 DSML、部分 DSML、纯 Cline 标签）。

**优点**
- **一次解决四个问题**：① 干预误触发的前 3 个回合消失；② 模型不再白跑 3 轮；③ `mistake_limit_reached` 不再触发；④ 标记残渣不再出现（`assistantTextSanitizer` 从"事后擦"变成"不会脏"）。

**缺点 / 风险**
- 改动核心对话链路（解析 / 流式路径），**回归面最大**。
- 方言覆盖面难以穷举，需要持续用真实日志回归。
- 需要独立的回归计划（含 3 个 provider 的真实会话）。

---

## 3. 方案关系与推荐组合

### 3.1 正交性矩阵

| | A 指标 | B 工具回合 | C 分类分流 | D 参数 | E 文案 | F 隔离 | G 方言 |
|---|---|---|---|---|---|---|---|
| **解决层** | L1 | L3 | L2 | L4 | L2(表述) | L5 | 跨层根因 |
| **改动量** | 小 | 中 | 中 | **极小** | **极小** | 中 | **大** |
| **风险** | 低 | 中 | 中 | 低 | **无** | 中 | **高** |
| **能否独立发布** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 建议独立版本 |
| **可测性** | 高（单测+日志复算） | 高（单测） | 高（单测） | 中 | 无 | 中 | 低（需真实会话） |
| **与 B 重叠** | 部分（都改 streak） | — | — | 部分（计数口径） | — | — | — |

> **说明**：上表只覆盖方案 A–G。**§5（感知层重构）不属于其中任何一项** —— 它不是"修规则"，而是"重新设计规则读什么输入"，因此在阶段 5 单列。

### 3.2 推荐组合（分阶段）

**阶段 1 — 止血 + 对症（推荐先做）**
> **A + E**

- A 修掉指标（streak 预计降至 0–1），E 保证即便偶发触发也不再说假话。
- 预期效果：4 个历史任务的等价输入下，`consecutive_code_generation` **0 次触发**。
- 选择理由：改动集中、可用日志复算直接验收、不引入新依赖。

**阶段 2 — 语义修正（第二阶段）**
> **C**（并以 **B** 作为兜底）

- C 把"什么时候该干预"显式化；B 兜住 A 漏判的方言情况。
- 注意：A 与 B 对 streak 有重叠豁免，同时做需用单测确认不会导致干预彻底失效。
- D 的"计数口径"部分与 B 重叠，**择一**。

**阶段 3 — 参数微调（视效果）**
> **D**

- 只在阶段 1/2 之后仍有误触发时才做；优先做"计数口径"而不是简单调大阈值。

**阶段 4 — 治本**
> **G**（单独排期，含独立回归计划）

**阶段 5 — 感知层重构（见 §5）**
> **§5 学生意图中心**（建议排在方案 C 之后，前置条件是 C 已打通分类透传通道）

- 把规则从"读 agent 行为"改为"读学生意图"，从根上消除 agent 回合数对判定的影响。
- 它也是 `high_recent_ai_dependency` 的**根治路径之一**：
  - **D** 是局部调口径（把 `task_start` 纳入统计/换成按提问计数）
  - **§5** 是把输入整体换成"学生侧动作集"
  - 二者**选一**即可，不要都做
- 与方案 C 的关系：**C 是"按分类启用/停用现有规则"，§5 是"把规则本身改写为学生侧"** —— §5 是 C 的加强版，但可以分两步走。

**并行项（与阶段 1–5 无依赖，可随时做）**
> **F**（展示隔离）—— 若采用"独立 UI 提示"方案，收益更大但改动也更大。

### 3.3 明确不做的事

- **不关闭干预功能**（`behaviorMonitorEnabled = false`）—— 那是放弃教学功能，不是修复。
- **不为止血而只调阈值**（只做 D）—— 会掩盖指标层的错误，后续更难发现同类问题。
- **不改 `student_interactions.log` 既有字段语义**（方案 A 若需要，新增字段而不是改旧字段）。

### 3.4 方案 G 对干预问题的作用边界（易误判点）

**结论：G 有帮助，但不充分，且不应以"修干预"作为它的立项理由。**

日志提供了一组天然的对照实验 —— 两种工具格式并存，`hasCode` 判定完全分离：

| 回合特征 | `hasCode` | 实例 |
|---|---|---|
| `tools=[use_mcp_tool]`（Cline 正确格式） | **全部 false** | …98981 turn2/4/5/6/7、…89951 turn4-8、…78616 turn4/5/9/10、…16610 turn4/5 |
| `tools=[]`（DSML 标记回合） | **全部 true** | 4 个任务的 turn1/2/3 |

也就是说：**G 一旦生效，那些回合会落到"正确格式"那一列，`hasCode` 自动变 false，streak 不再被推高** —— 这是 G 的免费收益（不需要改 `ContentAnalyzer`）。

去掉 DSML 回合贡献后的 streak：

| 任务 | 现在（阈值 3） | G 之后 | 是否仍触发 |
|---|---|---|---|
| …98981 | turn1,3 (DSML) + turn8 (fenced) = **3** | turn8 = **1** | ✅ 不再触发 |
| …89951 | turn1,2,3 (DSML) + turn9 (fenced) = **4** | turn9 = **1** | ✅ 不再触发 |
| …78616 | turn1,2,3 (DSML) + turn6,7 (**行内**) + turn11 (fenced) = **6** | turn6,7,11 = **3** | ⚠️ **仍触发** |
| …16610 | turn1,2,3 (DSML) + turn6,7 (**行内**) = **5** | turn6,7 = **2** | ⚠️ 差 1 就触发 |

**G 把"4/4 任务触发"降到"约 1~2/4"**，剩余部分来自**行内代码**（单个反引号即算），**G 完全不碰这条路径**。

三条规则里只有一条受益：

| 规则 | G 的作用 | 原因 |
|---|---|---|
| `consecutive_code_generation` | ✅ 明显帮助 | 消除纯标记回合 |
| `no_edit_streak` | ❌ 几乎无帮助 | 按 `turn_message` **条数**计数；G 只把每题回合数从 7 减到约 5，**仍 ≥ 阈值 5** |
| `high_recent_ai_dependency` | ❌ **结构性免疫** | 3/4 任务里用户 `turn_message` = 0 → 比例恒 100%，与回合数无关 |

**因此**：G 应基于自身四项收益（模型不再白跑 3 轮、`mistake_limit_reached` 不再触发、标记残渣从"事后擦"变"不会脏"）单独排期；**要彻底解决干预误触发，仍然必须做 C 或 D**。
**A 与 G 不互斥**：即使以后做了 G，A 仍需要（行内代码那条路径始终存在）。

---

## 4. 验收标准（选定方案后据此写实施计划）

### 4.1 可自动验证

1. **指标层单测**：纯工具标记 → `hasCode=false`；含 fenced python 块 → `hasCodeBlock=true`；仅行内代码 → `hasCodeBlock=false`。
2. **计数层单测**：检索/只读工具回合序列 → `assistantCodeStreak` 与 `turnsSinceLastEdit` 均不增长。
3. **规则层单测**：`explanation` 分类 + 纯标记/讲解回合 → 0 条 `consecutive_code_generation`。
4. **日志复算**：把 `student_interactions.log` 的 4 个任务输入新逻辑，断言 `consecutive_code_generation` 触发次数为 0（现为 4/4 任务均触发）。
5. 全量单测 ≥ **768 passing / 0 failing**；两侧 `tsc --noEmit` 0 错误；改动文件 Biome 0 新增问题。

### 4.2 需人工验证（开发宿主）

| 用例 | 操作 | 期望 |
|---|---|---|
| 概念问答不干预 | 提问"第一周学了什么" | **全程无任何干预提示** |
| 超纲问答不干预 | week=1 提问"什么是装饰器" | 无干预；且仍正确告知周次（现有行为不得回归） |
| 真依赖仍干预 | 连续 5 次"帮我写一个 XXX 程序" | **仍触发** gentle→moderate 干预 |
| 阻断仍可达 | 持续索要完整代码 | 仍能升级到阻隔式干预（阈值内的合理轮次） |
| 最终答案干净 | 任意触发干预的对话 | `attempt_completion` 的正文中**不含**干预文案（F 方案的验收） |

### 4.3 感知层重构的验收要点（仅 §5 采纳时适用）

1. **正向**：给定"学生连续索要完整代码"的**用户侧事件**序列 → `consecutive_code_generation` 正常触发。
2. **反向**：给定"学生连续问概念"的用户侧序列 → **0 触发**。
3. **复算**：把 4 个历史任务的**用户侧事件**输入新规则，断言纯问答任务 0 触发。
4. **反向回归（关键）**：`off_topic` 分类**不得**把正常的"超纲提问"（如 week=1 问装饰器）误判为跑题 —— 这是最容易被新分类器弄错的一类。
5. **口径一致性**：`teaching-server` 的统计与新日志字段同步更新，否则会静默产生"学生行为统计突然归零"的误判。

---

## 5. 干预的感知层重构：从「agent 中心」到「学生意图中心」

> 本节回答三个问题：**当前日志记的是谁的行为？能不能改成基于"学生运用 agent 的行为"来判断与干预？这些改造对既有指标有什么影响？**
>
> 性质：这是**重新设计感知层**，不是止血修复。建议作为**独立阶段**排在方案 C 之后 —— 涉及日志 schema、分类器、四条规则重定义，以及 `teaching-server` 统计口径同步。

### 5.1 结论先行

**日志两侧都记，但四条规则几乎只读 agent 侧。当前设计确实是「以 agent 行为为主、以学生行为为辅」。**

| 规则 | 输入源 | 性质 |
|---|---|---|
| `consecutive_code_generation` | `assistant.hasCode` | **纯 agent 侧** |
| `no_edit_streak` | 全部 `turn_message` **条数** | 名义混合，实际被 agent 回合灌满 |
| `high_recent_ai_dependency` | assistant / user **条数比** | 名义混合，学生侧几乎为空 |
| `high_adoption_low_self_modification` | 采纳推断 + 学生真实编辑 | **唯一真正基于学生行为** |

### 5.2 日志产生点与判定对象

| 产生点 | eventType | role | `category` 的来源 | 判定的是什么 |
|---|---|---|---|---|
| `persistStudentInteractionLog` | **`task_start`** | user | `TaskClassifier.classify(学生输入)` | 学生**首句提问**的意图 |
| `persistTurnLevelLog` | `turn_message` | user | 同上 | 学生后续追问的意图 |
| `persistAssistantTurnLog` | `turn_message` | assistant | `TaskClassifier.classify(**AI 输出文本**)` | **AI 回复被分类成什么** |
| `CodeEditTracker` | `code_edit` / `file_save` | — | — | 学生在编辑器里的真实操作 |

> ⚠️ **易误读**：assistant 事件里的 `category` **不是"学生意图"**，而是"AI 输出文本被关键词规则分成了什么"。日志里出现 `cat=language_request` 就是这么来的（DSML 标记文本被分到"语言相关请求"）。

### 5.3 改造方案对「AI 依赖度」的影响

`high_recent_ai_dependency` = `assistantTurns / (assistantTurns + userTurns)`，统计对象**只含 `eventType === "turn_message"`**。

| 改造 | 影响 | 原因 |
|---|---|---|
| **A**（修 `hasCode`） | **零影响** | 该规则只数条数，不读 `hasCode` |
| **B**（工具回合不计 streak） | **零影响**（但有陷阱） | ⚠️ 若 B 顺手把"工具回合"从 `turn_message` 里**过滤掉**，会降低 `assistantTurns` → 反而让比例下降。**B 必须只改 streak，不动事件流** |
| **C**（按任务类型分流） | **直接影响** | 决定该规则在 `explanation` 分类下是否启用/降级 |
| **G**（方言归一化） | **几乎无影响（结构性免疫）** | 见下 |

**为什么 G 对它免疫**：分母里学生侧几乎为空 —— 因为**学生首句提问被记为 `task_start`，不是 `turn_message`**。实测 4 个任务里 **3 个一个 user `turn_message` 都没有** → 比例 = assistant/(assistant+0) = **恒为 100%**。G 只是把 assistant 从 7 减到 3，比例**仍是 100%**。唯一有 user 回合的 …78616 是 10:2 = 83%，G 后约 6:2 = 75%，仍 > 70% → **照样触发**。

→ **A / B / G 都改不动这条规则，只有 C 或 D（改计数口径）能。**

### 5.4 改造方案对「行为日志」的影响

| 改造 | 是否改日志 | 具体影响 |
|---|---|---|
| **A** | ⚠️ **改"值"** | assistant 事件的 `hasCode` 取值变少 → `teaching-server` 的"含代码回复数"口径随之变化。**建议新增 `hasCodeBlock` / `hasInlineCode` 字段，而不是改旧字段语义** |
| **B** | ❌ 不改结构 | `assistantCodeStreak` 是运行时状态，**不写入日志** |
| **C** | ⚠️ **改"结构"（可选）** | 透传分类给 monitor 不需要改日志；若顺便在 assistant 事件上标注"所属任务类型"，则是**新增字段**（对离线复算很有价值） |
| **G** | ❌ 不改结构 | 但会改变 `toolsUsed` 与 `hasCode` 的**分布**（工具回合变多且 hasCode=false） |

### 5.5 改成「学生意图中心」需要补的四件事

**已经具备的**：
- 学生侧事件**已经在记**（`task_start` + `turn_message(role=user)`），且**已经跑了意图分类**（`TaskClassifier`）
- `AdoptionStatus`（`adopted` / `rejected` / `continued`）本身就是"学生对 AI 建议的反应"，是现成的学生侧信号

**必须补的**：

1. **修计数口径**：首句提问是 `task_start`，**不进 `turn_message` 统计** → 不修这条，"学生侧"几乎是空的，任何基于学生的规则都会失效。
2. **扩展学生意图分类** —— 现有 8 类只覆盖两个半：

   | 期望的学生行为 | 现有 `TaskCategory` |
   |---|---|
   | 直接让 AI 生成代码 | ✅ `code_generation` |
   | 提问相关问题 | ✅ `explanation` / `debugging` / `algorithm` |
   | **提问不相关的问题** | ❌ **没有这一类** |
   | 获取设计思路 | ⚠️ 只能勉强用 `algorithm`，没有 `design` |

3. **新增与 `SuggestionType` 对称的学生侧维度**（例如 `RequestType`）：
   `ask_code`（要完整代码）/ `ask_concept`（问概念）/ `ask_design`（要思路）/ `ask_debug`（报错求助）/ `off_topic`（跑题）/ `revise`（追问修正）。

4. **把规则改写为吃学生侧信号**：

   | 现规则 | 改写为 | 新输入 |
   |---|---|---|
   | `consecutive_code_generation` | 学生连续 N 次**索要完整代码** | `RequestType === ask_code` |
   | `no_edit_streak` | 学生连续 N 轮**追问但无编辑、无采纳** | 学生侧计数 + `AdoptionStatus` |
   | `high_recent_ai_dependency` | 学生 N 轮里**没有任何自主动作**（无编辑/无采纳/无独立表述） | 学生侧动作集合 |
   | （新增） | `off_topic_streak`：连续 N 次提问与课程/资料无关 | `RequestType === off_topic` |

### 5.6 优缺点

**优点**
- 指控与事实对齐：不再出现"学生问装饰器却被说连续要代码"
- **对 agent 回合数不再敏感** → 天然免疫"多工具循环""换模型""换方言"
- 与 wiki MCP 改造解耦：以后**再加任何 MCP 工具都不会污染判定**
- 与产品目标一致：干预评价的是"学生怎么用 AI"，而不是"AI 输出长什么样"

**缺点 / 风险**
- **学生侧事件天然稀疏**：Cline 的形态是"一次提问 → 长时间 agent 作业"，一个任务可能只有 1–3 个学生事件。必须接受**以"提问"而不是"回合"为单位**计数并重设阈值（否则原阈值几乎不可达）
- **意图分类准确率成为关键依赖**，而 `TaskClassifier` 是**关键词规则**：
  - `off_topic`（跑题）这类**语义判断很难靠关键词做准** → 要么上 LLM 分类（加成本/延迟），要么只做成保守的弱信号
  - 分类错了会导致"该干预不干预 / 不该干预乱干预"，比现在更隐蔽
- **不能完全丢掉 agent 侧信号**：「AI 一直生成代码但学生从不编辑」依然是真实的依赖信号

### 5.7 其他 MCP 工具（如搜索工具）的影响

| 规则 | 影响 | 机制 |
|---|---|---|
| `consecutive_code_generation` | ⚠️ **可能被推高** | 搜索结果常含代码片段，AI 转述时带反引号/代码块 → `hasCode=true`（与 wiki 检索同一机制） |
| `no_edit_streak` | ⚠️ **加速触发** | 多一个工具 = 每题多几个 agent 回合 → `turnsSinceLastEdit` 更快到 5 |
| `high_recent_ai_dependency` | ⚪ **无影响** | 已饱和在 100%，再多 agent 回合也一样 |
| `high_adoption_low_self_modification` | ⚪ 无直接影响 | 读采纳与编辑 |

**这是"agent 中心"设计的直接后果**：任何新增工具都会通过"回合数"污染判定。反过来也说明 5.5 的改造不只是为了修 bug，而是让系统**对未来新增工具免疫**。

### 5.8 两个附带缺陷

**① 日志无法区分"查课程资料"和"联网搜索"。**
`inferSuggestionType` 里 `use_mcp_tool` 一律落到 `other`（`src/core/task/index.ts:1143` 的 `switch` 的 `default` 分支）。若离线分析需要区分 MCP server，得去读 `use_mcp_tool` 调用里的 `server_name` 参数 —— 目前没读。

（好消息：**工具白名单不会冲突**。`WikiMcpRegistrar` 只动 `wiki` 这一个键，`mergeWikiServerEntry` 有单测锁住"不破坏其它 server 条目"，学生自加搜索工具不会被覆盖。）

**② `disabledFeatures` 并没有在代码里强制。**
`disabledFeatures: ["code_generation", "tool_execution"]` **只被渲染成消息文本**（`⚠️ 已禁用功能: ...`），**没有任何代码据此禁用工具**。

真正的强制点只有一个 —— `src/core/task/index.ts:2888`：

```
if (interventionManager.isBlockingActive()) {
    await this.say("text", 阻断提示)
    return false        // 跳过 API 请求
}
```

含义有两层：
- ✅ **阻断期间学生发不出请求**（硬强制），所以阻断期内 MCP 检索自然不可用；**180 秒后自动恢复**，不存在"工具被永久禁用" —— 对我们刚做的 wiki 检索无持久副作用。
- ⚠️ 但"代码生成与工具执行已暂停"**只是给模型的提示**，不是代码级禁用。若模型不照做（例如它本来就连工具调用格式都吐不对），**没有任何机制兜住** —— 而横幅却向学生断言"已暂停"。这是"声明与实际能力不一致"。

### 5.9 建议

**采用混合式**：**学生意图决定"该不该干预"，agent 行为只作为"依赖程度"的佐证**。

- 纯学生侧会漏判"AI 一直给代码、学生一直不编辑"
- 纯 agent 侧就是现在这个错配

**排期建议**：作为**独立阶段**排在方案 C 之后。理由：涉及日志 schema、分类器、四条规则重定义、以及 `teaching-server` 统计口径同步，属于"重新设计感知层"，不适合与止血改动混在一起。

**验收要点**见 §4.3。

---

## 6. 教师端链路缺口（本计划范围外，仅登记）

> 这些是排查「教学干预误触发」时**顺带发现**的缺陷，与干预本身无关，**不在修复范围内**。登记在此以免被遗忘。

### 6.1 先厘清：教师端看板的数据来源

教师端前端配了**两个**后端（`web-dashboard/frontend/.env.development`）：

```
VITE_API_BASE=http://localhost:4000            ← backend：学情看板
VITE_TEACHING_API_BASE=http://localhost:4001   ← teaching-server：作业 / 资料 / 提交
```

| 路径 | 服务 | 数据来源 | 状态 |
|---|---|---|---|
| **看板路径（读）** | `backend:4000` | 读**服务端本地**的 `student_interactions.log`（JSONL） | ❌ 部署态**永远读不到数据**（见 6.2） |
| **提交路径（写）** | `teaching-server:4001` | ① `analyzeLogs(raw_behavior_logs)` → `submissions` 表；② `appendToDashboardLog(events, studentMeta)` → 看板 JSONL | ⚠️ 写的是**demo 假数据**，且写到容器内失效路径（见 6.3 / 6.6） |

> **两处“分析”要分清**：`backend` 只做看板指标（读文件）；`teaching-server` 在提交时算 `ai_dependency` 等三项指标（写 `submissions` 表 + 追加看板日志）。二者互不相通。

`backend/src/index.js` 的选择逻辑：

```js
const LOG_PATH = process.env.CLINE_LOG_PATH || resolveDefaultLogPath()
function resolveReadableLogPath() {
  if (fs.existsSync(LOG_PATH)) return { effectiveLogPath: LOG_PATH, usedFallback: false }
  if (fs.existsSync(SAMPLE_LOG_PATH)) return { effectiveLogPath: SAMPLE_LOG_PATH, usedFallback: true }
  ...
}
// resolveDefaultLogPath() => <cwd>/../../cline/.cline-logs/student_interactions.log
```

**一句话判断看板数据真假**：

```powershell
(Invoke-RestMethod http://localhost:4000/api/dashboard/summary).meta
```

看 `usedFallback`（`true` = 读的是仓库自带的 `backend/sample/student_interactions.log`）与 `logPath`。

> ℹ️ **后端并不是“静默失败”**：`meta.sourceReason` 会给出 `日志文件不存在: <路径>`。
> 但**前端从不渲染这些字段**（`web-dashboard/frontend/src` 搜 `sourceReason` / `usedFallback` / `logPath` → **0 命中**），
> 所以从使用者视角看是静默的 —— 这是**前端展示缺陷**，不是后端不报错。

> ⚠️ **看板读了 `hasCode`**（`codeGenerationRatio` / `codeEditRatio` / `selfModificationRate` 都由它派生），
> 所以 `hasCode` 的口径变更**会改看板数值**（详见 `teaching-intervention-fix-plan.md` §2.5）。

### 6.2 【缺口】部署态下看板日志“无人写入”（架构性）

⚠️ **先纠正一个常见误判**：服务器上 `backend` **不是**在读一个死路径。
`deploy/docker-compose.yml` 是显式配置 + 挂载的：

```yaml
backend:
  environment:
    CLINE_LOG_PATH: ${CLINE_LOG_PATH:-/logs/student_interactions.log}   # 可配置，非硬编码
  volumes:
    - ${LOG_DIR:-./logs}:/logs                                          # 有挂载
```

（`Dockerfile.backend` 也有 `VOLUME ["/logs"]`。）

**真正的问题：这条链路上没有任何写入方。** 学生端的 `student_interactions.log` 内容**从不离开学生机器**，
因此宿主机 `./logs/` 永远是空的 → `existsSync` 为 false → `readJsonlLogs` 返回 `[]`。

唯一可行的补救是**人工把日志文件拷进宿主机 `./logs/`**（`deploy/.env.example` 里确实写了这句），
这只能用于演示，不构成产品能力。

**“本地能通”靠的是三处写死值碰巧重合**（均指向同一个文件）：

| 环节 | 路径 |
|---|---|
| 扩展写入（`new StudentLogPersister(this.cwd)`，cwd = 工作区根） | `<工作区>/.cline-logs/student_interactions.log` |
| `backend/.env` 的 `CLINE_LOG_PATH` | `D:/cline-test/.cline-logs/student_interactions.log` |
| `teaching-server` 的 appender 默认值 | `D:/cline-test/.cline-logs/student_interactions.log` |

⇒ 仅当学生工作区恰为 `d:\cline-test` 时三条重合；**换任意新文件夹即全断**。

**本质**：**「学生端 → 服务端」在「读文件」这条路上根本没有传输通道**。
要支持异地部署，必须补一条**行为日志上传/汇聚**通道。

### 6.3 【缺口】上传路径与真实行为日志脱节

`AssignmentManager.readClineLogs()` 上传的是 `task_metadata.json`：

- 搜索根目录（`getPossibleClineLogRoots()`）只有 `CLINE_LOG_DIR` / `D:\.cline-logs` / `~/.cline-logs` /
  `%APPDATA%\Cline\.cline-logs` / `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\logs` ——
  **最后一项硬编码了上游发布 ID**，与 fork 的 `shiinamatsuri.student-teaching-assistant-edu` 不匹配
- 且真实文件的**目录结构也不同**（`<globalStorage>/tasks/<id>/` vs `<root>/tasks/<id>/`）
- 实测这些目录不存在 → 走兜底 → 上传**硬编码 demo 事件**（`source: "fallback"`）
- 即便找到了，真实 `task_metadata.json` 只有 `{files_in_context, model_usage, environment_history}` —— **没有 `events` 数组** →
`normalizeRawBehaviorLogs()` 只认“数组”或“含 `events` 的对象”，其他一律返回 `[]`。

**后果（提交返回的指标全是假的）**：兜底 demo 是 6 条固定事件，代入 `teaching-server` 的 `analyzeLogs()`：

```
assistantTurns = 2（category=code_generation 的两条）
totalTurns    = 6
ai_dependency = 2/6 → 0.33
```

⇒ 提交弹窗恒显示「**AI依赖度: 33.0%**」（`metric_gaming_score: 0.8`、`user_edit_count: 1` 同样为定值）。

> `log_file_path` **确实被服务端使用**：`server.ts` 会 `readJsonlLogFile(log_file_path)` 从**服务器磁盘**读取。
> 但传过去的是**学生机器的绝对路径字符串**（如 `D:\xxx\.cline-logs\student_interactions.log`），
> 在服务器上不存在 → `existsSync` 保护下**静默返回 `[]`**（不报错）。因此这项“补救”只在同机时生效。

> ⚠️ 补充：`AssignmentManager.handleSubmitTask()` 的 `code_snapshot` 与 `submissions` 落库是**真实的** ——
> 失真的只是**行为指标**。但该接口**不会**把 `student_interactions.log` 内容上传（只传路径）。

### 6.4 【缺口】`student_meta` 只有提交路径会写，且写的是假数据

**扩展端确实从不写** `student_meta`：`StudentLogPersister.persist()` 只是 `JSON.stringify(log)`，
而 `StudentInteractionLog` **没有** `student_meta` 字段（`src/**` 搜索零命中）。

⚠️ **但 `teaching-server` 会写** —— `appendToDashboardLog()` 给**每条经提交进来的事件**补上：

```json
{"ts":"2026-08-15T15:46:00.287Z","eventType":"task_start","role":"user","category":"other",
 "student_meta":{"student_id":"20231011","student_name":"小王","class_id":"人工智能2023","submitted_at":"..."}}
```

**实测痕迹**：`d:\cline-test\.cline-logs\student_interactions.log` 共 **550 行**，其中**仅第 545–550 行**含 `student_meta`
—— 正是那 6 条 demo 兜底事件。

⇒ 修正原先“`computeStudents()` 恒空”的结论：实际会返回 **1 个学生「小王」（假的）**，
按该姓名筛选也只会看到那 6 行 demo。真正缺的是**真实日志从未带上 `student_meta`**。

### 6.5 【缺口】`intervention_evaluation` 事件无人写入

`extractInterventionEvaluations()` 找的是 `eventType === "intervention_evaluation"`，
而扩展端的 `LogEventType` 只有 `task_start | turn_message | code_edit | file_save | adoption_infer`
⇒ `computeInterventionInsights()` 恒走空分支 → **「干预效果 / 洞察」面板恒为空**。

> 这直接关系到「干预机制是否有效」的可度量性 —— 若后续要用数据评估干预效果，必须先补上该事件的生产端。

### 6.6 【缺口】部署态：`teaching-server` 写入路径失效（**已定位到的直接根因**）

`teaching-server/src/dashboardAppender.ts` 的路径解析优先级：

```ts
export function resolveDashboardLogPath(overridePath?: string): string {
  if (overridePath && overridePath.trim()) return overridePath.trim();
  const envPath = process.env["DASHBOARD_LOG_PATH"];      // ← 注意变量名
  if (envPath && envPath.trim()) return envPath.trim();
  return "D:/cline-test/.cline-logs/student_interactions.log";   // ← 硬编码默认
}
```

但 `deploy/docker-compose.yml` 给 `teaching-server` 配的是：

```yaml
teaching-server:
  environment:
    PORT: "4001"
    NODE_ENV: production
    DATA_DIR: /app/data        # ← 就三个，没有 DASHBOARD_LOG_PATH
  volumes:
    - teaching-data:/app/data
    - ./env/teaching-server.env:/app/.env:ro   # ← 没有 /logs 挂载！
```

**两个问题叠加**：

1. **变量名不匹配**：`deploy/.env.example` 配的是 `CLINE_LOG_PATH`（那是 `backend` 用的），
   而 appender 认的是 **`DASHBOARD_LOG_PATH`** → 服务器上永远是硬编码默认值。
2. **没有共享卷**：`backend` 挂 `${LOG_DIR}:/logs`，`teaching-server` **一个都没挂** → 两者看不到彼此。

⇒ 服务器上 `D:/cline-test/...` 在 Linux 容器里是**相对路径** → 实际写到
`/app/D:/cline-test/.cline-logs/student_interactions.log`（容器内、临时、无人读、重启即失）。

**结论**：即使学生点了提交，`backend` 读的 `/logs/student_interactions.log`（宿主机 `./logs`）**永远不会被更新**。

> 另外 `deploy/.env.example` 里那句注释「学生端 Cline 提交实验时，teaching-server 会把日志追加写入 `<工作区>/.cline-logs/student_interactions.log`」
> **与代码不符**（变量名对不上 + 无共享卷），建议同步修正以免误导。

### 6.7 【已排除】`student_interactions_analysis.json` 与看板无关

排查时易误判为“看板读的是 `_analysis.json`”。**实测结论：它与看板/服务器完全无关。**

- 全仓（含 `deploy/`、含 git 历史）搜 `student_interactions_analysis` → **0 命中**
- `backend/src/index.js` 只认两个路径：`CLINE_LOG_PATH`（= `.log`）与 `sample/student_interactions.log`
- `readJsonlLogs()` 是**逐行 `JSON.parse`**（JSONL）；而 `_analysis.json` 是**缩进美化过的单体 JSON 对象**，
  按行喂进去只会得到一堆 `badLines`
- 真正作者：`d:\cline\scripts\analyze-student-log.ts`（需 `--json` 才导出）：
  ```ts
  const jsonOutputPath = logPath.replace(/\.log$/, "_analysis.json")
  ```
  ⇒ **离线 CLI 报告**，跑一次给人看的；两份现存文件 mtime 为 `2026/5/23`、`2026/5/28`，早已停更。

### 6.8 【缺口·根本】缺少「行为日志上传通道」（待修）

> 本节是 6.2–6.6 的**共同根因**。用户已确认：**先记录，后续再修**。

**提交实际发送什么**（`POST /api/v1/submissions`，`AssignmentManager.handleSubmitTask()`）：

| 字段 | 实际内容 | 真实？ | 服务端用途 |
|---|---|---|---|
| `assignment_id` | 教师端发布的 ID | ✅ | 查 `assignments` 表 |
| `student_id` / `student_name` / `class_id` | 设置面板填写 | ✅ | 落库 + 作 `student_meta` |
| **`code_snapshot`** | `activeTextEditor.document.getText()` | ✅ **唯一有信息量的真数据** | 落 `submissions.code_snapshot` |
| **`raw_behavior_logs`** | **6 条硬编码 demo** | ❌ **恒假** | `analyzeLogs()` → 3 指标；`normalizeRawBehaviorLogs()` → 追加看板 |
| **`log_file_path`** | 学生本机**绝对路径字符串** | ⚠️ 路径真、**内容不传** | 服务端读自己磁盘 → `[]` |
| `submitted_at` | 提交时刻 | ✅ | 写 `student_meta.submitted_at` |

⇒ **真实日志的全量内容从未离开学生机器。**

**为什么 `raw_behavior_logs` 必然是 demo**（实测五个搜索根目录**全部不存在**）：

| # | `getPossibleClineLogRoots()` 候选 | 实测 |
|---|---|---|
| ① | `%CLINE_LOG_DIR%` | 环境变量未设置 |
| ② | `D:\.cline-logs` | **不存在** |
| ③ | `~/.cline-logs` | **不存在** |
| ④ | `%APPDATA%\Cline\.cline-logs` | **不存在** |
| ⑤ | `%APPDATA%\Code\User\globalStorage\**saoudrizwan.claude-dev**\logs` | **不存在**（硬编码上游发布 ID） |

而真实文件在 `%APPDATA%\Code\User\globalStorage\**shiinamatsuri.student-teaching-assistant-edu**\tasks\<id>\task_metadata.json`
（实测 445 字节，顶层仅 `files_in_context, model_usage, environment_history`，**无 `events`**）。
⇒ 每次都走 `return { source: "fallback", events: [6 条] }`。

**修正方向（两步，优先级递进）**：

1. **止血（三行配置）**：给 `teaching-server` 补 `DASHBOARD_LOG_PATH: /logs/student_interactions.log` + 共享 `${LOG_DIR}:/logs` 卷 → 看板至少能收到提交事件。
   ⚠️ **但这只解决“传 demo”** —— 看板上仍只有那 6 条假事件。
2. **根本（需改代码）**：新增行为日志上传通道 —— 把 `<工作区>/.cline-logs/student_interactions.log` **内容**随提交一起 POST。
   服务端已有消费端（`readJsonlLogFile()`），只差把内容传过去（不要传路径）。

> 另：也可顺带修 `getPossibleClineLogRoots()` 把 fork 自己的 globalStorage 加进去 ——
> 但它只能修本机开发场景，**异地部署仍受“服务器读不到学生磁盘”限制**，不能替代第 2 步。

---

## 7. 附录：证据与复算工具

- 原始日志：`c:\Users\Kirara\Desktop\.cline-logs\student_interactions.log`（4 个任务、42 条事件）
- 复算脚本：`%TEMP%\analyze-behavior.cjs`（复现 `detectCode` 判定并打印每回合的 streak 与命中正则）
- 任务级取证：`%TEMP%\analyze-ui.cjs`（按 `say`/`ask` 类型统计 `ui_messages.json`）、`%TEMP%\analyze-history.cjs`（`api_conversation_history.json`，非 ASCII 转义输出）
- 相关设计文档：`docs/design/teaching-intervention-and-llm-wiki.md`（规则表与阈值原始定义）、`docs/design/teaching-features.md`（§1bis 工具标记与 focus chain）、`docs/design/wiki-mcp-retrieval-acceptance.md`（§7 泄漏取证方法）
