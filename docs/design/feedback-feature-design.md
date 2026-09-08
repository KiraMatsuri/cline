# 📐 设计文档：学生端问题反馈入口 × Web 端开发者反馈收集页 全栈方案

> **版本**：v1.0
> **日期**：2026-09-08
> **作者**：架构组
> **状态**：⏳ 待审核
> **涉及仓库**：`D:\cline`（学生端插件）+ `D:\web-dashboard`（teaching-server / frontend）

---

## 一、背景与目标

学生使用学生端插件（`ShiinaMatsuri.student-teaching-assistant-edu`）过程中发现的 bug 与改进意见，目前没有任何回收渠道。目标：提供**零门槛**的反馈提交入口与**低成本**的开发者阅读管理界面。

**约束条件**：

1. 插件 Tab 栏已满（任务/答疑等），不能新增独立 Tab；
2. 反馈入口不能要求学生具备 GitHub 账号、token 等任何额外凭证；
3. 反馈数据需结构化存储，便于开发者筛选、跟踪、管理；
4. 开发者管理页面**不对普通学生暴露**（前端无入口，仅链接可达）。

**入口设计定稿**：在「教学 LLM 设置」页面（`LLMSettingsView`，独立 webview view）最底部保存按钮区之后追加"问题反馈"按钮，点击弹出悬浮窗（`ResponsiveModal`）填写并提交。

> 💡 选择 LLM 设置页的理由：该页是学生完成插件初始化的**必经页面**；且该页内已有 `ResponsiveModal` 调用示例（工具调用确认弹窗）与完整的 webview↔宿主通信链路（`testLLMConnection`），开发成本最低。

---

## 二、方案对比与选型

| 方案 | 结论 | 理由 |
|------|------|------|
| ① 同步 GitHub Issues | ❌ 否决 | 需要学生的 GitHub token（对刚接触编程的学生不友好且不安全）；多数学生无 GitHub 账号；国内校园网/热点访问 GitHub API 不稳定（已有 DPI 拦截实证） |
| ② 发送开发者邮箱 | ❌ 否决 | 需 SMTP 授权配置（阿里云 ECS 封禁 25 端口，须 SSL 465 或第三方邮件 API）；反馈内容散落在邮件流中，非结构化、无法筛选统计、不便多人协作管理；开发量反而更大 |
| ③ Web 端开发者隐藏页 | ✅ **采用** | 完全复用现有 teaching-server（Express + SQLite）与 frontend 基础设施；学生端经已配置的 `serverUrl` 直接 POST，零额外凭证；数据结构化入库，可筛选/标记/删除；与现有 assignments / wiki 模块架构完全同构 |

**已确认的产品决策**（2026-09-08）：

| 决策点 | 结论 |
|--------|------|
| 反馈形式 | 第一版**仅文本**（截图上传列入后续迭代，multer 基础设施已备） |
| 学生身份 | **可选填**学号（默认匿名，兼顾隐私与 bug 回访） |
| 管理功能 | 查看 + 标记已处理/重新打开 + 删除 |
| 隐藏页保护 | **不加鉴权**，仅靠"URL 无入口"隐藏（跟随现状：现有全部 `/api/v1/teacher/*` 端点均无鉴权，教学受控环境风险可控） |

---

## 三、总体架构

```
┌────────────────────────────────────────────────────────────────────┐
│  VS Code 插件学生端 (D:\cline)                                       │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  LLMSettingsView.tsx (webview, viewId=clineLLMSettings)     │    │
│  │  + 底部"📝 问题反馈"按钮                                      │    │
│  │  + ResponsiveModal 反馈弹窗（类型/内容/可选学号）             │    │
│  └──────────────┬─────────────────────────────────────────────┘    │
│                 │ postMessage({type:"wiki_command",                 │
│                 │             command:"submitFeedback", payload})   │
│                 ▼                                                  │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  LLMSettingsViewProvider.ts (extension host)                 │    │
│  │  case "submitFeedback":                                      │    │
│  │    附加元数据: ExtensionRegistryInfo.version + os.platform()  │    │
│  │    fetch(`${serverUrl}/api/v1/feedback`)   ← 复用_getServerUrl│    │
│  │    回包 {command, success, error} → webview 更新提交状态      │    │
│  └──────────────┬─────────────────────────────────────────────┘    │
└─────────────────┼──────────────────────────────────────────────────┘
                  │ HTTP POST JSON（学生已配置的 serverUrl）
                  ▼
┌────────────────────────────────────────────────────────────────────┐
│  teaching-server (D:\web-dashboard\teaching-server, :4001)          │
│  + 新增表 feedback（initDatabase 尾部，幂等 CREATE IF NOT EXISTS）   │
│  + POST   /api/v1/feedback                  ← 学生提交（限频）      │
│  + GET    /api/v1/teacher/feedback/list     ← 开发者列表/筛选       │
│  + PATCH  /api/v1/teacher/feedback/:id/status ← 标记已处理/重开      │
│  + DELETE /api/v1/teacher/feedback/:id      ← 删除                 │
└─────────────────┬──────────────────────────────────────────────────┘
                  │ axios（生产同源经 nginx 反代）
                  ▼
┌────────────────────────────────────────────────────────────────────┐
│  Web 前端 (D:\web-dashboard\frontend)                               │
│  App.jsx: 挂载读 location.hash → "#/dev-feedback" 切换隐藏视图       │
│           NavBar 不加按钮（无入口）                                  │
│  DevFeedbackPage.tsx: antd Table 筛选/标记/删除                      │
└────────────────────────────────────────────────────────────────────┘
```

---

## 四、数据库设计

在 `server.ts` 的 `initDatabase()` 尾部（console.log 汇总之前）新增，与现有 8 张表同模式，幂等安全：

```sql
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,              -- 'bug' | 'feature' | 'other'
  content TEXT NOT NULL,               -- 反馈正文，1~5000 字符
  student_id TEXT,                     -- 学号，可选（匿名则 NULL）
  extension_version TEXT,              -- 插件端自动附加（ExtensionRegistryInfo.version）
  platform TEXT,                       -- 插件端自动附加（os.platform() + " " + os.release()）
  status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved'
  created_at DATETIME DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);
```

**设计要点**：

- `extension_version` + `platform` 由插件宿主侧自动附加，用于复现问题（不同插件版本/操作系统表现可能不同），**不收集任何其他个人数据**；
- `student_id` 可空：匿名反馈优先，学生自愿留学号便于回访；
- 无外键关联（独立于 assignments 体系，反馈可能在任何页面产生）。

---

## 五、API 设计（teaching-server）

完全模仿现有 `POST /api/v1/submissions` 端点模式（校验 → db 操作 → 统一响应）。

### 5.1 学生提交 `POST /api/v1/feedback`

请求体：

```json
{ "category": "bug", "content": "上传附件后文件名显示乱码…", "studentId": "2023001" }
```

处理逻辑：

| 步骤 | 说明 |
|------|------|
| 参数校验 | `category` ∈ {bug, feature, other}（400）；`content` trim 后 1~5000 字符（400）；`studentId` 可选，≤50 字符 |
| 限频 | 极简内存限频：每 IP 60 秒内最多 3 条（防误触连击），超限返回 **429**；进程内存 Map 实现，重启即清零，教学规模足够 |
| 入库 | `INSERT INTO feedback(category, content, student_id, extension_version, platform)` |
| 响应 | `201 { ok: true, message: "反馈已提交，感谢你的支持！", data: { id } }` |

### 5.2 开发者列表 `GET /api/v1/teacher/feedback/list`

- Query：`?status=open|resolved&category=bug|feature|other`（均可选）
- 排序 `created_at DESC`，**全量返回不分页**（单班教学规模，量级 < 千条）
- 响应：`{ ok: true, count, data: Feedback[] }`

### 5.3 状态切换 `PATCH /api/v1/teacher/feedback/:id/status`

- 请求体 `{ "status": "open" | "resolved" }`（非法值 400；id 不存在 404）
- 响应：`{ ok: true, message: "已标记为已处理/待处理" }`

### 5.4 删除 `DELETE /api/v1/teacher/feedback/:id`

- id 不存在返回 404；成功 `{ ok: true, message: "已删除" }`

> ⚠️ **收尾项**：同步更新 `app.listen()` 内的 console.log 端点清单（新增 4 条路由），保持启动日志完整性。

---

## 六、插件端设计（D:\cline）

> **v2.9.2 修订**：原方案 6.1-6.3（LLM 设置内 ResponsiveModal 弹窗）在设置页视口较矮时弹窗显示不全（侧栏 webview 无法越出自身边界，两个 webview 也互不隶属）。最终落地：反馈表单迁移至**编辑器区 WebviewPanel**（`FeedbackPanelProvider` 单例，`reveal()` 打开/聚焦，窗口正中），全页渲染无高度限制；LLM 设置底部按钮仅发 `openFeedback` 命令转发打开面板。提交链路（版本/平台元数据附加、`POST /api/v1/feedback`、错误处理）与原设计一致，由 `FeedbackPanelProvider._handleMessage` 承接。

### 6.1 入口按钮（`webview-ui/src/components/teaching/LLMSettingsView.tsx`）

- 位置：保存按钮区（`savedNotice` 提示区之后），新增分隔线 + "📝 问题反馈"按钮；
- 样式：复用现有 `styles.secondaryButton`（次要按钮灰底），不与"保存"主按钮抢视觉重心；
- 点击：`setFeedbackVisible(true)` 打开弹窗。

### 6.2 反馈弹窗（同文件，复用 `ResponsiveModal`）

组件树与交互：

```
ResponsiveModal（title="📝 问题反馈"）
├── 类型选择（三个可选按钮，默认 🐛 Bug 反馈）
│   ├── 🐛 Bug 反馈      → category="bug"
│   ├── 💡 功能建议      → category="feature"
│   └── 📝 其他          → category="other"
├── 反馈内容 textarea
│   ├── 必填；maxLength=5000；右下角字数统计（如 123/5000）
│   └── placeholder 引导语（"请描述遇到的问题或建议，越具体越好…"）
├── 学号输入框（选填）
│   └── placeholder："选填，便于我们回访澄清问题"
├── 提示行：提交将自动附带插件版本与操作系统信息（不收集其他数据）
├── 底部按钮区
│   ├── [取消] 关闭弹窗
│   └── [提交]（loading 态：提交中…）
└── 提交结果：成功 → 绿色提示 + 自动关闭并清空；失败 → 红色错误信息，内容保留
```

**交互细节**：

- ESC / 点击遮罩关闭时**不丢弃**已填内容（仅隐藏，再次打开仍在）；
- 空内容点提交：前端拦截红字提示，不发请求。

### 6.3 宿主侧处理（`src/hosts/vscode/LLMSettingsViewProvider.ts`）

`_handleMessage()`（L148-240 switch）新增 `case "submitFeedback"`，**完全照抄 `testLLMConnection` 链路**：

1. 从 payload 解构 `{ category, content, studentId }`（webview 已做基础校验，宿主再防御一次长度上限）；
2. 自动附加元数据：
   - 版本：`ExtensionRegistryInfo.version`（`src/registry.ts` L49-56，读自 package.json）；
   - 平台：`os.platform() + " " + os.release()`（参照现有 `ReportBugHandler` 的系统信息采集做法）；
3. 服务器地址：复用 `_getServerUrl()`（L316-324，`clineTeaching.serverUrl` → `teaching.apiBase` → `localhost:4001` 优先级链）；
4. `fetch(${serverUrl}/api/v1/feedback, { method: "POST", json body })`；
5. 回包 `postMessage({ command: "submitFeedback", success, error })`，webview 侧已有 `wiki_response` 监听分支更新提交状态。

> 📌 不在 `VscodeWebviewProvider.handleWikiCommand()` 加分支——反馈按钮仅存在于 LLM 设置 view（`clineLLMSettings`），其消息由单例 `LLMSettingsViewProvider` 独立处理，无需主侧边栏路由感知。

### 6.4 网络异常处理

学生环境存在已知的热点/校园网间歇 RST 问题（见端口地图记忆）。策略：

- 提交失败（含 ECONNRESET 等）时弹窗内红字提示"网络不稳定，提交失败，请稍后重试（可尝试切换网络）"，**已填内容保留**；
- 不做自动重试（反馈非关键路径，避免复杂度；学生手动重点即可）。

---

## 七、Web 前端隐藏页设计（D:\web-dashboard\frontend）

### 7.1 隐藏路由（`src/App.jsx`）

现有"路由"是 `useState` 视图切换（无 react-router），采用**最小改动 hash 方案**：

- 初始化：`useState(() => window.location.hash === "#/dev-feedback" ? "dev-feedback" : "dashboard")`；
- 渲染分支：`{view === "dev-feedback" && <DevFeedbackPage apiBase={TEACHING_API_BASE} />}`；
- **NavBar 不加任何按钮** → 普通使用者永远看不到入口；
- hash 不涉及服务器端路由 → Vite dev 与 nginx 生产（同源反代）天然兼容，零新依赖。

访问方式：开发者手动访问 `https://<server>/#/dev-feedback`。

### 7.2 管理页组件（新建 `src/components/DevFeedbackPage.tsx`）

参照 `WikiManagement.tsx` 的 antd 风格（Card + Table + Tag + Popconfirm + message）：

| 区域 | 内容 |
|------|------|
| 顶部筛选 | 类型 Select（全部/Bug/功能建议/其他）× 状态 Select（全部/待处理/已处理），变更即重新拉取 |
| 表格列 | 时间（`created_at`，倒序）/ 类型 Tag（🐛 bug=`red`、💡 feature=`blue`、📝 other=`default`）/ 内容（超长 ellipsis + 行展开 full text）/ 学号（空显示 `-`）/ 版本 / 平台 / 状态 Tag（open=`orange`"待处理"、resolved=`green`"已处理"）/ 操作 |
| 操作列 | 「标记已处理 / 重新打开」（按当前状态切换文案）+「删除」（Popconfirm 二次确认） |
| 数据流 | `axios.get(\`${apiBase}/api/v1/teacher/feedback/list\`, { params })`，apiBase 由 App.jsx props 下发（同 WikiManagement 模式） |

---

## 八、边界与异常场景清单

| # | 场景 | 处理 |
|---|------|------|
| 1 | 空内容提交 | 前端拦截红字提示，不发请求 |
| 2 | 内容 >5000 字 | textarea maxLength 物理截断 + 宿主侧防御性校验 |
| 3 | category 非法值 | 后端 400（插件端只有三个固定选项，此为防御） |
| 4 | 连续快速点击提交 | 后端限频 429；前端提交按钮 loading 期间禁用 |
| 5 | 服务器不可达 / 网络中断 | 弹窗红字友好提示，内容保留 |
| 6 | 学生未配置服务器（serverUrl 默认 localhost） | 提交失败同场景 5；错误信息引导检查服务器配置 |
| 7 | ESC / 遮罩关闭弹窗 | 不丢已填内容（仅隐藏） |
| 8 | 删除不存在的反馈 | 404，前端 message 提示 |
| 9 | 匿名反馈 | `student_id` 为 NULL，管理页显示 `-` |

---

## 九、实施顺序与验证计划

### 9.1 实施顺序（Phase 2 ∥ Phase 3，联调依赖 Phase 1）

```
Phase 1 teaching-server（表 + 4 端点 + 启动日志）
   ├─→ Phase 2 前端隐藏页（可与 Phase 3 并行开发）
   └─→ Phase 3 插件端（按钮 + 弹窗 + 宿主 case）
          └─→ Phase 4 联调验证
```

### 9.2 验证清单

**后端**（teaching-server dev 起服）：

- [ ] curl 提交三种 category × 匿名/带学号，均 201；sqlite 查表字段完整（version/platform 已入库）
- [ ] 空内容 400；非法 category 400；60s 内第 4 条 429
- [ ] list 筛选 status/category 正确；PATCH 状态切换生效；DELETE 后 list 减少

**前端**（dev 起服）：

- [ ] 访问 `http://localhost:5173/#/dev-feedback` 进入管理页，NavBar 无入口
- [ ] 列表渲染、筛选、行展开、标记已处理/重开、删除（Popconfirm）全部正常
- [ ] 直接访问 `/`（无 hash）行为与现状完全一致，其他视图不受影响

**插件端**（F5 调试宿主）：

- [ ] LLM 设置底部出现反馈按钮 → 弹窗打开/关闭不丢内容
- [ ] 提交成功：绿色提示 + 自动关闭；隐藏页刷新可见该条反馈
- [ ] 停掉本地 teaching-server 后提交：红字网络错误，内容保留

### 9.3 部署（另行操作）

- **web-dashboard**：tar 打包变更 → 服务器 `docker compose up -d --build teaching-server frontend`（新表 CREATE IF NOT EXISTS 幂等，存量数据无损）；
- **插件**：随 v1.0.4 攒版发布（与 [Unreleased] 已有的 apiBase 尾斜杠修复一起，网页 Update 方式，勿 Remove）。

---

## 十、范围外（明确排除）与后续迭代方向

| 项 | 说明 |
|----|------|
| 截图/附件上传 | 后续迭代；multer + `feedback_uploads` 模式已备（仿 wiki_attachments），弹窗加图片上传即可 |
| 新反馈提醒推送 | 当前需开发者主动访问隐藏页；后续可加"未处理数"角标、Server酱/邮件推送 |
| LLM 自动归类/摘要 | 反馈量大后的增强项 |
| 鉴权机制 | 全系统无鉴权为既定现状，不在本特性单独引入 |
| 入口发现性增强 | LLM 设置页配置一次后较少重访；后续可在任务页错误提示、关于页等处加轻量入口 |

---

## 附录：关键参考文件

| 仓库 | 文件 | 参考内容 |
|------|------|----------|
| cline | `webview-ui/src/components/teaching/LLMSettingsView.tsx` | 按钮挂载点（保存按钮区后）、ResponsiveModal 调用示例、postMessage 模式 |
| cline | `webview-ui/src/components/common/ResponsiveModal.tsx` | 悬浮窗组件（VS Code webview 专用定位方案） |
| cline | `src/hosts/vscode/LLMSettingsViewProvider.ts` | `_handleMessage` 加 case；`_getServerUrl()`；testLLMConnection 完整链路范本 |
| cline | `src/registry.ts` | `ExtensionRegistryInfo.version`（L49-56） |
| cline | `src/core/task/tools/handlers/ReportBugHandler.ts` | 系统信息（os.platform 等）采集参考 |
| web-dashboard | `teaching-server/src/server.ts` | submissions 端点（~L842）新端点模板；`initDatabase()`（~L316-488）；启动日志端点清单（~L2095） |
| web-dashboard | `frontend/src/App.jsx` | API_BASE 定义（L23-26）、view 状态（L137）、渲染分支（L263-272） |
| web-dashboard | `frontend/src/components/WikiManagement.tsx` | antd 管理页风格模板 |
