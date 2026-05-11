# 代码开发计划（运营台 + 发布闭环）

本文档与 [`plan-workbench-publish-first.md`](./plan-workbench-publish-first.md) 对齐：**先实现「工作台与发布」可上线最小闭环**，其余模块按 PRD 占位、后续迭代再接。

---

## 1. 目标与完成定义（当前里程碑）

| 目标 | 完成定义（DoD） |
|------|-----------------|
| 运营台可访问 | 生产 HTTPS 部署；登录后进入应用壳 + 路由 `#workbench`。 |
| 工作台可用 | 单条条目下标题、正文、配图顺序（可先 URL/占位图）可编辑；手机预览与编辑区一致。 |
| 发布可执行 | 与原型一致：**扩展优先** `chrome.runtime.sendMessage`（协议见扩展 README）；失败则 **新标签 + 剪贴板降级**；扩展 ID 可由环境变量或用户设置持久化。 |
| 数据不丢刷新没 | 草稿 **自动保存** 或显式保存，刷新/重进可恢复（至少服务端或 IndexedDB 二选一，推荐服务端为源）。 |

未纳入本里程碑：总览真实数据、文案 AI、生图服务、模版 CRUD、笔记同步官方 API、多账号协作。

---

## 2. 技术选型（可调整，需在迭代 0 冻结）

建议在迭代 0 的 ADR 中写死一项组合，避免并行分叉。

| 层 | 推荐选项 | 说明 |
|----|-----------|------|
| 前端 | React + Vite + TypeScript + React Router；样式 Tailwind 或现有原型风格迁移 | 与 `prototype_v1.2.html` 信息架构对齐；路由保留 `#workbench` 或改为 history 模式（部署时配置 base）。 |
| 后端 | **Python FastAPI** + **PostgreSQL**（本仓库 `apps/api`） | 首版以 **草稿 CRUD + 配图元数据** 为主；无小红书官方写接口则不做「代发」，只做自家数据。 |
| 鉴权 | Session Cookie（同域）或 JWT（短效 + Refresh） | 扩展 `externally_connectable` 需 **HTTPS 固定域名**；与 [`plan-workbench-publish-first.md`](./plan-workbench-publish-first.md) P0-5 同步。 |
| 文件 | 对象存储（S3 兼容）+ 预签名上传 URL | 配图先支持「上传后展示 + 发布时带 URL 清单」；扩展传图属 P1。 |
| 扩展 | 维持现有 `extensions/xhs-publish-bridge`（MV3 + TS） | 选择器与发版节奏见下文阶段 A。 |

---

## 3. 仓库与目录建议（本仓或拆仓）

若在本仓继续演进，建议新增（示例）：

```text
apps/web/          # 运营台 SPA
apps/api/          # FastAPI HTTP API（Python）
packages/shared/   # 可选：与扩展共用的 TS 类型（channel / payload）
extensions/xhs-publish-bridge/   # 保持现状
docs/              # 计划与 PRD
prototype/         # 参考实现，逐步被 apps/web 替代
```

拆仓时：共享类型可发布为内部 npm 包或 git submodule，**消息协议**必须与 [`extensions/xhs-publish-bridge/README.md`](../extensions/xhs-publish-bridge/README.md) 一致。

---

## 4. 分阶段实施（按顺序执行）

### 迭代 0：工程基线（约 3–5 人日）

- [x] 初始化 `apps/web`、`apps/api`，本地 Docker PostgreSQL（`docker-compose.yml`）；CI（lint、typecheck、单测占位）待加。
- [ ] 环境变量模板：数据库 URL、对象存储、**生产前端 origin**（供扩展白名单对照）。
- [ ] 部署草图：前端静态资源 + API 反代同主域或 CORS 白名单（扩展要求运营台为可信 HTTPS）。

**产出**：`README` 一键本地启动；无业务页面亦可验收。

---

### 阶段 A：扩展与创作页对齐（可与迭代 1 并行）

对应产品计划 **P0-4、P0-5**。

- [ ] 在真实页 [`…&target=image`](https://creator.xiaohongshu.com/publish/publish?source=official&target=image) 上调试 `content.ts` 标题/正文选择器；多套 fallback；变更记入 `annex/`（或扩展内映射表 + 简短 README）。
- [ ] 生产运营台 origin 写入 `manifest.json` → `externally_connectable.matches`；staging 域名一并写入便于预发。
- [ ] 扩展版本号与发版说明（CHANGELOG）；团队约定小红书改版时的回归检查清单。

**产出**：安装扩展后，从**本地或预发运营台**发消息可稳定填标题/正文（在官方未大改前提下）。

---

### 迭代 1：后端最小 API（约 5–8 人日）

- [x] 用户与登录（MVP：`demo@local` + `Authorization: Bearer <API_BEARER_TOKEN>`）。
- [x] 数据模型：`Entry`、`DraftImage`（`public_url` 元数据；预签名上传待迭代）。
- [x] API：`GET /api/entries`、`GET/PATCH /api/entries/{id}`、`POST/PATCH/DELETE .../images`、`PUT .../images/reorder`；OpenAPI 见 `/docs`。
- [x] 时间戳：`created_at` / `updated_at`；乐观锁未实现。

**产出**：Swagger UI；前端已对接。

---

### 迭代 2：前端工作台 + 发布（约 8–12 人日）

- [x] 应用壳：侧栏 **工作台与发布** 完整，其余路由占位页（与产品「其他待定」一致）。
- [x] 工作台 UI：标题、正文、配图 URL 列表、手机预览、发布栏、扩展 ID（`localStorage` + `VITE_API_BEARER_TOKEN`）。
- [x] 对接 API：首条 `entry` 加载；正文/标题 **防抖自动保存**；配图 CRUD（参与发布、封面、删除）。
- [x] `publishBridge.ts`：扩展优先 + 剪贴板降级（与原型协议一致）。
- [x] 基础错误与 Toast（加载失败、保存失败提示）。

**产出**：本地可演示「编辑 → 保存 → 发布到小红书页」；配图拖拽排序可后续补（已有 `PUT .../reorder` API）。

---

### 迭代 3：硬化与预发（约 3–5 人日）

- [ ] E2E（Playwright）：登录 → 改标题 → 保存 → 点发布（可 mock `chrome.runtime` 或仅在 Chromium + 测试扩展环境跑）。
- [ ] 安全：CORS、Cookie `Secure`/`HttpOnly`、上传 MIME 与大小限制、速率限制。
- [ ] 观测：结构化日志；可选 `PublishAttempt` 事件写入表或分析管道（与产品 P1 一致）。
- [ ] 预发环境联调扩展白名单。

**产出**：预发 URL + 扩展 zip/crx 内测流程说明。

---

### 阶段 B（P1，工作台与发布增强）

在迭代 3 稳定后再排：

- [ ] 扩展相册多图（签名 URL → blob → 页面可接受的上传路径）；失败策略与重试。
- [ ] 发布前校验（必选图、字数、二次确认）。
- [ ] 可选：扩展成功仍写剪贴板（配图清单）以减少运营步骤。

---

## 5. 接口与协议冻结清单

实施前复制到 PR 描述中核对：

1. **外部页 → 扩展**：`channel: "XHS_PUBLISH_BRIDGE"`, `version: 1`, `action: "FILL_IMG_NOTE"`, `payload: { title, body, path? }`（见扩展 `types.ts`）。
2. **默认创作 URL**：`https://creator.xiaohongshu.com/publish/publish?source=official&target=image`（`path` 可覆盖）。
3. **运营台响应处理**：解析 `sendResponse` 的 `ok` / `result.filled` / `error`，与原型 Toast 一致。

---

## 6. 风险与依赖

| 风险 | 应对 |
|------|------|
| 小红书改版导致选择器失效 | 扩展独立发版；`annex/` 记录 DOM 快照日期；必要时降级仅剪贴板。 |
| 浏览器剪贴板 API 需用户手势 | 发布按钮必须用户点击触发；失败给出明确引导。 |
| 扩展仅 Chrome | PRD 已限定；若需 Safari 需另案（无 `externally_connectable` 同等能力）。 |

---

## 7. 下一步（执行顺序建议）

1. 在仓库中 **落地迭代 0**（目录 + CI + 本地 DB）。  
2. **并行**：阶段 A（扩展选择器 + 白名单）与 **迭代 1**（API）。  
3. **迭代 2** 前端对接；**迭代 3** 联调预发。  

每完成一个迭代，在本文件对应小节将 `[ ]` 改为 `[x]` 或链接到 PR/issue。

---

## 8. 文档索引

| 文档 | 用途 |
|------|------|
| [`plan-workbench-publish-first.md`](./plan-workbench-publish-first.md) | 产品范围 P0/P1/P2 |
| 本文档 | 工程拆分、迭代顺序、DoD |
| [`prd/prd_v1.2.html`](../prd/prd_v1.2.html) | 需求与 §5.4 发布说明 |
| [`extensions/xhs-publish-bridge/README.md`](../extensions/xhs-publish-bridge/README.md) | 扩展消息与安全 |
