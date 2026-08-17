# 学生端 Cline 教学功能修改记录（v2.6）

> 本文档记录 `d:\cline`（Cline 3.53.1 教学 fork）在学生端的三项教学功能修改，
> 供后续维护与上架审核参考。相关代码均位于 `.ts` 源码（`*.js` 为不入库产物）。

---

## 1. 隐藏 Cline 思考链（默认隐藏，无开关）

**需求**：学生端不显示 Cline 的模型推理过程（思考链），避免学生直接看到思考内容。

**实现方式**：硬编码默认隐藏，不提供配置开关。分两层：

**① 扩展端（根因修复，最重要）**：`src/core/task/index.ts`
- 流式 `case "reasoning"`：保留 `reasonsHandler.processReasoningDelta(...)`（内部状态/API 上下文照常维护），
  但删除 `say("reasoning", thinkingBlock.thinking, ...)` 的 UI 推送。
- 流式 `case "text"`：删除 "Complete the reasoning message" 的 `say("reasoning", ...)`。
- **system prompt 教学约束**：在 `initiateTaskLoop` 中、Wiki RAG 注入之后，向 `systemPromptFinal`
  追加【教学约束】：禁止模型在正文中输出任何思考过程/思维链/推理步骤。
  （兜住"模型没有独立 reasoning 通道、把思考写进正文"的情况，如 deepseek-chat。）
- 效果：`clineMessages` 中不再存在 reasoning 消息，学生端无论界面如何都看不到思考链；
  同时 `findReasoningForApiReq` 无 reasoning 可找，"🧠 Thinking" 块也不会显示。

**② 渲染层（防御性兜底）**：
- `webview-ui/src/components/chat/chat-view/utils/messageUtils.ts`
  - `filterVisibleMessages` 中 `case "reasoning": return false`，源头过滤，
    覆盖独立 Thinking 行、工具组 tooltip、浏览器会话分组（防其他来源的 reasoning 消息）。
- `webview-ui/src/components/chat/chat-view/components/messages/MessageRenderer.tsx`
  - `reasoningData` 恒为 `{ reasoning: undefined, responseStarted: false }`。
- `webview-ui/src/components/chat/ChatRow.tsx`
  - `case "reasoning"` 返回 `<InvisibleSpacer />`（已移除 `ThinkingRow` import）。
- `ToolGroupRenderer.tsx` 的 reasoning tooltip 依赖源头过滤自动失效。

**说明**：屏蔽的是"推理内容展示"，`RequestStartRow` 的 "Thinking..." 加载占位文案仍保留（仅表示正在生成，不含思考内容）。

---

## 2. 阻隔式干预实时倒计时（顶部 tab 栏下方横幅）

**需求**：触发阻隔式干预（限制 Cline 使用 180s）后，在 Cline 顶部 tab 栏下方实时显示剩余锁定秒数，
替代原先"需再次询问后回复框才显示剩余时间"的方式。
**v2.7（跨会话）**：阻断状态提升为全局静态，学生**退出对话 / 新建对话后锁定与倒计时仍生效**，
防止"新建对话绕过 180s 锁定"。

**数据流**：

```
TeachingInterventionManager（阻断触发，记录 endsAt，并同步到全局静态 globalBlockingEndsAt）
  → Task.getBlockingState()  /  TeachingInterventionManager.getGlobalBlockingState()（静态，无需 Task）
  → Controller.getStateToPostToWebview()   // teachingBlocking = 全局 ?? 当前 Task 状态
  → sendStateUpdate(stateJson)            // Task.say() / 新建任务 / 退出对话时都会推送
  → webview ExtensionStateContext
  → TeachingBlockingBanner（本地 setInterval 每秒刷新，无需扩展端每秒推送）
```

**涉及文件**：

- `src/core/task/student-analytics/TeachingInterventionManager.ts`（阻断逻辑 `blockingCooldownMs=180_000`；
  **v2.7** 新增静态 `globalBlockingEndsAt` / `globalLastBlockingIntervention` 与 `getGlobalBlockingState()`，
  `isBlockingActive()`/`getBlockingEndsAt()` 读取全局，实例与全局取较晚者）
- `src/core/task/index.ts`（`public getBlockingState()`）
- `src/core/controller/index.ts`（`teachingBlocking` 优先用 `TeachingInterventionManager.getGlobalBlockingState()`，
  退出对话后组件依然显示）
- `src/shared/ExtensionMessage.ts`（`ExtensionState.teachingBlocking` 字段）
- `webview-ui/src/context/ExtensionStateContext.tsx`（默认 `teachingBlocking: null`）
- `webview-ui/src/components/chat/TeachingBlockingBanner.tsx`（组件）
- `webview-ui/src/components/chat/ChatView.tsx`（挂载于 `<Navbar />` 正下方）

**组件行为**：激活时显示 `⏳ 教学干预中：代码生成与工具执行已暂停 剩余 02:59`；
读取 `endsAt` 后本地 `setInterval(1000)` 递减，归零自动隐藏。

---

## 3. 学生信息持久化回填

**需求**：实验任务窗口填写的学生信息需持久化；每次进入窗口时在学生信息设置中显示已保存的信息，
无需每次重新填写。

**现状分析**：后端 `AssignmentManager` 已有持久化（`saveStudentInfo` 写入全局配置 `teaching.studentInfo`），
提交时也通过 `loadStudentInfo()` 读取；**缺** webview → 扩展端的查询通道，导致表单每次进入均为空。

**改动**：

- `src/core/teaching/AssignmentManager.ts`：新增 `loadStudentInfo` IPC 命令，返回已持久化信息（含 `logFilePath`）。
- `webview-ui/src/components/teaching/AssignmentTab.tsx`：
  - 挂载时自动 `postMessage({ command: "loadStudentInfo" })`；
  - 响应后回填 `studentId/studentName/classId/logFilePath` 表单；
  - 折叠区新增摘要 `✅ 已保存：姓名（学号 xxx，班级 xxx）`；
  - 保存成功后用 `useRef` 缓存的最新输入更新摘要（避免消息回调闭包过期）。
- `package.json`：`teaching.studentInfo` schema 补充 `logFilePath` 字段（此前 `additionalProperties:false` 会拦截）。

---

## 验证

- 扩展端：`npx tsc --noEmit -p tsconfig.json` ✅；`node esbuild.mjs` ✅
- Webview：`cd webview-ui && npm run build`（tsc -b + vite）✅

## 备注

- 源码以 `.ts` 为准（esbuild entry `src/extension.ts`，`.ts` 解析优先）；同目录 `*.js`/`*.js.map` 被 gitignore，不入库。
- 新增 `ExtensionState` 字段需同步修改：`ExtensionMessage.ts`（interface）+ `controller/index.ts`（组装）+ `ExtensionStateContext.tsx`（默认值）。
