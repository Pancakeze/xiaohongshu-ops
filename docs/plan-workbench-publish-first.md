# 实施计划：优先「工作台与发布」

**原则**：先打通「运营台定稿 → 小红书创作页可发」闭环；总览、文案深度能力、模版中心、笔记同步等**待定**，仅保留原型占位。

---

## 阶段 P0（当前迭代目标）

| 序号 | 交付项 | 说明 | 状态 |
|------|--------|------|------|
| P0-1 | 工作台 UI | 图文编辑 + 手机预览 + 底部发布栏 + 扩展 ID 配置（`prototype_v1.2.html`） | 原型已有 |
| P0-2 | Chrome 扩展骨架 | `extensions/xhs-publish-bridge`（MV3 + TS）：`externally_connectable` + background 开 tab + content 填 DOM | 仓库已有 |
| P0-3 | 发布双路径 | **优先** `chrome.runtime.sendMessage(extId, FILL_IMG_NOTE)`；**降级** 新标签 + 剪贴板（标题/正文/配图清单） | 原型已接 |
| P0-4 | 选择器校准 | 在真实 [`/publish/publish?source=official&target=image`](https://creator.xiaohongshu.com/publish/publish?source=official&target=image)（图文发布）上调试 `content.ts` 标题/正文选择器，写入 `annex/` 或扩展内映射表 | **待办** |
| P0-5 | 白名单域名 | 生产运营台 HTTPS 域名加入扩展 `manifest.json` → `externally_connectable.matches` | **待办** |

---

## 阶段 P1（发布增强，仍属「工作台与发布」）

- 扩展侧：**相册多图**（签名 URL → fetch blob → `DataTransfer` / file input，受页面 CSP 约束需实测）。（v0.1.3 起已传 `imageUrls` + 多文件 `DataTransfer` + DOM 观察补填，仍受创作页改版影响。）
- 运营台：发布前校验（必选勾选、可选二次确认）。
- 运营台：**话题**字段（`entries.topics`）→ 发布/剪贴板时 **`#话题` 合并进正文**（与创作页正文内话题展示一致；活动话题/话题搜索仍依赖站内能力）。
- 观测：`PublishAttempt` 日志（成功/降级/错误码）便于排障。

---

## 阶段 P2 及以后（**待定**，不排入当前里程碑）

- 总览仪表盘与数据对接  
- 文案生成与管理（竞品、多版本、合规）深度产品化  
- 图片生成与管理（生图服务、配额、异步任务）  
- 模版管理 CRUD  
- 笔记管理（官方同步、组合草稿、快照策略全量）  
- 多账号、协作、自动发布  

上述项仅在 P0/P1 稳定后重新评审排期。

---

## 依赖与分工建议

- **产品 / 设计**：冻结工作台信息架构；发布失败文案与降级提示。  
- **前端**：真实运营台页面接入 `sendMessage`（与静态原型同协议）。  
- **客户端扩展**：选择器维护、发版节奏与小红书改版对齐。  
- **安全**：`externally_connectable` 严格白名单；可选对消息加签。

---

## 文档与代码索引

- 原型：`prototype/prototype_v1.2.html`（`#workbench`）  
- 扩展：`extensions/xhs-publish-bridge/README.md`  
- PRD：`prd/prd_v1.2.html`（随里程碑增量更新 §5.4）  
- **代码开发计划**（迭代顺序、API 草案、DoD）：[`docs/plan-code-development.md`](./plan-code-development.md)
