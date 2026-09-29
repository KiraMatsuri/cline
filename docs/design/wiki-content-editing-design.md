# 资料内容编辑（可维护性）设计文档

> 目标：在教师端「资料管理 → 已分发资料」列表中新增**编辑**操作，让教师能直接维护清洗后的 Markdown 内容，
> 补齐"可维护性"闭环的最后一环。
>
> 撰写日期：2026-09-28
> 涉及仓库：`d:\web-dashboard`（frontend + teaching-server）
> 关联文档：`docs/design/wiki-mcp-retrieval-design.md` §D7（可维护性设计）、`docs/design/wiki-rag-design.md`（初版资料库设计）

---

## 0. 背景：可维护性缺的是哪一环

`wiki-mcp-retrieval-design.md` §D7 论证了：MCP 化后资料"改完立即生效"（无索引重建、无客户端缓存陈旧）。
但那次核对暴露了一个更前面的空缺：

| 环节 | 现状 |
|---|---|
| 载体是 Markdown（非向量） | ✅ 具备 |
| 改完立即生效（无需重建索引） | ✅ MCP 化后兑现 |
| **教师能直接改内容** | ❌ **缺失** |

`WikiManagement.tsx` 的资料操作目前只有三个：**重新清洗** / **删除** / （上传）。

想改一个字，教师只能点"重新清洗"，即**让 LLM 把整篇重新加工一遍** —— 这有三个问题：

1. **不可预期**：LLM 每次输出不同，教师想要的微调可能被"改回去"
2. **成本高**：一次 LLM 调用只为一处笔误
3. **有风险**：清洗失败会降级为原文（本项目已有此项防护，见 teaching-server 的 `cleaned_by_llm` 判断）

所以本文档定义**教师直接编辑 Markdown**的能力。

---

## 1. 目标与非目标

### 1.1 目标

- **M1** 资料列表新增「编辑」操作，打开编辑器可查看并修改该资料的**完整 Markdown 内容**
- **M2** 保存后内容**即时生效**（无需重新清洗、无需重启任何服务）
- **M3** 编辑结果**不破坏现有数据结构**（chunk 分块、周数归属、教材来源关联均可保留）
- **M4** 与「重新清洗」之间的**覆盖冲突有明确防护**，不出现静默丢失教师的修改

### 1.2 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| Markdown 实时预览 / 富文本编辑器 | 前端无 markdown 渲染依赖，引入成本 > 收益（YAGNI）。用等宽 `TextArea` 编辑源码 |
| 版本历史 / 回滚 | 需要新表与 diff 存储，本次不引入。以 `updated_at` + 操作日志作为最小可追溯性 |
| 在编辑器中新增附件/图片上传 | 附件在**上传资料时**确定（`wiki_attachments`）。编辑仅处理文本，不改变附件集合 |
| 允许改 `id` | 主键变更会破坏学生端引用与 `source_textbook_id` 关联。**id 只读** |
| 编辑教材章节（`textbook_chapters`） | 教材内容应改**源文件**后重新解析。本功能只面向已分发到资料库的 wiki 内容 |

---

## 2. 现状约束（实现前必须知道的三件事）

### 2.1 列表接口返回的内容**不完整**

`GET /api/v1/teacher/wiki/list` 会按 baseId 聚合（多 chunk 只展示一行）：

```ts
const baseId = row.id.includes("__chunk") ? row.id.split("__chunk")[0] : row.id
if (!wikiMap.has(baseId)) {
  wikiMap.set(baseId, { ...row, id: baseId })   // ← 只保留「首个」chunk
}
```

**结论**：列表里的 `content` 在多 chunk 情况下**只是第一块**。
编辑器**不能**直接用列表数据，必须新增"取完整内容"的端点（见 §3.2）。

### 2.2 分块分隔符是 `\n\n---\n\n`，不是裸 `---`

清洗管线写库时的约定（`/clean`、`publish-as-wiki`）：

```ts
const newContent = cleaned.chunks.join("\n\n---\n\n")
```

⚠️ **不能用裸 `---` 做分块**：清洗后的内容**含 YAML frontmatter**，而 frontmatter 本身就是用 `---` 包裹的：

```markdown
---
id: chunk_week5_decorators
title: 装饰器
applicable_week: 5
---

## 定义
...
```

裸 `---` 切分会把 frontmatter 切成碎片。
**必须使用与 join 完全对称的 `\n\n---\n\n`**（前后各一个空行）—— 该模式不会匹配 frontmatter 的 `---`（其上下均为单换行）。

### 2.3 前端无 markdown 渲染依赖

`frontend/package.json` 中没有 `marked` / `remark` / `react-markdown` 等。
→ 编辑器采用 `Input.TextArea`（等宽字体、自适应高度），**不新增依赖**。

---

## 3. 关键设计决策

### E1：编辑粒度 = **整个 baseId**，而非单个 chunk

教师的心智模型是"这篇资料"，不是"第 2 个 chunk"。多 chunk 只是 LLM 清洗时的切分产物。

→ 编辑器展示 **baseId 下所有 chunk 合并后的完整内容**，保存时整体替换。

### E2：新增"取完整内容"端点

因为 §2.1，需要：

```
GET /api/v1/teacher/wiki/content?id=<baseId>
```

返回合并后的全文 + 元信息（chunk 数、来源教材、编辑状态）。

### E3：保存时**按 `\n\n---\n\n` 重新分块**

保存流程（服务端）：

1. 校验入参
2. `deleteWikiChunks(baseId)` —— **复用现有函数**（`server.ts` 已定义，含 `__chunkN` 前缀匹配）
3. 将新内容按 `\n\n---\n\n` 切分并过滤空块
4. 重新插入：
   - 单块 → `id = baseId`
   - 多块 → `id = ${baseId}__chunk${i}`，`chunk_index = i`，`chunk_total = n`
5. 写入 `manually_edited = 1`、刷新 `updated_at`、清空 `llm_clean_error`、**保留 `source_textbook_id`**

**为什么由教师隐式控制分块**：分隔符与 LLM 清洗的约定**完全对称** → 教师想分块就在内容里插入「空行 + `---` + 空行」，不想分块就不加。无需引入额外的分块算法。

### E4：新增 `manually_edited` 字段

```sql
ALTER TABLE wiki_chunks ADD COLUMN manually_edited INTEGER DEFAULT 0;
```

用途：
1. 列表展示状态（"已清洗" / "已清洗 · 已人工编辑"）
2. **驱动 E5 的覆盖冲突提示**

迁移方式沿用既有模式（`initDatabase()` 内检查 `PRAGMA table_info` 后 `ALTER`，见 `wiki_chunks.source_textbook_id` 的迁移实现）。

### E5：与「重新清洗」的覆盖冲突必须有防护

**这是本设计最重要的一条**。「重新清洗」的流程是"删除原 chunks → LLM 重写 → 插入"，
`content` 会被 LLM 的**新输出整体覆盖** —— 教师的编辑**静默丢失**。

防护分两层：

| 层 | 行为 |
|---|---|
| **前端** | 「重新清洗」的 Popconfirm 中，若 `manually_edited === 1`，**追加醒目警告**：*"该资料已被人工编辑，重新清洗将覆盖你的全部修改（不可恢复）"* |
| **后端** | `POST /api/v1/teacher/wiki/reclean` 在目标存在 `manually_edited = 1` 的 chunk 时，若未显式带 `?force=true`，返回 **409** + `{ ok:false, code:"MANUALLY_EDITED", message:"该资料已被人工编辑，重新清洗会覆盖修改。确认请加 force=true" }` |

> 后端这道是必要的：前端提示可能被绕过（直接调 API），而"覆盖教师的手工成果"是不可逆损失。

### E6：编辑器 UI —— Modal + TextArea

操作列新增「编辑」，位于「重新清洗」左侧：

```
[编辑] [重新清洗] [删除]
```

点击后打开 Modal（宽 900px）：

```
┌─ 编辑资料 — chunk_week5_decorators ──────────────────────────┐
│ 标题  [装饰器______________________________]                  │
│ 周数  [第 5 周 ▾]    分块 3 块   来源 教材导入   ⚠ 已人工编辑  │
├──────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ (等宽字体 TextArea，autoSize minRows=18 maxRows=32)      │ │
│ │ ---                                                      │ │
│ │ id: chunk_week5_decorators                               │ │
│ │ ...                                                      │ │
│ │ ---                                                      │ │
│ │                                                          │ │
│ │ ## 定义                                                  │ │
│ │ 装饰器是……                                              │ │
│ └──────────────────────────────────────────────────────────┘ │
│ 字符数 2,431 ｜ 分块将按「空行 + --- + 空行」自动识别          │
├──────────────────────────────────────────────────────────────┤
│                                    [取消]  [保存]            │
└──────────────────────────────────────────────────────────────┘
```

**顺带支持编辑 `title` 与 `applicable_week`**：这两项与内容在同一张卡片中，教师改内容时常常也需要调整
（尤其周数错配是高频问题）。成本极低，故一并支持。

`id` **只读展示**（见 §1.2）。

### E7：附件不改动

编辑仅处理 `content` 文本。已有附件仍通过 `GET /api/v1/wiki/:id/attachments/:fileId/download` 引用。
**不在本次引入编辑器内的图片/文件上传**（YAGNI，见 §1.2）。

### E8：不引入版本历史

仅更新 `updated_at`，并在服务端日志记录一次编辑动作（`[wiki] 人工编辑 baseId=…, chunks=n`）。
回滚能力留待后续独立课题。

### E9：学生端生效依赖（跨设计文档的依赖项）

保存后是否"立即"被学生看到，取决于学生端的检索方式：

| 学生端模式 | 生效时机 |
|---|---|
| **MCP 检索**（目标形态） | **下一次检索立即生效** |
| 全量注入（现状） | 需学生切换教学周数或重启 VS Code（见 `wiki-mcp-retrieval-design.md` §D7） |

→ 本功能**不依赖** MCP 改造即可交付，但"即时生效"的完整兑现需要 MCP 改造一并落地。

---

## 4. 接口设计

### 4.1 `GET /api/v1/teacher/wiki/content?id=<baseId>`

取 baseId 下全部 chunk 并按序合并。

**响应**：

```json
{
  "ok": true,
  "data": {
    "id": "chunk_week5_decorators",
    "title": "装饰器",
    "applicable_week": 5,
    "content": "---\nid: ...\n---\n\n## 定义\n...\n\n---\n\n## 示例\n...",
    "chunk_total": 3,
    "cleaned_by_llm": 1,
    "manually_edited": 1,
    "source_textbook_id": "book_python-...",
    "updated_at": "2026-09-28 12:00:00"
  }
}
```

**合并规则**：按 `chunk_index ASC` 排序，用 `\n\n---\n\n` join —— 与写库时的 `join` 对称，保证"取出 → 原样存回"幂等。

**未找到** → `404 { ok:false, message:"资料不存在" }`。

> ⚠️ 与既有 wiki 端点一致，**id 必须走 query 参数**：资料 id 可能含斜杠（`book_xxx/0`），
> 路径段的 `:id` 会被 Express 当作多段而 404（同 `DELETE /api/v1/teacher/wiki?id=` 的处理）。

### 4.2 `PUT /api/v1/teacher/wiki/content?id=<baseId>`

**Body**：

```json
{
  "title": "装饰器（已校对）",
  "applicable_week": 5,
  "content": "---\n...\n---\n\n## 定义\n..."
}
```

| 字段 | 必填 | 校验 |
|---|---|---|
| `title` | 否 | 1~200 字符；缺省则保留原值 |
| `applicable_week` | 否 | 1~18 整数；缺省则保留原值 |
| `content` | 是 | 非空；总长 ≤ 200,000 字符（约 200KB，防误粘贴超长内容） |

**处理流程**：

```ts
// 1) 存在性校验：取该 baseId 下全部 chunk（含首块字段，用于缺省沿用）
const chunkPrefix = `${baseId}__chunk`
const existing = await db.all(
  `SELECT id, title, applicable_week, cleaned_by_llm, source_textbook_id
     FROM wiki_chunks
    WHERE id = ? OR substr(id, 1, ?) = ?
    ORDER BY chunk_index ASC`,
  baseId, chunkPrefix.length, chunkPrefix)
if (existing.length === 0) return 404

// 2) 缺省值：未传的字段沿用首块值
const first = existing[0]
const nextTitle        = title ?? first.title
const nextWeek         = applicable_week ?? first.applicable_week
const keepCleanedByLlm = first.cleaned_by_llm            // 内容基础仍来自 LLM 清洗
const keepSourceBookId = first.source_textbook_id        // 教材来源关联保留

// 3) 切分（与写库时的 join 完全对称）
const parts = content.split(/\n\n---\n\n/).map(s => s.trim()).filter(Boolean)
if (parts.length === 0) return 400   // 内容全为空白/仅分隔符

// 4) 原子替换
await db.run("BEGIN")
await deleteWikiChunks(baseId)          // 复用现有函数
for (let i = 0; i < parts.length; i++) {
  const newId = parts.length === 1 ? baseId : `${baseId}__chunk${i}`
  await db.run(
    `INSERT INTO wiki_chunks
       (id, title, content, applicable_week, cleaned_by_llm, llm_clean_error,
        chunk_index, chunk_total, source_textbook_id, manually_edited)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, 1)`,
    [newId, nextTitle, parts[i], nextWeek, keepCleanedByLlm, i, parts.length, keepSourceBookId])
}
await db.run("COMMIT")
```

**响应**：

```json
{ "ok": true, "message": "已保存（3 个分块）", "data": { "id": "...", "chunk_total": 3 } }
```

> `cleaned_by_llm` **保留原值**（内容基础仍来自 LLM 清洗），人工编辑由 `manually_edited` 单独标记，两个维度不互相覆盖。

### 4.3 `POST /api/v1/teacher/wiki/reclean?id=<baseId>&force=true`（改造既有端点）

新增行为：目标存在 `manually_edited = 1` 且未传 `force=true` → **409**（见 §E5）。

---

## 5. 数据模型变更

```sql
-- v2.13
ALTER TABLE wiki_chunks ADD COLUMN manually_edited INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_wiki_manual_edited ON wiki_chunks(manually_edited);
```

**迁移实现**（沿用 `source_textbook_id` 的既有模式）：

```ts
const cols = await db.all<Array<{ name: string }>>(`PRAGMA table_info(wiki_chunks)`)
if (!cols.some(c => c.name === "manually_edited")) {
  await db.exec(`ALTER TABLE wiki_chunks ADD COLUMN manually_edited INTEGER DEFAULT 0;`)
  console.log("🔧 迁移：wiki_chunks 新增列 manually_edited")
}
```

**不回填**：历史数据一律视为 `0`（未人工编辑）—— 我们无法判断过去是否有人工改动，保守取 0。

**列表接口同步返回该字段**（`GET /api/v1/teacher/wiki/list` 的 SELECT 增加 `manually_edited`）。

---

## 6. 前端改动清单

| 文件 | 改动 |
|---|---|
| `frontend/src/components/WikiManagement.tsx` | ① `WikiChunk` 接口加 `manually_edited?: number`<br/>② 操作列新增「编辑」按钮（置于「重新清洗」左）<br/>③ 新增编辑 Modal（受控 state：`editingId` / `editingTitle` / `editingWeek` / `editingContent` / `saving`）<br/>④ 打开时调 `GET /wiki/content` 拉全文（**不可用列表数据**，见 §2.1）<br/>⑤ 「重新清洗」确认框按 `manually_edited` 追加覆盖警告<br/>⑥ 「LLM 清洗」列对人工编辑的资料追加标签 |
| `teaching-server/src/server.ts` | ① `initDatabase()` 加 `manually_edited` 迁移<br/>② 新增 `GET /wiki/content`、`PUT /wiki/content`<br/>③ `reclean` 加 `force` 校验（409）<br/>④ 列表接口 SELECT 补 `manually_edited` |
| `CHANGELOG.md` | 记录本次变更 |

**编辑 Modal 的交互细节**：

- 打开即拉取内容，期间显示 `Spin`（大资料可能有几百 KB，避免白屏）
- 关闭时若内容已改动，弹二次确认（防误关丢改动）
- 保存中禁用按钮；成功后 `message.success` 并刷新列表
- 失败时透出后端 `message`（与既有 `onDelete`/`onReClean` 的错误处理一致）

---

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| 取内容时资料已被删除 | `404` → 前端提示"资料不存在，可能已被删除"，关闭 Modal 并刷新列表 |
| 内容为空（全为空白/仅分隔符） | `400` → 前端提示"内容不能为空" |
| 内容超长 | `400` → 提示"内容过长（上限 20 万字符）" |
| `applicable_week` 越界 | `400` → 提示"周数须在 1~18 之间" |
| 保存时并发（他人已改/已删） | 事务内 `deleteWikiChunks` 影响 0 行 → 按"资料不存在"处理（`404`） |
| 重新清洗撞上人工编辑 | `409` → 前端弹确认，确认后带 `force=true` 重试 |

**原则**：与既有端点一致，所有失败返回 `{ ok:false, message }`，前端统一用 `axios.isAxiosError(err) ? err.response?.data?.message : err.message` 透出。

---

## 8. 测试策略

| 层级 | 用例 | 验证点 |
|---|---|---|
| 服务端 | 取内容：单 chunk 资料 | 返回原文，`chunk_total = 1` |
| | 取内容：3 chunk 资料 | 返回按 `chunk_index` 有序、`\n\n---\n\n` 合并的全文 |
| | **幂等性**：取出 → 原样存回 | chunk 数量与内容**完全不变** |
| | 存内容：把 3 块合并成 1 块 | 只剩 1 行，id = baseId，旧 `__chunkN` 行已删 |
| | 存内容：1 块拆成 4 块 | 生成 `__chunk0..3`，`chunk_total = 4` |
| | **frontmatter 保护**：内容含 YAML frontmatter | 分块数正确（**不被 frontmatter 的 `---` 误切**） |
| | 存内容后 `source_textbook_id` | 保持不变 |
| | 存内容后 `llm_clean_error` | 被清空 |
| | **越界取内容**：请求不存在的 id | 404 |
| | **409 防护**：对 `manually_edited=1` 的资料重清洗（不带 force） | 409 且**不修改任何数据** |
| | 同上，带 `force=true` | 正常重清洗 |
| 前端 | 「编辑」按钮打开 Modal | 内容为**全文**（多 chunk 资料验证不是首块） |
| | 改动后直接关闭 | 二次确认出现 |
| | 保存成功 | 列表刷新，「已人工编辑」标签出现 |
| 端到端 | 编辑 → 学生端（切周数后）拉取 | 取到**编辑后的内容** |

**核心验收项**：`幂等性`（取出再存回不变）与 `frontmatter 保护` —— 这两条一旦失败会静默破坏资料。

---

## 9. 风险与已知影响

| 风险 | 影响 | 缓解 |
|---|---|---|
| 教师误删全部内容后保存 | 内容丢失（无版本回滚） | 保存前的空内容校验；§1.2 已说明不做版本历史，需在文档/UI 中让教师知悉不可恢复 |
| 教师手写内容超过单块 4000 字（清洗产物的隐含上限） | 学生端注入时该块被截断 4000 字 | **不静默截断教师内容**；在 Modal 中显示字符数提示，不强制限制 |
| 「重新清洗」覆盖人工编辑 | 不可逆丢失 | §E5 双层防护（前端警告 + 后端 409） |
| 教材重新「导入 wiki 库」覆盖 | 同上（`publish-as-wiki` 会按 `source_textbook_id` 先删后插） | ⚠️ **本次未加防护**。建议后续在教材页的「导入 wiki 库」确认框中对含人工编辑的资料追加提示（列为遗留项） |
| 大资料（>100KB）在 Modal 中编辑卡顿 | 体验问题 | `TextArea` 关闭 `autoSize` 上限；必要时后续引入虚拟化或分块编辑 |
| 编辑后分块结构变化影响学生端检索粒度 | 检索结果条数变化 | 属预期行为（教师显式控制分块）；MCP 检索按 chunk 粒度返回，分块更细则命中更精确 |

---

## 10. 落地阶段

| 阶段 | 交付物 | 可独立验证 |
|---|---|---|
| **P1** | 数据模型迁移（`manually_edited`）+ 列表接口返回该字段 | ✅ 启动后 `PRAGMA table_info` 可见新列 |
| **P2** | `GET /api/v1/teacher/wiki/content` | ✅ curl 验证多 chunk 合并与幂等 |
| **P3** | `PUT /api/v1/teacher/wiki/content`（含分块重建） | ✅ 单块↔多块双向验证 + frontmatter 保护 |
| **P4** | `reclean` 的 409 防护 + `force` 参数 | ✅ 用手工编辑过的资料验证拦截 |
| **P5** | 前端编辑 Modal + 操作列按钮 + 冲突提示 | ✅ 浏览器端到端 |
| **P6** | 端到端：编辑 → 学生端生效 | ✅ 依赖学生端检索模式（见 §E9） |

**P1～P4 全部是服务端改动，可用 curl 完整验证后，再动前端。**

---

## 11. 与既有实现的关系

| 既有实现 | 关系 |
|---|---|
| `deleteWikiChunks(baseId)`（server.ts） | **直接复用** —— 保存时的删除步骤调用它 |
| 清洗管线的 `join("\n\n---\n\n")` | **对称复用** —— 保存时以同一分隔符切分 |
| `GET /api/v1/teacher/wiki/list` | 增加返回 `manually_edited`；**注意其 content 只是首块**，不可用于编辑 |
| `POST /api/v1/teacher/wiki/reclean` | 增加 `force` 校验（§E5） |
| 学生端 MCP 检索改造 | 正交。本功能可独立交付；"即时生效"的完整兑现需要它（§E9） |
| `wiki-mcp-retrieval-design.md` §D7 | 本设计正是其标注的"已知缺口"的补救 |

---

## 附：决策速查

| 决策 | 结论 | 一句话理由 |
|---|---|---|
| E1 | 编辑粒度 = baseId | 教师的心智是"这篇资料"，不是"第 2 个 chunk" |
| E2 | 新增取内容端点 | 列表接口只返回首个 chunk，不足以编辑 |
| E3 | 按 `\n\n---\n\n` 重新分块 | 与写库 join 完全对称 → 可逆；且避开 frontmatter 的 `---` |
| E4 | 新增 `manually_edited` | 需区分"LLM 清洗"与"人工编辑"两个维度 |
| E5 | 重清洗撞人工编辑 → 409 | 覆盖教师手工成果不可逆，必须后端拦截 |
| E6 | Modal + TextArea，顺带可改 title/week | 无渲染依赖；周数错配是高频问题 |
| E7 | 不做编辑器内附件上传 | 附件集合在上传时确定，属另一条链路 |
| E8 | 不做版本历史 | 需新表与 diff 存储，YAGNI，另立课题 |
| id | **只读** | 主键变更会破坏学生端引用与教材来源关联 |
