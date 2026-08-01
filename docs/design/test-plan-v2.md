# Wiki + LLM RAG 系统 — v2.0 测试方案

> 文档版本：v2.0
> 覆盖范围：v1.3 Wiki 资料管理 + LLM 二次清洗 + 工具调用答疑 + **v2.0 教材级 Wiki（LLM 切分 + AI 评判 + 范围划定）**
> 测试形态：手动 + curl 回归 + 端到端串联
> 关联文档：`D:\web-dashboard\docs\wiki-rag-design.md`

---

## 目录

1. [测试前置准备](#1-测试前置准备)
2. [测试 A — v1.3 资料上传与 LLM 清洗](#2-测试-a--v13-资料上传与-llm-清洗)
3. [测试 B — 插件端周数切换 + RAG 答疑](#3-测试-b--插件端周数切换--rag-答疑)
4. [测试 C — LLM 设置页（API Key 配置）](#4-测试-c--llm-设置页api-key-配置)
5. [测试 D — v2.0 教材上传与异步解析](#5-测试-d--v20-教材上传与异步解析)
6. [测试 E — v2.0 章节范围划定（手动 + AI）](#6-测试-e--v20-章节范围划定手动--ai)
7. [测试 F — 学生端拉取教材章节到 RAG](#7-测试-f--学生端拉取教材章节到-rag)
8. [测试 G — 异常与降级路径](#8-测试-g--异常与降级路径)
9. [测试 H — 纯 API 回归（curl / PowerShell）](#9-测试-h--纯-api-回归curl--powershell)
10. [验收清单](#10-验收清单)

---

## 1. 测试前置准备

### 1.1 环境检查清单

| # | 项目 | 命令 / 操作 | 期望结果 |
|---|------|------------|----------|
| 1 | Node 版本 | `node -v` | `v22.x` 或更高 |
| 2 | 后端依赖 | `cd D:\web-dashboard\teaching-server && pnpm install` | 无错误；tesseract.js / pdfjs-dist / @napi-rs/canvas 安装成功 |
| 3 | 后端启动 | `pnpm dev` | 监听 `http://localhost:4001`，无致命错误 |
| 4 | 后端健康检查 | `curl http://localhost:4001/api/health` | `{ok:true, service:"teaching-server"}` |
| 5 | Web 启动 | `cd D:\web-dashboard\frontend && pnpm dev` | 监听 `http://localhost:5173` |
| 6 | Web 数据库 | `ls teaching_system.db` | 文件存在 |
| 7 | Cline 插件构建 | `cd D:\cline && pnpm run build:webview` | `build/assets/index.js` 大小 ~6 MB |
| 8 | Cline 扩展宿主 | VS Code 按 `F5` 启动扩展开发 | 左侧栏可见 📚 LLM 设置 / 📅 周数 / 🖧 服务器 图标 |

### 1.2 LLM API Key 配置（必须）

若想测试 LLM 清洗 / 切分 / AI 评判：

1. 启动扩展后，点击左侧 **📚 LLM 设置**
2. 选择 **GPT-4o-mini (OpenAI) · 推荐**
3. 填写你的 **OpenAI API Key**（sk-...）
4. 点击 **🔌 测试连接** → 应显示 `✅ 连接成功`
5. 点击 **💾 保存**

> 无 API Key 时：所有 LLM 步骤会自动降级（资料存原始文本；教材用正则切分；AI 评判返回 null）。

### 1.3 测试数据准备

| 文件 | 用途 | 准备位置 |
|------|------|----------|
| `test-week3-loops.md` | Markdown 资料（用于测试 A） | 见下方 §2.1 |
| `test-week5-oop.docx` | Word 教材（用于测试 D） | 用 Word 创建 5 章约 30 页的 docx |
| `test-python-intro.pdf` | PDF 教材（用于测试 D，触发 OCR） | 扫描版 PDF（文字版也可） |
| `test-large-textbook.pdf` | 大教材（用于测试 D，验证异步） | ~100MB PDF |
| `test-malicious.txt` | 异常文件（用于测试 G） | 内容含 `<script>alert(1)</script>` |

---

## 2. 测试 A — v1.3 资料上传与 LLM 清洗

### 2.1 准备 `test-week3-loops.md`

```markdown
# Python for 循环与列表迭代

## 定义
for 循环用于遍历序列（列表、字符串、元组）。

## 示例代码
```python
fruits = ["apple", "banana", "cherry"]
for fruit in fruits:
    print(fruit)
```

## 常见错误
- 忘记末尾冒号 `for x in list` → 应为 `for x in list:`
- 修改正在迭代的列表（应使用副本）
```

### 2.2 测试步骤

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| A1 | 浏览器打开 `http://localhost:5173` → 点击 **📚 教学资料管理** tab | 展示 WikiManagement 页面 | ☐ |
| A2 | 资料 ID 填 `chunk_week3_loops`，标题 `Python for 循环与列表迭代`，周数选 3 | 表单无报错 | ☐ |
| A3 | Markdown 正文粘贴 §2.1 内容（约 12 行） | 字符数显示 ~300 | ☐ |
| A4 | 点击 **上传并分发资料** | 提示 "Wiki 资料已上传（N 个 chunk，LLM 清洗=成功/降级）" | ☐ |
| A5 | 表格出现新行：ID = `chunk_week3_loops`，周数 = 紫色 Tag 第 3 周，LLM 清洗 = ✅ 已清洗（绿色 Tag） | 三列信息正确 | ☐ |
| A6 | `curl http://localhost:4001/api/v1/teacher/wiki/list` | 返回 JSON 含 chunk_week3_loops | ☐ |

### 2.3 LLM 降级测试（无 API Key）

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| A7 | 删除 `~/.cline/teaching-llm.env` 与 `teaching-server/.env` | — | ☐ |
| A8 | 重启后端 + 刷新 Web 页面，再上传一份资料 | 列表中 LLM 清洗列显示 ⚠ 原始文本（黄色 Tag），hover 显示原因 | ☐ |
| A9 | `sqlite3 teaching_system.db "SELECT cleaned_by_llm, llm_clean_error FROM wiki_chunks"` | cleaned_by_llm=0，llm_clean_error 非空 | ☐ |

### 2.4 Office 文件上传测试

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| A10 | 上传一份 `.docx`（含清晰标题、代码块） | 表格显示"已清洗"（mammoth 提取 → LLM 清洗） | ☐ |
| A11 | 上传一份 `.pdf`（含 5 页 Python 教程） | 表格显示"已清洗"（pdf-parse 提取 → LLM 清洗） | ☐ |
| A12 | 上传一份扫描版 `.pdf`（无文字层） | 暂不验证（OCR 留待测试 D）；此处应正常入库"已清洗"或"原始文本"均可 | ☐ |

### 2.5 Office + Markdown 共存测试

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| A13 | 同时填写 Markdown 正文 + 上传 docx | 后端把两部分合并为一个 wiki_chunk（用 `---` 分隔） | ☐ |

---

## 3. 测试 B — 插件端周数切换 + RAG 答疑

### 3.1 周数选择器测试

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| B1 | VS Code 扩展宿主中，点击左侧 **📖 实验任务** → 顶部出现 `📅 第 1 周 ▼` | 下拉框可见，黑色字体 | ☐ |
| B2 | 切换到第 3 周 | 主进程日志显示 `已成功载入第 3 周及之前的教学资料（共 X 条）！`，弹 toast 通知 | ☐ |
| B3 | 查看开发者工具（Help → Toggle Developer Tools）控制台 | 无 error；wikiChunks 缓存有 chunk_week3_loops | ☐ |
| B4 | 切换到第 18 周 | 拉取所有累计资料（≤ 18 周），toast 显示数字 | ☐ |

### 3.2 RAG 答疑验证（buildSystemPrompt）

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| B5 | 在 Cline 主对话提问："第 1 周应该学什么？" | 答案引用 `chunk_week1_*` 内容 | ☐ |
| B6 | 切到第 3 周再问："for 循环怎么用？" | 答案引用 chunk_week3_loops 内容 | ☐ |
| B7 | **关键**：切到第 1 周再问："装饰器是什么？" | AI 应**拒绝**：提示"该知识点将在第 Y 周讲解"，不应使用高级语法 | ☐ |
| B8 | System Prompt 长度不应超过 16k 字符（超长 Wiki 自动截断） | 控制台 `Primary Context` 长度 ≤ 16000 | ☐ |

### 3.3 工具调用答疑（开启后）

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| B9 | LLM 设置页 → 开启 "启用 karpathy 式工具调用答疑"（会弹确认框，确认开启） | 开关显示为 ON | ☐ |
| B10 | 在 Cline 主对话提问："对比第 1 周和第 3 周的概念" | AI 应调用 `list_weeks` → `read_chunk` 工具，跨周对比回答 | ☐ |
| B11 | 控制台日志 | 显示 `[LLMWikiService] 工具调用模式启动` | ☐ |
| B12 | 关闭开关后再问同一问题 | 退化为一次性 buildSystemPrompt 回答（不再调用工具） | ☐ |

---

## 4. 测试 C — LLM 设置页（API Key 配置）

### 4.1 设置页基本功能

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| C1 | 扩展宿主 → 左侧 **📚 LLM 设置** | 显示设置页（非空白） | ☐ |
| C2 | 下拉切换模型：GPT-4o → Claude 3.5 Sonnet | baseUrl 自动填充到 `https://api.anthropic.com/v1` | ☐ |
| C3 | 选 "自定义" → baseUrl 输入框变为可编辑 | 可手动输入任意 URL | ☐ |
| C4 | 输入错误 API Key → 点击 **🔌 测试连接** | 显示 `❌ 连接失败：401 Unauthorized` | ☐ |
| C5 | 输入正确 API Key → 测试连接 | 显示 `✅ 连接成功` | ☐ |

### 4.2 保存配置链路

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| C6 | 点击 **💾 保存** | 显示 `✅ 已保存到本地 + 后端 .env（热加载立即生效）` | ☐ |
| C7 | 检查文件 `~/.cline/teaching-llm.env` | 含 TEACHING_LLM_API_KEY 等 5 行 | ☐ |
| C8 | 检查文件 `D:\web-dashboard\teaching-server\.env` | 含相同 5 行（API Key 已推送） | ☐ |
| C9 | 后端控制台 | 显示 `✅ .env 已更新` 与 `[llmHelper] ✅ LLM 配置已加载` | ☐ |
| C10 | **关键**：无需重启后端，再次上传资料 | 立即生效（不再降级），cleaned_by_llm=true | ☐ |

### 4.3 工具调用开关

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| C11 | 关闭状态 → 点击开关 | 弹确认框 "⚠ 启用工具调用答疑后..." | ☐ |
| C12 | 取消 | 开关保持关闭 | ☐ |
| C13 | 再次点击开关 → 确认 | 开关变 ON，VS Code 配置 `clineTeaching.llmEnableTools=true` | ☐ |

---

## 5. 测试 D — v2.0 教材上传与异步解析

### 5.1 Web 入口

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| D1 | Web 端 **📚 教学资料管理** → 切换到 **📖 教材管理** tab | 展示 TextbookManagement 页面 | ☐ |
| D2 | 教材 ID 填 `textbook_python_intro`，标题填 `Python 编程：从入门到实践` | — | ☐ |
| D3 | 上传 `test-python-intro.pdf`（文字版 ~5MB） | 上传成功，提示"异步解析已启动" | ☐ |

### 5.2 异步解析进度

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| D4 | 观察教材列表表格 "状态" 列 | 显示 "解析中 X%"，进度条动态增长 | ☐ |
| D5 | 等待解析完成（约 30s~5min） | 状态变 "已完成"，章节数显示 N | ☐ |
| D6 | `curl http://localhost:4001/api/v1/teacher/textbook/textbook_python_intro/status` | task_status=done, task_progress=100, total_chapters>0 | ☐ |
| D7 | `sqlite3 teaching_system.db "SELECT COUNT(*) FROM textbook_chapters WHERE textbook_id='textbook_python_intro'"` | ≥ 1（视教材章节数） | ☐ |

### 5.3 OCR 路径测试（扫描版 PDF）

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| D8 | 上传 `test-large-textbook.pdf`（扫描版 ~50MB） | 解析中 | ☐ |
| D9 | 完成后 `SELECT ocr_used FROM textbook_chapters WHERE textbook_id='test-large-textbook'` | 部分或全部 ocr_used=1 | ☐ |
| D10 | LLM 设置页未配置 → 上传教材 | **降级**：使用正则切分，仍生成章节（可能粒度粗） | ☐ |

### 5.4 大文件上传测试

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| D11 | 上传 `test-large-textbook.pdf`（~450MB） | multer 不报错，解析在后台 worker | ☐ |
| D12 | 上传 600MB 文件 | 后端返回 500（超 500MB 上限） | ☐ |

---

## 6. 测试 E — v2.0 章节范围划定（手动 + AI）

### 6.1 章节列表展示

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| E1 | 教材列表 → 点击已完成教材的 **划定范围** 按钮 | 展示章节列表卡片 | ☐ |
| E2 | 表格列：章节 / 标题 / 字符数 / OCR / 周数 / AI 建议 / 手动划定 | 7 列齐全 | ☐ |
| E3 | 周数列初始为 "未划定"（默认 Tag） | — | ☐ |

### 6.2 AI 评判

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| E4 | 点击 **AI 评判所有章节** 按钮 | loading；完成后显示 `AI 已评判 N 个章节` | ☐ |
| E5 | AI 建议列显示紫色 Tag：`建议第 X 周` + 难度 + reasoning | 至少 1 章有 AI 建议 | ☐ |
| E6 | 周数列显示紫色 Tag（第 X 周） | 与 AI 建议一致 | ☐ |
| E7 | `SELECT source FROM textbook_chapter_weeks` | 全部为 `ai-suggested` | ☐ |

### 6.3 一键采纳 AI 建议

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| E8 | 点击 **一键采纳 AI 建议** | 提示 "已采纳 N 条 AI 建议" | ☐ |
| E9 | `SELECT source FROM textbook_chapter_weeks` | 全部为 `ai-accepted` | ☐ |
| E10 | 周数 Tag 颜色 | 仍为紫色（采纳不影响 source 标记） | ☐ |

### 6.4 教师手动设定（覆盖 AI）

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| E11 | 在某章节的 "手动划定" Select 中选 `第 5 周` | 提示 `第 1 章 → 第 5 周` | ☐ |
| E12 | 该章周数 Tag 变蓝色（manual 标记） | 颜色变化 | ☐ |
| E13 | `SELECT source, applicable_week FROM textbook_chapter_weeks WHERE chapter_index=1` | source='manual', applicable_week=5 | ☐ |
| E14 | **再次**运行 AI 评判 | 该章 source 保持 `manual`（不被 AI 覆盖），其他章节 source='ai-suggested' | ☐ |

### 6.5 周数范围校验

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| E15 | 手动 Select 选第 19 周 | 后端返回 400：applicable_week 必须在 1~18 之间 | ☐ |
| E16 | 选第 0 周 | 后端返回 400 | ☐ |
| E17 | 选 1.5（浮点） | 后端返回 400（必须为整数） | ☐ |

---

## 7. 测试 F — 学生端拉取教材章节到 RAG

### 7.1 启用教材 ID

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| F1 | 在 VS Code 配置 `clineTeaching.currentTextbookId` 设为 `textbook_python_intro`（通过命令面板 → Preferences: Open User Settings (JSON)） | 配置保存 | ☐ |
| F2 | 切到第 1 周（无任何 wiki chunk） | 仅显示教材章节（OCR + LLM 切分后的内容） | ☐ |
| F3 | 切到第 5 周（已有手动划定为第 5 周的章节） | 显示该教材章节 + 此前上传的 wiki chunk | ☐ |
| F4 | 提问："教材第 5 章讲了什么？" | AI 回答引用 textbook chapter 内容（"[教材 第 5 周] 章节标题"） | ☐ |

### 7.2 教材切换

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| F5 | 修改 `currentTextbookId` 为另一个教材 ID | 主进程日志显示缓存清空，下次拉取用新教材 | ☐ |
| F6 | 留空 `currentTextbookId` | 不拉取教材章节，仅返回 wiki_chunks | ☐ |

### 7.3 章节上下文截断

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| F7 | 上传一本 100 章的教材并全部划定为第 1~18 周 | System Prompt 不超过 16k 字符 | ☐ |
| F8 | 控制台 `[LLMWikiService] 教材章节` 日志 | 显示章节数 + 截断标记 "> 后续教材章节已省略" | ☐ |

---

## 8. 测试 G — 异常与降级路径

### 8.1 输入校验

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| G1 | 上传资料时 ID 留空 | 前端 message.error，后端 400 | ☐ |
| G2 | 上传资料时周数填 19 | 前端 message.error，后端 400 | ☐ |
| G3 | 删除某资料 → 确认 Popconfirm | 列表行消失；`SELECT * FROM wiki_chunks WHERE id=?` 为空 | ☐ |
| G4 | 删除教材 → 后端 ON DELETE CASCADE 级联清理 chapters + chapter_weeks | `SELECT COUNT(*) FROM textbook_chapters WHERE textbook_id=?` 为 0 | ☐ |

### 8.2 后端不可达

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| G5 | 关闭后端进程 | Web 端 axios 报错 `Network Error`；UI 提示"加载失败" | ☐ |
| G6 | 重启后端 | 自动恢复正常 | ☐ |
| G7 | 在插件 UI 把 serverUrl 改为 `http://localhost:9999`（无效） | 主进程 `[LLMWikiService] 拉取异常` 日志，UI 仍可操作（不崩） | ☐ |

### 8.3 LLM 不可用

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| G8 | LLM 设置页填一个超时的 baseUrl（如 `https://httpbin.org/delay/60`） | 后端 .env 写入 + 30s 超时后降级 | ☐ |
| G9 | 上传资料 | cleaned_by_llm=false，llm_clean_error 含 "timeout" 字样 | ☐ |
| G10 | **不阻塞**验证：上传仍成功，UI 表格正常显示"原始文本" | 文档 §10.2 决策 8.B | ☐ |

### 8.4 文件安全

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| G11 | 上传 `test-malicious.txt`（含 `<script>alert(1)</script>`） | 服务端只存原始内容，不渲染脚本 | ☐ |
| G12 | 上传 `.exe` 格式伪装成 .pdf | multer fileFilter 拒绝（mimeType 检查） | ☐ |
| G13 | 上传 0 字节文件 | multer 接受但解析结果为空 → "原始内容为空" | ☐ |

### 8.5 并发与数据一致性

| 步骤 | 操作 | 期望结果 | 通过？ |
|------|------|----------|--------|
| G14 | 同时上传 3 个不同教材 | 3 个 worker 并行执行，进度独立 | ☐ |
| G15 | 解析过程中点击删除该教材 | `DELETE /textbook/:id` → ON DELETE CASCADE 级联清理 | ☐ |

---

## 9. 测试 H — 纯 API 回归（curl / PowerShell）

### 9.1 健康检查

```bash
curl http://localhost:4001/api/health
# 期望：{"ok":true,"service":"teaching-server",...}
```

### 9.2 Wiki CRUD 回归

#### H1. 上传 Markdown 资料
```bash
curl -X POST http://localhost:4001/api/v1/teacher/wiki \
  -F "id=api_test_week1" \
  -F "title=API 测试资料" \
  -F "applicable_week=1" \
  -F "content=# 测试\n\n## 定义\n这是一个测试。" \
  -F "attachments=@./test-week3-loops.md"
# 期望：201 Created, JSON 含 chunks 数组
```

#### H2. 列表查询
```bash
curl "http://localhost:4001/api/v1/teacher/wiki/list?week=1"
# 期望：{"ok":true,"count":1,"data":[{...}]}
```

#### H3. 学生端拉取
```bash
curl "http://localhost:4001/api/v1/wiki?max_week=3"
# 期望：含 chunk_week3_loops + 其他 ≤3 周的 chunk
```

#### H4. 删除
```bash
curl -X DELETE http://localhost:4001/api/v1/teacher/wiki/api_test_week1
# 期望：{"ok":true,"message":"Wiki api_test_week1 已删除"}
```

### 9.3 v2.0 教材 API 回归

#### H5. 列出教材
```bash
curl http://localhost:4001/api/v1/teacher/textbooks
# 期望：列出所有教材（包含 task_status / progress）
```

#### H6. 轮询进度
```bash
curl http://localhost:4001/api/v1/teacher/textbook/textbook_python_intro/status
# 期望：{ok:true, data:{task_status:"done", task_progress:100, ...}}
```

#### H7. 章节列表
```bash
curl http://localhost:4001/api/v1/teacher/textbook/textbook_python_intro/chapters
# 期望：{ok:true, count:N, data:[{chapter_index, title, preview, applicable_week, source}]}
```

#### H8. 触发 AI 评判
```bash
curl -X POST http://localhost:4001/api/v1/teacher/textbook/textbook_python_intro/ai-review
# 期望：{ok:true, count:N, data:[{chapter_index, suggested_week, difficulty, reasoning}]}
```

#### H9. 手动设定章节↔周数
```bash
curl -X POST http://localhost:4001/api/v1/teacher/textbook/textbook_python_intro/chapter-week \
  -H "Content-Type: application/json" \
  -d '{"chapter_index":0,"applicable_week":3}'
# 期望：{ok:true, message:"第 0 章 → 第 3 周"}
```

#### H10. 一键采纳
```bash
curl -X POST http://localhost:4001/api/v1/teacher/textbook/textbook_python_intro/ai-accept
# 期望：{ok:true, updated:N}
```

#### H11. JOIN 查询（v2.0 核心）
```bash
curl "http://localhost:4001/api/v1/wiki?max_week=5&textbook_id=textbook_python_intro"
# 期望：data 含 wiki_chunks + textbook_chapters 字段
```

### 9.4 LLM 设置 API（内部）

#### H12. 推送 .env
```bash
curl -X POST http://localhost:4001/api/v1/internal/llm-env \
  -H "Content-Type: application/json" \
  -d '{"provider":"openai","baseUrl":"https://api.openai.com/v1","apiKey":"sk-test","model":"gpt-4o-mini","enableTools":false}'
# 期望：{ok:true, message:"LLM 配置已写入 .env 并热加载"}
# ⚠ 仅测试用，生产环境请勿推送 fake key
```

#### H13. 测试 LLM 连接
```bash
curl -X POST http://localhost:4001/api/v1/internal/llm-test \
  -H "Content-Type: application/json" \
  -d '{"baseUrl":"https://api.openai.com/v1","apiKey":"sk-real-key","model":"gpt-4o-mini"}'
# 期望：{ok:true, message:"连接成功..."} 或 {ok:false, message:"401 Unauthorized"}
```

---

## 10. 验收清单

### 10.0 部署前置（必读）

> ⚠️ **v2.0 部署踩坑记录**（已在 commit `4bbae0ad` 之后修复）

| 坑 | 现象 | 解决方案 |
|----|------|----------|
| canvas 原生编译失败 | `node-gyp` 报 Python/VS 构建工具链缺失错误 | **替换为 `@napi-rs/canvas`**（纯 Rust 实现，无需 node-gyp，跨平台兼容） |
| pnpm 10 默认忽略 build script | tesseract.js / canvas 等 native 模块未真正构建 | 在 `package.json` 添加 `"pnpm.onlyBuiltDependencies": ["@napi-rs/canvas", "tesseract.js", "core-js", "core-js-pure"]` |
| pdfjs-dist 6.x 大版本升级 | API 不兼容旧用法 | 固定 `pdfjs-dist@^4.10.0` |
| Worker 文件需编译为 .js | tsx watch 不能直接 import .ts worker | Worker 入口用 `textbookWorker.ts`，运行时通过 tsx 编译（见 `textbookTaskQueue.ts` 中的 `path.resolve(__dirname, "textbookWorker.js")`） |

#### 部署命令（推荐顺序）

```bash
# 1. 后端安装依赖（含 ~100MB OCR 依赖）
cd D:\web-dashboard\teaching-server
pnpm install
# ⚠ 第一次安装耗时 20~30 分钟（tesseract.js 含中文 chi_sim 语言包）

# 2. 验证 OCR 模块可加载
node -e "import('@napi-rs/canvas').then(c => console.log('OK'))"
node -e "import('tesseract.js').then(t => console.log('OK'))"

# 3. 启动后端
pnpm dev

# 4. 启动 Web
cd D:\web-dashboard\frontend && pnpm dev

# 5. 启动 VS Code 扩展开发宿主
cd D:\cline && code .   # 然后按 F5
```

#### OCR 首次使用预热

第一次 OCR 扫描版 PDF 时，tesseract.js 会下载语言包（eng ~2MB + chi_sim ~30MB），约 1~3 分钟。建议在测试前先上传一个测试 PDF 让系统预热。

---

### 10.1 v1.3 功能验收

| 功能 | 验收条件 | 通过？ |
|------|----------|--------|
| F1 | 教师可上传 .md/.doc/.docx/.pdf/.pptx 资料 | ☐ |
| F2 | 后端调用 LLM 清洗（chunks ≤ 5） | ☐ |
| F3 | 清洗失败降级（不阻塞上传） | ☐ |
| F4 | 插件主工具栏显示周数选择 + 服务器设置 | ☐ |
| F5 | 切换周数触发 fetchWikiForWeek + toast 提示 | ☐ |
| F6 | 修改 serverUrl 写 VS Code 全局配置 | ☐ |
| F7 | LLM 设置页模型下拉自动填 baseUrl | ☐ |
| F8 | 保存 API Key 写本地 + 后端 .env（热加载） | ☐ |
| F9 | 工具调用答疑开关默认关闭 + 二次确认 | ☐ |
| F10 | buildSystemPrompt 含 3 条认知边界约束 | ☐ |
| F11 | answerWithTools 调用 grep_wiki/read_chunk/list_weeks | ☐ |

### 10.2 v2.0 功能验收

| 功能 | 验收条件 | 通过？ |
|------|----------|--------|
| V1 | 教师可上传 ≤500MB pdf/docx 教材 | ☐ |
| V2 | 后端异步 worker 解析（HTTP 不阻塞） | ☐ |
| V3 | 解析进度轮询（task_progress 0~100） | ☐ |
| V4 | LLM 自动切分章节（降级正则） | ☐ |
| V5 | 扫描版 PDF 自动 OCR（tesseract.js） | ☐ |
| V6 | AI 评判章节难度 + suggested_week | ☐ |
| V7 | 教师手动设定章节↔周数（覆盖 AI） | ☐ |
| V8 | 一键采纳 AI 建议 | ☐ |
| V9 | 学生端拉取时 JOIN textbook_chapters | ☐ |
| V10 | buildSystemPrompt 合并教材章节到 Primary Context | ☐ |
| V11 | 单章节 ≤2000 字截断 | ☐ |
| V12 | WikiManagement 含 "资料管理" / "教材管理" 两 tab | ☐ |

### 10.3 验收通过标准

- 全部 v1.3 F1~F11 通过
- 全部 v2.0 V1~V12 通过
- 异常路径 G1~G15 无阻塞 / 无崩溃
- 性能基线：教材解析 100MB PDF ≤ 10 分钟；System Prompt 拼接 ≤ 1 秒

### 10.4 已知限制（无需修复）

1. **OCR 80MB 依赖**：首次扫描版 PDF 解析较慢（10~30s）
2. **AI 评判无缓存**：每次点按钮都重新调用 LLM
3. **多教材优先级**：仅按 `currentTextbookId` 单一选择，不支持多本并行

---

## 附录 A：日志速查表

| 日志关键词 | 来源 | 含义 |
|-----------|------|------|
| `[LLMWikiService] 拉取成功` | 插件 | wiki 拉取成功 |
| `[LLMWikiService] 教材章节` | 插件 | 教材 JOIN 章节数 |
| `[LLMWikiService] 工具调用模式启动` | 插件 | 工具调用开关开启 |
| `[llmHelper] ✅ LLM 配置已加载` | 后端 | .env 热加载成功 |
| `[llmHelper] LLM 清洗失败，降级为原始文本` | 后端 | LLM 异常降级 |
| `[textbookParser] LLM 切分失败，降级为正则` | 后端 | 章节切分降级 |
| `[textbookParser] 启动 OCR` | 后端 | 扫描版 PDF 触发 OCR |
| `[VscodeWebviewProvider] serverUrl 已更新为` | 插件 | 服务器地址修改 |
| `✅ .env 已更新` | 后端 | 内部 llm-env 写入成功 |

## 附录 B：常用命令

```bash
# 查看 SQLite 数据
sqlite3 D:\web-dashboard\teaching-server\teaching_system.db
.tables
SELECT * FROM wiki_chunks;
SELECT * FROM textbook_chapters;
SELECT * FROM textbook_chapter_weeks;
.quit

# 后端健康检查
curl http://localhost:4001/api/health

# 插件配置查看（VS Code 命令面板）
> Preferences: Open User Settings (JSON)
# 搜索 "clineTeaching"
```

## 附录 C：测试报告模板

```
测试日期：________________
测试人员：________________
测试环境：Windows 11 / Node 22.x / pnpm 9.x

【v1.3 通过项】11/11
【v2.0 通过项】12/12
【异常路径通过项】15/15

【发现的问题】
1. ________________
2. ________________

【性能数据】
- 教材解析时间：________ 秒
- System Prompt 拼接：________ ms
- LLM 清洗耗时：________ 秒

【结论】
☐ 全部通过，可发布
☐ 有遗留问题，待修复后回归
```