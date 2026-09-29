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

**可选并行**
> **F**（展示隔离）—— 独立于以上，可随时做；若采用"独立 UI 提示"方案，收益更大但改动也更大。

### 3.3 明确不做的事

- **不关闭干预功能**（`behaviorMonitorEnabled = false`）—— 那是放弃教学功能，不是修复。
- **不为止血而只调阈值**（只做 D）—— 会掩盖指标层的错误，后续更难发现同类问题。
- **不改 `student_interactions.log` 既有字段语义**（方案 A 若需要，新增字段而不是改旧字段）。

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

---

## 5. 附录：证据与复算工具

- 原始日志：`c:\Users\Kirara\Desktop\.cline-logs\student_interactions.log`（4 个任务、42 条事件）
- 复算脚本：`%TEMP%\analyze-behavior.cjs`（复现 `detectCode` 判定并打印每回合的 streak 与命中正则）
- 任务级取证：`%TEMP%\analyze-ui.cjs`（按 `say`/`ask` 类型统计 `ui_messages.json`）、`%TEMP%\analyze-history.cjs`（`api_conversation_history.json`，非 ASCII 转义输出）
- 相关设计文档：`docs/design/teaching-intervention-and-llm-wiki.md`（规则表与阈值原始定义）、`docs/design/teaching-features.md`（§1bis 工具标记与 focus chain）、`docs/design/wiki-mcp-retrieval-acceptance.md`（§7 泄漏取证方法）
