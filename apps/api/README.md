# 运营台 API（FastAPI + PostgreSQL）

## 环境变量

复制仓库根目录 `.env.example` 为 `apps/api/.env` 并按需修改：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | SQLAlchemy URL，默认 `postgresql+psycopg://xhs:xhs@127.0.0.1:5432/xiaohongshu` |
| `API_BEARER_TOKEN` | 演示用 Bearer Token，与 `apps/web/.env` 中 `VITE_API_BEARER_TOKEN` 一致 |
| `CORS_ORIGINS` | 逗号分隔的前端 origin |
| `UPLOAD_DIR` | 本地上传图片目录（相对 `uvicorn` 工作目录或绝对路径），默认 `data/uploads` |
| `PUBLIC_BASE_URL` | 上传后 `DraftImage.public_url` 的前缀，默认 `http://127.0.0.1:8000`（与扩展允许的本地 HTTP 一致；生产请改为可公网访问的 HTTPS） |

需要 **Python 3.9+**（推荐 3.11+）。

## 本地运行

```bash
# 1. 启动数据库（仓库根目录）
docker compose up -d

# 2. Python 虚拟环境
cd apps/api
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# 3.（可选）复制 .env
cp ../../.env.example .env

# 4. 启动 API
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

- 健康检查：<http://127.0.0.1:8000/health>
- OpenAPI：<http://127.0.0.1:8000/docs>

## 认证（MVP）

请求头：`Authorization: Bearer <API_BEARER_TOKEN>`。

启动时会种子 `demo@local` 用户及一条空草稿条目。

## 路由前缀

业务接口均在 `/api/entries/...`。

### 条目字段（节选）

- **`GET/PATCH /api/entries/{id}`**：详情中含 **`topics`**（`string[]`），表示运营台维护的话题词；**`PATCH`** 可传 **`topics`** 覆盖。首次拉老库时启动会自动执行 `ALTER TABLE … ADD COLUMN topics`（仅 PostgreSQL）。
- 运营台发布到小红书时，会把话题格式化为 **`#词`** 追加进发给扩展的**正文**（正文字段本身不含 `#`，便于本地编辑）。

