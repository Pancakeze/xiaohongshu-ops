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
    # Google Gemini 网页生图落盘目录（相对 uvicorn cwd 或绝对路径）
    google_generated_dir: str = "data/generated/google"
    # Google Gemini 网页自动化：Chrome 用户数据目录（用于复用已登录态）
    # - 不设置时，默认使用项目内 data/google_profile/{user_id}
    # - 若你想复用“正版 Chrome 且已登录 gemini 的本机资料”，macOS 可设置为：
    #   ~/Library/Application Support/Google/Chrome
    google_chrome_user_data_dir: str = ""
    # 指定 Chrome profile（Default / Profile 1 / ...）；为空则使用浏览器默认选择
    google_chrome_profile_dir: str = ""
    # 连接「已手动启动」的正式 Chrome（Chrome DevTools Protocol），避免在 Playwright 新开的窗口里登录被谷歌拦截。
    # 示例：先在本机终端启动 Chrome：
    #   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
    #     --remote-debugging-port=9222 --user-data-dir="$HOME/Library/Application Support/Google/Chrome-debug-xhs"
    # 在窗口里正常登录 https://gemini.google.com/ 后，再设：
    #   GOOGLE_CHROME_CDP_URL=http://127.0.0.1:9222
    google_chrome_cdp_url: str = ""
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

    @property
    def google_generated_path(self) -> Path:
        p = Path(self.google_generated_dir)
        return p if p.is_absolute() else (Path.cwd() / p).resolve()

    @property
    def google_chrome_user_data_path(self) -> Path | None:
        raw = (self.google_chrome_user_data_dir or "").strip()
        if not raw:
            return None
        p = Path(raw).expanduser()
        return p if p.is_absolute() else (Path.cwd() / p).resolve()

    @property
    def google_chrome_cdp_url_normalized(self) -> str | None:
        s = (self.google_chrome_cdp_url or "").strip()
        return s or None


settings = Settings()
