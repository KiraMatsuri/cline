# 设计文档：Onboarding 去品牌 + 移除 Cline 官方登录（v1.0.3）

> 状态：**待人工审核** —— 审核通过后执行
> 日期：2026-08-27
> 背景：v1.0.2 网页上传已由用户手动 remove。发布者已切换 ShiinaMatsuri。本方案为再次发布前的合规加固。

---

## 一、问题分析

### 现状（`webview-ui/src/components/onboarding/`）

学生首次打开扩展的 onboarding 流程存在两类风险：

**风险 ①：市场审核层（Impersonation 复发）**

| 元素 | 代码位置 | 内容 |
|------|---------|------|
| Cline 官方 Logo | `OnboardingView.tsx:380` `ClineLogoWhite` | 白色机器人商标 |
| 首屏标题 | `data-steps.ts:15` | "How will you use **Cline**?" |
| 登录按钮 | `data-steps.ts:19` | "**Login to Cline**"（action: signin） |
| 注册按钮 | `data-steps.ts` FREE/POWER 步 | "**Create my Account**"（action: signup，浏览器跳 cline.bot 注册） |
| 免费路线 | `data-steps.ts` / `data-models.ts` | FREE/POWER 选项 → 引导选模型 → 注册 Cline 账号 |

上次下架理由即 Impersonation；ID/名称虽已合规，但运行时首屏展示他人商标 + 引导注册他人账号，仍属强冒用信号。

**风险 ②：技术依赖（不可控）**

- `signin`/`signup` 走 `AccountServiceClient.accountLoginClicked` → cline.bot 官方 OAuth（上游代码内置 client id）。官方可随时封禁第三方 fork 的 client id，届时学生端登录失效
- 教学架构（teaching-server + 统一 LLM 配置）本就不需要 Cline 账号；学生的正确路径是 BYOK（自带 API Key）

**流程现状**：step 0 选类型（FREE/POWER/BYOK 三选一，FREE 默认选中）→ FREE/POWER 走选模型+注册；BYOK 直接渲染 `ApiConfigurationSection`（API 配置表单）→ step 2 "Almost there!" 等浏览器完成注册。

## 二、修改方案

### 总体思路

**砍掉 FREE/POWER 账号路线与官方登录，只保留 BYOK 配置路线，首屏去品牌。** 学生打开 → 欢迎语 → API 配置表单 → 完成。不重构 BYOK 表单本身（`ApiConfigurationSection` 是共享组件，设置页也在用，保持不动以控制风险）。

### 修改点（全部在 `onboarding/` 目录内）

#### 1. `data-steps.ts` — 文案与流程重定义

- 首屏（step 0）改为欢迎页：
  - title: `"欢迎使用学生端编程教学助手"`（替换 "How will you use Cline?"）
  - description: `"配置课程提供的 AI 服务后即可开始使用。"`（替换英文）
  - buttons: 只留 `[{ text: "开始配置", action: "next" }]`（删除 "Login to Cline"）
- 删除 `NEW_USER_TYPE.FREE/POWER` 的 STEP_CONFIG 条目与 signup/signin 相关按钮；BYOK 步按钮 "Continue" → `"完成配置"`，action 保持 `done`
- 删除 `USER_TYPE_SELECTIONS` 三选项常量
- step 2（"Almost there!" 浏览器注册等待页）整段删除——账号流程不存在了
- `NEW_USER_TYPE` 枚举仅保留 `BYOK`（保留枚举本身避免其他文件引用报错；`data-models.ts` 的 `getClineUIOnboardingGroups` 若仅服务于 FREE/POWER 选模型，连带移除引用）

#### 2. `OnboardingView.tsx` — 组件逻辑收缩

- **去 Logo**：删除 `ClineLogoWhite` 导入与渲染（line 380）；替换为简单文字标识（`</>` 字符 + 扩展名，与市场图标风格呼应），不引入新图片资源
- **删账号动作**：`handleFooterAction` 中 `signin`/`signup` 分支删除（连带 `AccountServiceClient.accountLoginClicked` 调用与 `AccountServiceClient` 导入）
- **删类型选择**：`UserTypeSelectionStep` 组件、`onUserTypeClick`、`USER_TYPE_SELECTIONS` 渲染删除；`userType` 状态固定为 `BYOK`（或直接移除状态，`OnboardingStepContent` 简化为：step 0 → 欢迎文案，step 1 → `ApiConfigurationSection`）
- **删 step 2**：spinner 等待块与相关分支删除；流程变为 0（欢迎）→ 1（BYOK 配置）→ `done` 完成
- `finishOnboarding` 中 `planModeApiProvider/actModeApiProvider: "cline"` 的模型写入仅账号路线使用，随账号路线一并移除（BYOK 完成路径本就走 `finishOnboarding(false, ...)` 不触碰 provider）
- 模型选择组件 `ModelSelection`、搜索逻辑、`getPriceRange` 等仅服务于 FREE/POWER，全部删除（约 150 行）；`data-models.ts` 中仅保留仍被引用的导出，其余清理

#### 3. 遥测（`captureOnboardingProgress`）

保留调用但 action 值改为中性的 `welcome_viewed` / `config_completed`（原 `free_user_selected` 等随路线删除）。此遥测走 Cline 的 StateService——**注意**：它同样指向 cline.bot 后端。教学版保留无害（失败静默），但若要彻底切断外部依赖可一并删除；**建议本次删除**（减少一切对 cline.bot 的运行时请求，学生端零外联）。

### 修改后流程

```
打开扩展 → [欢迎页：产品名 + 开始配置按钮]
         → [API 配置表单（ApiConfigurationSection，学生填课程 baseUrl/Key）]
         → [完成配置] → setWelcomeViewCompleted → 进入主界面
```

## 三、范围外（明确不动）

| 项 | 理由 |
|----|------|
| `ApiConfigurationSection` 表单内部 | 共享组件（设置页同用），改动风险大；其内部 provider 列表含 "Cline" 选项属设置页范畴，学生用不到即可 |
| 设置页/账户页的其他 Cline 入口 | 学生完成 onboarding 后主路径不经过；后续版本再清理 |
| `ClineAuthContext` 等账号基础设施 | 删 UI 入口后无触达路径；深删涉及面广 |

## 四、验证计划

1. `cd webview-ui && npm run build` 通过（tsc 严格检查会暴露所有残留引用）
2. 扩展端 `npx tsc --noEmit` + `node esbuild.mjs` 通过
3. F5 实测全新用户流程：首屏无 Cline Logo/文案 → 开始配置 → API 表单 → 完成 → 进入主界面；全程无浏览器跳转 cline.bot
4. 已配置过的老用户不受影响（`showWelcome` 状态已有值，不再进 onboarding）
5. 打包 v1.0.3（版本号升级）→ 网页上传 ShiinaMatsuri 发布者

## 五、改动文件清单

| 文件 | 动作 |
|------|------|
| `webview-ui/src/components/onboarding/data-steps.ts` | 重写（文案中文化 + 删账号路线） |
| `webview-ui/src/components/onboarding/OnboardingView.tsx` | 大幅收缩（删 Logo/账号动作/类型选择/模型选择/step2/遥测） |
| `webview-ui/src/components/onboarding/data-models.ts` | 清理仅服务 FREE/POWER 的导出 |
| `package.json` | version → 1.0.3 |
