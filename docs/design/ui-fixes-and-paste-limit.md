# 设计文档：UI 修复（悬浮窗自适应 + 图标）与教学限制模式（粘贴限行）

> 状态：**✅ 已实施（2026-08-23）** —— 人工审核通过，决策点按建议执行（D1 拒绝并提示 / D2 顺带修复 / D3 固定 5 行）
> 日期：2026-08-23
> 关联：`docs/design/teaching-features.md`（既有教学功能文档）
>
> **实施记录**：
> - 任务 1：ServerSettingsButton 已改用 ResponsiveModal（default import）
> - 任务 2：新增 `scripts/copy-codicons.mjs`，build/build:test 串联执行；WebviewProvider 两处 + LLMSettingsViewProvider HTML 改指构建产物；LLM 设置 HTML 同时补齐 index.css 引用（D2）
> - 任务 3：PasteLimitManager 主防线（keybinding）已实现；**兜底防线降级** —— DocumentPasteEditProvider 不在 @types/vscode@1.84 中（更高版本才稳定），按预案仅保留 keybinding 拦截
> - 消息类型：`WikiCommand` 的 saveLLMSettings 分支补 `pasteLimit?: boolean` 字段；env 增加 `TEACHING_LLM_PASTE_LIMIT` 键（未传时保留现有值）
> - 验证：tsc 0 错、esbuild 通过、webview build 通过、`vsce ls` 确认 codicon.css/ttf 进入打包清单

---

## 一、问题清单与根因分析

### 任务 1：服务器设置悬浮窗固定宽高 → 需随侧栏宽度自适应

**现状**：主侧栏 Navbar 的服务器设置按钮（`webview-ui/src/components/menu/ServerSettingsButton.tsx`）弹窗为手写内联样式 Modal：

- `modalOverlay`：`position: fixed` + flex 居中 —— 在 VS Code webview 中 fixed 参考系是宿主视口而非 webview 容器（此问题在 `ResponsiveModal.tsx` 注释中已有结论，v2.3.2 修复过同类 bug）
- `modalBox`：`minWidth: 360 / maxWidth: 480` 硬编码 —— 侧栏拖窄时撑出边界

**可复用资产**：`webview-ui/src/components/common/ResponsiveModal.tsx`（v2.3.2）已解决全部问题：
- `position: absolute` + `body { position: relative }` 锚定 webview 容器
- `ResizeObserver` + `document.documentElement.clientWidth` 测量真实容器宽度，拖拽侧栏实时重算
- `AssignmentHeader.tsx`（实验任务页）与 `LLMSettingsView.tsx` 的确认弹窗均已使用，经过实战验证

### 任务 2：部分按钮图标 UI 异常（发送/MCP/Auto-approve 等箭头与图标）

**用户报告的故障点与代码对应**：

| 故障图标 | 代码位置 | 写法 |
|---|---|---|
| 发送按钮"左箭头" | `ChatTextArea.tsx:1700` | `codicon codicon-send` |
| MCP Servers 互动按钮 | `Navbar.tsx:13`（ServersIcon） | `codicon codicon-server` |
| Manage MCP Servers 按钮 | `ServersToggleModal.tsx:65` | `codicon codicon-server` |
| Manage Cline Rules & Workflows | `ClineRulesToggleModal.tsx:453` | `codicon codicon-law` |
| Auto-approve 展开/收起箭头 | `AutoApproveBar.tsx:165` | `codicon codicon-chevron-up/down` |
| 展开栏内全部图标 | `AutoApproveModal` / `ACTION_METADATA` | `codicon codicon-*` |

**共性**：全部是 `codicon` **字体图标**（全项目共 112 处）。显示正常的图标（如服务器设置按钮的 ServerIcon）都是 lucide-react 的 **SVG 组件**——SVG 不依赖字体文件。

**根因链（已用证据闭环）**：

1. 生产模式 webview HTML 通过 `<link>` 加载扩展内 `node_modules/@vscode/codicons/dist/codicon.css`（`src/core/webview/WebviewProvider.ts` `getHtmlContent()`），字体随该 CSS 相对加载。
2. `.vscodeignore:8` 排除 `node_modules/`；第 64-65 行虽有 negate 规则（`!node_modules/@vscode/codicons/dist/codicon.css|ttf`），但 **`vsce ls` 实测 vsix 中不存在这两个文件**（父目录整体排除后子文件 negate 不生效）。
3. 备用路径也失效：`webview-ui/build/assets/index.css` 内联了 codicon 的 `@font-face`，但字体 URL 是根绝对路径 `/assets/codicon.ttf` —— 在 `vscode-webview://` origin 下解析不到（webview 的 origin 根不映射 build 目录），字体同样 404。
4. 字体加载失败 → `::before` 的私有区字符以 fallback 字体渲染 → 显示为"左箭头"/方块等异常字形。

**为什么"之前能正常跑通"**：开发模式（F5 Extension Development Host）直接从源码目录运行，`node_modules` 存在，codicon.css 可加载。**从市场安装 v1.0.1（vsix）后 node_modules 缺失**，问题才显现。

### 任务 3：教学限制模式（限制编辑器粘贴 ≤5 行）

**现状**：
- LLM 设置视图 `webview-ui/src/components/teaching/LLMSettingsView.tsx` 已有「⚙ 高级选项」Section（line 347，现含"工具调用答疑"开关）
- 设置保存链路已通：webview `saveLLMSettings` → `LLMSettingsViewProvider._handleMessage`（`src/hosts/vscode/LLMSettingsViewProvider.ts:152`）→ 写本地 env + 推后端 + `_syncVSCodeConfig()` 写 `clineTeaching.*` 全局配置
- 主侧栏侧另有同名命令入口 `VscodeWebviewProvider.ts:320`（saveLLMSettings 分支），需同步
- `package.json` 已有 `clineTeaching.*` 配置贡献点（serverUrl/llmEnableTools 等）与 keybindings 贡献点（cline.addToChat 等，可参照）

---

## 二、修改方案

### 方案 1：ServerSettingsButton 改用 ResponsiveModal

**改动文件**：`webview-ui/src/components/menu/ServerSettingsButton.tsx`

- 删除手写 `modalOverlay/modalBox` 悬浮层，表单内容（标题/输入框/提示/按钮）原样迁入 `<ResponsiveModal>`
- 复用现有按钮样式常量（btnStyle 等保留）
- `maxWidth` 传 480（容器更窄时自动收缩），行为与 AssignmentHeader 的服务器设置弹窗一致

**影响面**：仅该组件视觉行为；AssignmentHeader 的弹窗已是 ResponsiveModal，不动。

### 方案 2：codicon 资源随 webview build 打包 + HTML 引用改向

**改动点（3 处 + 1 个新脚本）**：

1. **新增拷贝脚本 `scripts/copy-codicons.mjs`**：将 `node_modules/@vscode/codicons/dist/codicon.css` 与 `codicon.ttf` 拷贝到 `webview-ui/build/assets/`（幂等，目录不存在则创建）。
2. **`webview-ui/package.json`**：`build` 脚本尾部串联执行拷贝脚本（`build:webview:test` 等同入口覆盖，dev 模式不需要）。
3. **`src/core/webview/WebviewProvider.ts`**：
   - `getHtmlContent()` 的 `codiconsUrl` 改为 `getExtensionUrl("webview-ui", "build", "assets", "codicon.css")`
   - `getHMRHtmlContent()` 同步修改
   - codicon.css 内部 `url(codicon.ttf)` 为相对路径，同目录自动解析，无需改动
4. **`src/hosts/vscode/LLMSettingsViewProvider.ts` `_getHtmlForWebview()`**：顺带补 `<link>` 引用 `index.css` 与 `codicon.css`（当前该 HTML 只加载 JS 未加载任何样式表，存在同类隐患；CSP 已允许 cspSource）。

**效果**：
- vsix 内 `webview-ui/build/assets/` 自带 codicon 字体，不再依赖 node_modules
- `.vscodeignore` 的 negate 规则可保留不动（无害）
- 112 处 codicon 图标一次性全部恢复

**验证**：`vsce package` 后 `vsce ls` 应看到 `webview-ui/build/assets/codicon.css|ttf`；开发模式与 vsix 安装模式图标均正常。

### 方案 3：教学限制模式（粘贴限行）

**配置模型**：
- `package.json` 贡献配置 `clineTeaching.pasteLimitEnabled`（boolean，默认 `false`，scope machine，描述注明"教学限制模式：编辑器单次粘贴最多 5 行"）
- 持久化走既有 `saveLLMSettings → _syncVSCodeConfig` 链路，新增字段 `pasteLimit` 同步写入该配置

**UI（`LLMSettingsView.tsx` 高级选项 Section 内）**：
- 新增 checkbox「教学限制模式：限制编辑器粘贴（单次最多 5 行）」+ 说明文字（防拷贝抄袭定位、仅影响 VS Code 编辑器内粘贴）
- `onSave` 的 postMessage payload 增加 `pasteLimit`；`loadLLMSettings` 回显读到的开关状态
- 开启时无需二次确认（与工具调用开关不同，无资源消耗影响）

**扩展端拦截（新文件 `src/core/teaching/PasteLimitManager.ts`）**，双防线：

- **主防线——键绑定拦截**（覆盖 Ctrl+V / Cmd+V）：
  - `package.json` keybindings 增加：
    ```json
    {
      "command": "cline.teachingPasteWithLimit",
      "key": "ctrl+v", "mac": "cmd+v",
      "when": "config.clineTeaching.pasteLimitEnabled && editorTextFocus && !editorReadonly"
    }
    ```
    （when 为 false 时按键自动回落 VS Code 默认粘贴，未启用零影响）
  - 命令逻辑：`vscode.env.clipboard.readText()` 读剪贴板 → 行数 ≤5：`executeCommand("editor.action.clipboardPasteAction")` 原样粘贴；>5：`showWarningMessage("教学限制模式：单次粘贴最多 5 行（本次 N 行，已拦截）")` 并中止
  - 行计数规则：按 `\r\n|\r|\n` 分段，末尾空行不计（`"abc\n"` 算 1 行）
- **兜底防线——DocumentPasteEditProvider**（覆盖右键粘贴/命令面板粘贴）：
  - `vscode.languages.registerDocumentPasteEditProvider("*", provider)`，paste 时检查 text/plain 行数，超限返回"空插入"edit 拦截 + 警告
  - 引擎 `^1.84.0`，该 API 自 1.82 起稳定；**精确签名以编译为准**，若与当前 @types/vscode 有出入，则只保留主防线（Ctrl/Cmd+V 已覆盖绝大多数输入路径），文档同步降级说明
- `src/extension.ts` `activate()` 中 `PasteLimitManager.register(context)` 注册

**同步修改**：`VscodeWebviewProvider.ts:320` 的 saveLLMSettings 分支同样接收并持久化 `pasteLimit` 字段（两入口行为一致）。

**已知局限（写入文档，供决策知悉）**：
- 软限制定位：拖放文本插入、外部编辑器粘贴、终端内粘贴不受限（教学防作弊的辅助手段，非硬管控）
- 剪贴板读取仅发生在用户主动按 Ctrl+V 时，无隐私侵入

---

## 三、待人工确认的决策点

| # | 决策点 | 建议 |
|---|--------|------|
| D1 | 粘贴超 5 行时的行为：**A. 拒绝并提示** / B. 截断仅插入前 5 行 | **A**（截断产生半截代码更易困惑） |
| D2 | 是否顺带修复 LLM 设置视图 HTML 缺样式表引用问题 | **是**（同类隐患，改动极小） |
| D3 | 5 行上限是否需要做成可配置 | 先固定 5 行（YAGNI），需要时再加设置项 |

## 四、改动文件总览

| 文件 | 动作 | 任务 |
|------|------|------|
| `webview-ui/src/components/menu/ServerSettingsButton.tsx` | 手写 Modal → ResponsiveModal | 1 |
| `scripts/copy-codicons.mjs` | 新增（拷贝 codicon 资源） | 2 |
| `webview-ui/package.json` | build 脚本串联拷贝 | 2 |
| `src/core/webview/WebviewProvider.ts` | codiconsUrl 改指 build/assets | 2 |
| `src/hosts/vscode/LLMSettingsViewProvider.ts` | HTML 补 link；saveLLMSettings 持久化 pasteLimit | 2、3 |
| `webview-ui/src/components/teaching/LLMSettingsView.tsx` | 高级选项加开关 + payload/回显 | 3 |
| `src/core/teaching/PasteLimitManager.ts` | 新增（粘贴拦截双防线） | 3 |
| `src/extension.ts` | 注册 PasteLimitManager | 3 |
| `package.json` | 配置贡献点 + command + keybinding | 3 |
| `src/hosts/vscode/VscodeWebviewProvider.ts` | saveLLMSettings 分支同步 pasteLimit | 3 |

## 五、验证计划

1. `npx tsc --noEmit -p tsconfig.json` + `node esbuild.mjs` + `cd webview-ui && npm run build` 全绿
2. F5 开发模式：拖拽侧栏宽度，服务器设置弹窗跟随收缩不溢出；发送/MCP/Auto-approve 图标正常
3. 开关教学限制模式：启用后在编辑器粘贴 3 行（放行）、6 行（拦截+警告）；关闭后 6 行正常粘贴；重载窗口后开关状态保持
4. `vsce package` 后 `vsce ls` 确认 `webview-ui/build/assets/codicon.css|ttf` 在包内；安装 vsix 验证图标与三项功能
5. 全部通过后版本号升 1.0.2 重新发布
