# 设计文档：教学周数筛选器 UI 改造（v2.9）

> 状态：**待人工审核** —— 审核通过后执行
> 日期：2026-08-23
> 范围：主工具栏（Navbar tab 栏）中的教学周数筛选器 `WikiWeekSelector`

---

## 一、现状分析

### 涉及文件

| 文件 | 角色 |
|------|------|
| `webview-ui/src/components/menu/WikiWeekSelector.tsx` | **本次唯一改动文件**——tab 栏周数筛选器 |
| `webview-ui/src/components/menu/Navbar.tsx:99` | 挂载点（`<WikiWeekSelector />`，与 tab 按钮同容器） |
| `webview-ui/src/components/ui/button.tsx` | 样式基准参照（tab 按钮用 `variant="icon"`：透明背景、无边框、`hover:opacity-80`） |
| `webview-ui/src/components/teaching/AssignmentTab.tsx:929` | 实验任务页底部的另一个周数 Select——**不在本次范围**（风格独立，互不影响） |

### 当前实现的问题（对应用户反馈）

1. **风格不统一**：容器硬编码 `background: "#ffffff"` + 1px 边框；`CalendarIcon color="#1f1f1f"`、select 文字 `color: "#1f1f1f"` 也全部硬编码深色。而 tab 栏其他按钮是**透明背景、无边框、继承主题前景色**（lucide 图标不传 color，走 `currentColor`；VS Code 深色主题下是浅色、浅色主题下是深色）。深色主题下这个筛选器形成一个刺眼的白色块。
2. **交互形态**：原生 `<select>` 下拉选择，与需求的三种新交互（箭头步进 / 滚轮 / 双击输入）不符。

### 保留的既有行为

- IPC 链路不变：变更 → `postMessage({type:"wiki_command", command:"switchWeek", week})` → 扩展端拉取 Wiki
- 初始化：挂载时 `loadHeaderState` 回填周数（`LLMWikiService.getCurrentWeek()`）
- Tooltip「学习进度（Wiki 资料周数）」保留

---

## 二、修改方案

### 1. UI 结构（去除白背景 + 颜色对齐）

```
[📅 第 5 周 ▲]      ← 结构：CalendarIcon + 文本 + 右侧上下箭头组
              [▼]
```

- **容器**：去掉 `background: "#ffffff"` 与边框 → `background: transparent`、无边框；高度对齐 tab 按钮（`h-7`，28px）；保留 `inline-flex items-center`
- **图标与文字颜色**：删除全部硬编码色值——`CalendarIcon` 不传 `color`（继承 `currentColor`，与 tab 栏图标同色）；周数文字用 `color: var(--vscode-foreground)`（显式声明主题前景色，鲁棒于后续样式隔离），字号 12 / 600 保持
- **箭头**：lucide `ChevronUp` / `ChevronDown`（14px，不传 color），各占一个可点击小热区（约 16×12px，`hover:opacity-80` 对齐 tab 按钮 hover 风格）；上下垂直排列在文字右侧
- 整体不引入边框/背景，与 tab 栏融为一体

### 2. 交互逻辑

#### ① 箭头步进（循环）
- 点击 ▼：周数 +1；**18+1 → 1**
- 点击 ▲：周数 −1；**1−1 → 18**
- 实现要点：`next = week === 18 ? 1 : week + 1`（反向同理），不用取模以避免负数分支

#### ② 滚轮步进（悬停时）
- 悬停在筛选器上滚动滚轮：**滚轮向上 = 点击 ▲（−1），滚轮向下 = 点击 ▼（+1）**，同样循环
- 实现要点：React 的 `onWheel` 在根节点是 passive 监听，`preventDefault()` 无效，悬停调节时页面会跟着滚动——因此用 `ref` + `useEffect` 挂**原生** `addEventListener("wheel", handler, { passive: false })`，handler 内 `e.preventDefault()` 阻断页面滚动，卸载时移除
- 停止悬停即失效（监听只挂在组件自身元素上，天然满足）

#### ③ 双击直接输入周数
- **双击**筛选器 → 文本切换为 `<input>`（宽约 3ch，自动 focus + 全选当前值）
- 提交：`Enter` 或 `blur`
- 取消：`Esc`（还原原周数）
- **校验**：仅接受 1~18 的整数；非法输入（非数字 / 超范围 / 空）→ **周数保持不变** + 筛选器下方内联提示「周数需在 1-18 之间」约 2 秒后自动消失（webview 内无原生通知，用内联文字，`var(--vscode-errorForeground)` 红色）
- 输入框约束 `type="text" inputMode="numeric" maxLength={2}`，仅允许数字字符（`onChange` 过滤非数字）

#### ④ IPC 派发防抖（新增，服务端保护）
现状是每变更一次立即 `switchWeek`（触发后端拉 Wiki）。滚轮连续滚动会每格都发请求，造成请求风暴。方案：
- **本地周数立即更新**（箭头/滚轮/输入反馈零延迟）
- **IPC 派发防抖 500ms**：停止操作 500ms 后只发送最终周数；期间再变更则重置计时
- 双击输入提交视为单次变更，走同一防抖通道（行为一致，代码单路径）
- 取消场景（组件卸载/防抖未触发）不发请求；`loading` 状态保留，仅作视觉反馈（派发期间文字降透明度），**不再禁用交互**（连续调节体验优先；后端以最终值拉取，无一致性风险）

### 3. 状态机小结

```
普通态 ──双击──> 编辑态(input)
   ▲   ←─Esc/提交/blur──┘
   │ 箭头/滚轮/提交(1~18)
   ▼
本地 week 立即变 ──防抖500ms──> switchWeek IPC ──> loading 至响应
```

---

## 三、边界与已知行为

| 场景 | 行为 |
|------|------|
| 滚轮连续滚 10 格 | 本地数字连续变，500ms 停止后只发 1 次请求 |
| 编辑中鼠标点别处 | blur 提交（等同 Enter） |
| 编辑中输入 25 / 0 / "abc" | 还原 + 红字提示 2s |
| 编辑中 Esc | 还原，不派发 |
| 18 ▼ / 1 ▲ | 循环到 1 / 18 |
| 防抖等待中组件卸载 | 清除定时器，不派发 |
| 与实验任务页底部周数 Select 的同步 | 维持现状（两者通过 `switchWeek`/`loadHeaderState` 各自与扩展端同步，本就不互相广播；本次不扩scope） |

## 四、待人工确认的决策点

| # | 决策点 | 建议 |
|---|--------|------|
| D1 | 滚轮方向映射：向上滚 = 减一周（与上箭头一致）| 按用户描述字面实现：滚轮方向 ↔ 箭头方向 |
| D2 | 非法输入提示形式：内联红字（2s 自动消失） | 是（webview 无法调用 VS Code 原生通知，且不打断输入流） |
| D3 | IPC 防抖 500ms | 是（保护后端；本地反馈不受影响） |

## 五、改动文件

| 文件 | 动作 |
|------|------|
| `webview-ui/src/components/menu/WikiWeekSelector.tsx` | **重写交互层**：去白背景/硬编码色 → 主题色；select → 文本+箭头；新增滚轮/双击输入/防抖 |

仅此一个文件（Navbar 挂载点、扩展端 IPC 均不变）。

## 六、验证计划

1. `cd webview-ui && npm run build` 通过
2. F5 开发模式：
   - 深色/浅色主题切换，筛选器与 tab 栏图标颜色一致、无白色块
   - ▼/▲ 步进、18↔1 循环正确
   - 悬停滚动：数字变化且**页面不跟随滚动**；连续滚动后 Network/日志仅见一次 Wiki 拉取
   - 双击输入：`5`+Enter 生效；`25`/`0`/空 → 保持 + 红字提示；Esc 还原
3. 变更后进入实验任务页确认 Wiki 已按新周数加载（现有链路回归）
