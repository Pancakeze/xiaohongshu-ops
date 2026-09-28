# 本地启动说明

本文说明如何在开发机上跑通 **小红书运营台** 全栈（PostgreSQL + API + 前端），以及如何加载 **发布桥接扩展**。适用于 macOS / Linux；Windows 下虚拟环境激活命令见下文标注。

更完整的产品与排障说明见仓库根目录 [README.md](../README.md)。

若希望 **API + 前端也在 Docker 中运行**（仍只需一条 compose 命令），见 [local-dev-docker.md](./local-dev-docker.md)。

---

## 一、环境要求

| 依赖 | 版本 / 说明 |
|------|-------------|
| Docker | 用于本地 PostgreSQL 16 |
| Node.js | 20+（CI 使用 22；推荐与之一致） |
| npm | 随 Node 安装 |
| Python | 3.9+（推荐 3.11+，CI 使用 3.12） |
| Google Chrome | 加载发布扩展；工作台发布到小红书时需已登录创作平台 |

**可选（按功能需要）：**

| 依赖 | 用途 |
|------|------|
| [Ollama](https://ollama.com/) | 文案管理「竞品 + 模版」服务端生成（默认 `http://127.0.0.1:11434`，模型见 `apps/api/app/config.py`） |
| Chrome + 扩展 | 图片管理「Google 生图」Tab、工作台「发布到小红书」 |

---

## 二、架构与端口

```
浏览器 http://127.0.0.1:5173  (apps/web, Vite)
        │  /api、/health 代理
        ▼
     http://127.0.0.1:8000  (apps/api, FastAPI)
        │
        ▼
     PostgreSQL :5432  (docker compose)
```

| 服务 | 地址 | 说明 |
|------|------|------|
| 运营台前端 | http://127.0.0.1:5173 | 请优先用 `127.0.0.1`，与扩展白名单一致 |
| API | http://127.0.0.1:8000 | 健康检查 `/health`，文档 `/docs` |
| PostgreSQL | `127.0.0.1:5432` | 库名 `xiaohongshu`，用户/密码 `xhs` |

---

## 三、首次安装（一次性）

在仓库根目录执行（路径以你本机克隆目录为准）：

```bash
git clone https://github.com/Pancakeze/xiaohongshu-ops.git
cd xiaohongshu-ops
```

### 1. 启动数据库

```bash
docker compose up -d
```

确认容器健康：`docker compose ps`（`postgres` 应为 `healthy`）。

### 2. 配置 API 环境变量

```bash
cp .env.example apps/api/.env
```

按需编辑 `apps/api/.env`。本地默认可不改：

- `DATABASE_URL` — 与 `docker-compose.yml` 一致
- `API_BEARER_TOKEN` — 与前端 token 一致（示例为 `dev-change-me`）
- `CORS_ORIGINS` — 含 `http://127.0.0.1:5173`
- `PUBLIC_BASE_URL` — 默认 `http://127.0.0.1:8000`（本地上传图 URL，扩展拉图用）

### 3. 安装并准备 API

```bash
cd apps/api
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cd ../..
```

### 4. 配置前端环境变量

```bash
cp apps/web/.env.example apps/web/.env
```

确保 `apps/web/.env` 中 **`VITE_API_BEARER_TOKEN`** 与 `apps/api/.env` 的 **`API_BEARER_TOKEN`** 相同。

### 5. 安装前端依赖

```bash
cd apps/web && npm install && cd ../..
```

### 6.（推荐）构建发布扩展

```bash
cd extensions/xhs-publish-bridge
npm install
npm run build
cd ../..
```

Chrome 打开 `chrome://extensions` → 开启 **开发者模式** → **加载已解压的扩展程序** → 选择目录：

`extensions/xhs-publish-bridge/dist`（必须是 **`dist`**，不是 `src`）。

记下扩展 **ID**，在工作台「发布助手」中填写并点 **检测发布助手**。

---

## 四、日常启动

需要 **三个终端**（或后台运行其中部分）。均在仓库根目录操作。

### 终端 1：数据库（若未运行）

```bash
docker compose up -d
```

### 终端 2：API

```bash
cd apps/api
source .venv/bin/activate          # Windows: .venv\Scripts\activate
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

启动成功时会自动建表、迁移字段并种子演示用户 `demo@local` 与空草稿条目。

### 终端 3：前端

```bash
# 仓库根目录
npm run dev:web
```

浏览器访问：**http://127.0.0.1:5173**

若 5173 被占用：

```bash
npm run dev:web:restart
```

---

## 五、启动自检

按顺序确认：

1. **数据库**：`docker compose ps` 中 postgres 为 healthy。
2. **API**：浏览器打开 http://127.0.0.1:8000/health ，应返回正常 JSON。
3. **API 文档**：http://127.0.0.1:8000/docs 可打开。
4. **前端**：http://127.0.0.1:5173 可打开，侧栏可切换总览 / 文案 / 图片等页面。
5. **鉴权**：若页面请求 401，检查 `apps/web/.env` 与 `apps/api/.env` 的 Bearer token 是否一致。
6. **扩展**（可选）：工作台「发布助手」检测通过；修改扩展源码后需 `npm run build` 并在 `chrome://extensions` **重新加载**。

---

## 六、最小业务走通（联调路径）

1. **模版管理** — 启用模版，顶栏绑定条目（会话内「当前内容条目」）。
2. **文案管理** — 生成或编辑文案版本，设主版本。（需 Ollama 时再启动本地 Ollama 服务。）
3. **图片管理** — 图稿池上传或 URL 入池；Google 生图需扩展 + Gemini 登录态。
4. **笔记管理** — 选文案 + 多图 → **组合生成** 草稿。
5. **工作台** — **载入组合草稿** → 预览 → **发布到小红书**（扩展填入创作页，**最终发布仍需在创作页手动确认**）。

配图建议：HTTPS 公网 URL，或本地上传且 `PUBLIC_BASE_URL` 指向 API，便于扩展拉取。

---

## 七、可选能力配置

### 文案生成（Ollama）

1. 安装并启动 Ollama，拉取配置中的模型（默认 `qwen2.5-coder:14b`）。
2. 如需改地址或模型，在 `apps/api/.env` 中设置（变量名见 `apps/api/app/config.py` 中 `ollama_*` 字段，环境变量为大写蛇形，如 `OLLAMA_BASE_URL`）。

未启动 Ollama 时，竞品/模版相关生成接口会失败，其余页面仍可使用。

### Google 生图

依赖 Chrome 扩展内的 Gemini 桥接，以及本机 Chrome 已登录 https://gemini.google.com/ 。高级选项（CDP、Profile 目录）见 `apps/api/app/config.py` 注释与 `extensions/xhs-publish-bridge/README.md`。

### 本地上传图片

- 文件落在 API 工作目录下的 `data/uploads`（可由 `UPLOAD_DIR` 修改）。
- 对外 URL 前缀为 `PUBLIC_BASE_URL`（默认 `http://127.0.0.1:8000`）。

---

## 八、常见问题

| 现象 | 处理 |
|------|------|
| `docker compose` 后 API 连不上库 | 确认 5432 未被占用；`DATABASE_URL` 与 compose 中用户/库名一致 |
| 前端 401 / 无法加载数据 | 对齐 `VITE_API_BEARER_TOKEN` 与 `API_BEARER_TOKEN` |
| 5173 端口占用 | `npm run dev:web:restart` 或结束占用进程 |
| 扩展检测失败 | 是否加载 `dist/`、运营台是否用 `127.0.0.1:5173`、扩展 ID 是否正确 |
| 改扩展无效果 | `npm run build` + Chrome 扩展页 **重新加载** |
| 发布只成功部分图 | 使用可访问的图片 URL；见 [extensions/xhs-publish-bridge/README.md](../extensions/xhs-publish-bridge/README.md) |
| 删除图稿 409 | 使用当前 API：会先解除组合草稿快照引用 |

更多排障见 [README.md §排障](../README.md#排障)。

---

## 九、相关文档

| 文档 | 路径 |
|------|------|
| 项目总览与功能 | [README.md](../README.md) |
| API 环境变量与路由 | [apps/api/README.md](../apps/api/README.md) |
| 发布扩展 | [extensions/xhs-publish-bridge/README.md](../extensions/xhs-publish-bridge/README.md) |
| 发布实施计划 | [plan-workbench-publish-first.md](./plan-workbench-publish-first.md) |
