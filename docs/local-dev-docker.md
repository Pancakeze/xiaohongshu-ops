# Docker 本地全栈启动

除 [local-dev.md](./local-dev.md) 中的「本机 Python + npm」方式外，可用 Docker Compose 启动 **PostgreSQL + API + 前端（Vite 热更新）**。

Chrome 发布扩展、Google 生图（本机 Chrome CDP）仍建议在宿主机使用，见文末说明。

---

## 环境要求

- Docker Desktop（或 Docker Engine + Compose v2）
- 可选：宿主机 [Ollama](https://ollama.com/)（文案生成，容器通过 `host.docker.internal` 访问）

---

## 首次准备

```bash
# 仓库根目录
cp .env.docker.example .env.docker
# 按需改 API_BEARER_TOKEN、OLLAMA_BASE_URL 等

mkdir -p data/uploads data/generated/google
```

---

## 启动方式

### 仅数据库（与原先一致）

```bash
docker compose up -d
```

只启动 PostgreSQL，前后端仍在宿主机用 venv / npm 运行（见 [local-dev.md](./local-dev.md)）。

### 全栈开发（推荐 Docker 联调）

```bash
docker compose --profile app up --build
```

| 服务 | 地址 |
|------|------|
| 前端（Vite HMR） | http://127.0.0.1:5173 |
| API | http://127.0.0.1:8000 |
| API 文档 | http://127.0.0.1:8000/docs |
| PostgreSQL | 127.0.0.1:5432 |

或使用 npm 脚本：

```bash
npm run dev:docker
```

停止：

```bash
npm run dev:docker:down
# 或
docker compose --profile app down
```

### 前端静态构建 + Nginx（演示）

```bash
docker compose --profile static up --build
```

| 服务 | 地址 |
|------|------|
| 前端（Nginx） | http://127.0.0.1:8080 |
| API | http://127.0.0.1:8000 |

Nginx 将 `/api`、`/health` 反代到 `api` 容器；浏览器访问 8080 即可，无需 Vite。

---

## 配置说明

根目录 **`.env.docker`**（由 `.env.docker.example` 复制）供 Compose 读取，主要变量：

| 变量 | 说明 |
|------|------|
| `API_BEARER_TOKEN` | 与前端 `VITE_API_BEARER_TOKEN` 一致 |
| `DATABASE_URL` | 容器内须用主机名 `postgres`，示例已写在 example 中 |
| `PUBLIC_BASE_URL` | 浏览器访问 API 的地址，默认 `http://127.0.0.1:8000` |
| `OLLAMA_BASE_URL` | 默认 `http://host.docker.internal:11434` |
| `GOOGLE_CHROME_CDP_URL` | 可选，指向宿主机 Chrome 调试端口 |

上传与生图文件落在仓库 **`data/`** 目录（挂载到 API 容器 `/app/data`）。

---

## 架构

```
浏览器 :5173  →  web (Vite)  ──proxy /api──►  api:8000
                                              │
                                              ▼
                                         postgres:5432
```

---

## 与宿主机混合使用

| 能力 | Docker 全栈 | 说明 |
|------|-------------|------|
| 运营台 + API + DB | ✅ | `--profile app` |
| 文案 Ollama | ✅ | 宿主机起 Ollama，勿改默认 `OLLAMA_BASE_URL` |
| 发布 Chrome 扩展 | ❌ | 仍在宿主机 Chrome 加载 `extensions/xhs-publish-bridge/dist` |
| Google 生图 | ⚠️ | 建议在 `.env.docker` 配置 `GOOGLE_CHROME_CDP_URL=http://host.docker.internal:9222`，宿主机先启动带调试端口的 Chrome |

---

## 排障

| 现象 | 处理 |
|------|------|
| `web` 启动后 5173 无法访问 | 确认 `VITE_DEV_HOST=0.0.0.0` 已在 compose 中设置 |
| API 连不上数据库 | 等 `postgres` healthy；`DATABASE_URL` 主机名必须是 `postgres` |
| 401 | `API_BEARER_TOKEN` 与前端环境变量一致 |
| Ollama 502 | 宿主机执行 `ollama serve`；Linux 需 `extra_hosts: host.docker.internal`（compose 已配） |
| 改前端依赖不生效 | 重建 web：`docker compose --profile app build web` |

---

## 相关文件

| 文件 | 说明 |
|------|------|
| `docker-compose.yml` | `postgres` + profile `app`（api/web）+ profile `static`（web-static） |
| `apps/api/Dockerfile` | API 镜像 |
| `apps/web/Dockerfile.dev` | Vite 开发镜像 |
| `apps/web/Dockerfile` | 构建 + Nginx 生产演示镜像 |
| `.env.docker.example` | Compose 环境变量模板 |
