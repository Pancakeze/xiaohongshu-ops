from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+psycopg://xhs:xhs@127.0.0.1:5432/xiaohongshu"
    api_bearer_token: str = "dev-change-me"
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    # 本地上传图存储目录（相对 uvicorn cwd 或绝对路径）
    upload_dir: str = "data/uploads"
    # 写入 DB 的 public_url 前缀（扩展拉首图需可访问）
    public_base_url: str = "http://127.0.0.1:8000"
    # PRD §5.8：优质笔记浏览量阈值；「本周」按此时区的自然周 Mon–Sun 统计 synced_at
    overview_quality_views_threshold: int = 10_000
    overview_week_timezone: str = "Asia/Shanghai"
    # PRD 阶段 5：服务端 Ollama；禁止向前端下发模型名/基址（仅服务端读取）
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_copy_model: str = "qwen2.5-coder:14b"
    ollama_timeout_seconds: float = 120.0
    # PRD §5.3 / 原型：单条目图稿池上限（可配置）
    max_draft_images_per_entry: int = 18

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def upload_path(self) -> Path:
        p = Path(self.upload_dir)
        return p if p.is_absolute() else (Path.cwd() / p).resolve()


settings = Settings()
