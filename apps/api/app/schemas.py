from __future__ import annotations

import json
from datetime import datetime
from typing import Any, List, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.config import settings


class DraftImageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sort_order: int
    public_url: str
    is_cover: bool
    include_in_publish: bool
    source_copy_version_id: Optional[UUID] = None


class EntrySummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    updated_at: datetime


class EntryDetailOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    body: str
    topics: List[str] = Field(default_factory=list)
    updated_at: datetime
    images: List[DraftImageOut]
    selected_template_id: Optional[UUID] = None
    draft_image_pool_limit: int = Field(
        default_factory=lambda: settings.max_draft_images_per_entry,
        description="PRD §5.3：图稿池张数上限，与入池校验一致",
    )

    @field_validator("topics", mode="before")
    @classmethod
    def topics_coerce(cls, v: object) -> list[str]:
        if v is None:
            return []
        if isinstance(v, list):
            return [str(x) for x in v]
        return []


class EntryPatchIn(BaseModel):
    title: Optional[str] = Field(default=None, max_length=500)
    body: Optional[str] = None
    topics: Optional[List[str]] = None
    selected_template_id: Optional[UUID] = None

    @field_validator("topics")
    @classmethod
    def normalize_topics(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return None
        out: list[str] = []
        for raw in v[:35]:
            s = (raw or "").strip().lstrip("#").strip()
            if not s or "\n" in s or "\r" in s:
                continue
            if len(s) > 80:
                s = s[:80]
            out.append(s)
        return out


class DraftImageCreateIn(BaseModel):
    public_url: str = Field(..., min_length=1, max_length=8000)
    sort_order: Optional[int] = None
    is_cover: bool = False
    include_in_publish: bool = True
    source_copy_version_id: Optional[UUID] = None


class DraftImagePatchIn(BaseModel):
    sort_order: Optional[int] = None
    is_cover: Optional[bool] = None
    include_in_publish: Optional[bool] = None


class ImageReorderIn(BaseModel):
    ids: List[UUID]


class TemplateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    scenario: str
    structure_description: str
    enabled: bool
    copy_metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime

    @field_validator("copy_metadata", mode="before")
    @classmethod
    def copy_metadata_coerce(cls, v: object) -> dict[str, Any]:
        if v is None:
            return {}
        if isinstance(v, dict):
            return {str(k): v[k] for k in v}
        return {}


class TemplateCreateIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    scenario: str = ""
    structure_description: str = ""
    enabled: bool = True
    copy_metadata: dict[str, Any] = Field(default_factory=dict)

    @field_validator("copy_metadata", mode="before")
    @classmethod
    def copy_metadata_coerce(cls, v: object) -> dict[str, Any]:
        if v is None:
            return {}
        if isinstance(v, dict):
            return {str(k): v[k] for k in v}
        return {}


class TemplatePatchIn(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    scenario: Optional[str] = None
    structure_description: Optional[str] = None
    enabled: Optional[bool] = None
    copy_metadata: Optional[dict[str, Any]] = None


class CopyVersionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    body: str
    source: str
    is_primary: bool
    created_at: datetime


class CopyGenerateIn(BaseModel):
    """竞品材料仅作结构参考；禁止未授权抓取由产品约束，拉取失败时仍可仅模版生成。"""

    competitor_url: Optional[str] = Field(default=None, max_length=8000)
    competitor_paste: Optional[str] = None


class CopyVersionPatchIn(BaseModel):
    title: Optional[str] = Field(default=None, max_length=500)
    body: Optional[str] = None


class PublishedNoteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    body: str = ""
    official_url: Optional[str] = None
    views: Optional[int] = None
    click_rate_pct: Optional[float] = None
    watch_count: Optional[int] = None
    likes: Optional[int] = None
    favorites: Optional[int] = None
    comments: Optional[int] = None
    follower_gain: Optional[int] = None
    synced_at: datetime
    metrics_pending: bool


class PublishedNoteImportRow(BaseModel):
    title: str = Field(..., min_length=1, max_length=500)
    body: str = ""
    official_url: Optional[str] = Field(default=None, max_length=8000)
    views: Optional[int] = None
    click_rate_pct: Optional[float] = None
    watch_count: Optional[int] = None
    likes: Optional[int] = None
    favorites: Optional[int] = None
    comments: Optional[int] = None
    follower_gain: Optional[int] = None
    metrics_pending: bool = False


class PublishedNoteImportIn(BaseModel):
    items: List[PublishedNoteImportRow]


class SyncNotesResponse(BaseModel):
    imported_count: int
    message: str


class ComposedDraftCreateIn(BaseModel):
    entry_id: UUID
    snapshot_copy_version_id: UUID
    ordered_image_asset_ids: List[UUID] = Field(default_factory=list)
    cover_asset_id: Optional[UUID] = None


class ComposedDraftOut(BaseModel):
    id: UUID
    entry_id: UUID
    entry_title: str
    snapshot_copy_version_id: UUID
    snapshot_title: str
    snapshot_body: str = ""
    status: str
    created_at: datetime
    ordered_image_asset_ids: List[UUID]
    optional_cover_preview_url: Optional[str] = None

    @field_validator("ordered_image_asset_ids", mode="before")
    @classmethod
    def coerce_image_ids(cls, v: object) -> list[UUID]:
        if v is None:
            return []
        if not isinstance(v, list):
            return []
        out: list[UUID] = []
        for x in v:
            try:
                out.append(UUID(str(x)))
            except (ValueError, TypeError):
                continue
        return out


class OverviewTopNoteOut(BaseModel):
    """总览 Top 5 行（§5.8）。"""

    id: UUID
    title: str
    summary: str = ""
    views: Optional[int] = None
    official_url: Optional[str] = None
    metrics_pending: bool = False


class OverviewOut(BaseModel):
    """PRD §5.8 数据总览聚合。"""

    published_notes_total: int
    published_this_week_count: int
    quality_notes_count: int
    quality_views_threshold: int
    pending_composed_drafts_count: int
    week_range_mon_sun_label: str = ""
    top_notes: List[OverviewTopNoteOut] = Field(default_factory=list)


_MAX_PUBLISH_JSON_BYTES = 16_000


class PublishAttemptIn(BaseModel):
    """工作台发布一次点击后的观测记录（不含正文全文，避免冗余敏感数据）。"""

    outcome: str = Field(..., min_length=1, max_length=64)
    extension_error: Optional[str] = Field(default=None, max_length=4000)
    bridge_payload: Optional[dict[str, Any]] = None
    client_hints: Optional[dict[str, Any]] = Field(
        default=None,
        description="PRD §8 可选：客户端版本、屏幕等埋点上下文",
    )

    @field_validator("bridge_payload", "client_hints")
    @classmethod
    def _limit_json_size(cls, v: object) -> Optional[dict[str, Any]]:
        if v is None:
            return None
        if not isinstance(v, dict):
            raise ValueError("expected object")
        raw = json.dumps(v, ensure_ascii=False)
        if len(raw.encode("utf-8")) > _MAX_PUBLISH_JSON_BYTES:
            raise ValueError("json payload too large")
        return v


class PublishAttemptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    entry_id: UUID
    outcome: str
    extension_error: Optional[str] = None
    bridge_payload: Optional[dict[str, Any]] = None
    client_hints: Optional[dict[str, Any]] = None
    created_at: datetime


class CompetitorAnalyzeIn(BaseModel):
    urls: List[str] = Field(default_factory=list, description="待抓取的竞品链接列表（最多 25，分析取前 10）。")
    goal: Optional[str] = Field(default=None, max_length=2000, description="你想对齐/对标的目标（可选）。")
    audience: Optional[str] = Field(default=None, max_length=800, description="目标人群（可选）。")
    product: Optional[str] = Field(default=None, max_length=2000, description="你的产品/课程/服务简介（可选）。")

    @field_validator("urls")
    @classmethod
    def _normalize_urls(cls, v: List[str]) -> List[str]:
        out: list[str] = []
        for raw in (v or [])[:25]:
            s = (raw or "").strip()
            if not s:
                continue
            if len(s) > 8000:
                s = s[:8000]
            out.append(s)
        # 去重但保持顺序
        seen: set[str] = set()
        uniq: list[str] = []
        for u in out:
            if u in seen:
                continue
            seen.add(u)
            uniq.append(u)
        return uniq


class CompetitorPageOut(BaseModel):
    url: str
    ok: bool
    error: Optional[str] = None
    title: str = ""
    description: str = ""
    text_excerpt: str = ""
    text_len: int = 0


class CompetitorAnalyzeOut(BaseModel):
    fetched: List[CompetitorPageOut] = Field(default_factory=list)
    top10: List[CompetitorPageOut] = Field(default_factory=list, description="按启发式排序选出的 top10 竞品样本。")
    analysis_markdown: str = Field(default="", description="竞品 top10 分析（markdown 文本）。")
    generated_title: str = Field(default="", description="生成的新笔记标题。")
    generated_body: str = Field(default="", description="生成的新笔记正文。")


class XhsTopNoteIn(BaseModel):
    url: str = Field(..., min_length=1, max_length=8000)
    title: str = Field(..., min_length=1, max_length=200)
    author: Optional[str] = Field(default=None, max_length=120)
    excerpt: Optional[str] = Field(default=None, max_length=400)
    like_text: Optional[str] = Field(default=None, max_length=50)


class CompetitorAnalyzeXhsIn(BaseModel):
    keyword: str = Field(..., min_length=1, max_length=8000, description="关键词或主页/笔记 URL 等来源标识")
    items: List[XhsTopNoteIn] = Field(default_factory=list, description="从站内搜索页抓取的 top 笔记卡片信息。")
    goal: Optional[str] = Field(default=None, max_length=2000)
    audience: Optional[str] = Field(default=None, max_length=800)
    product: Optional[str] = Field(default=None, max_length=2000)
    entry_id: Optional[UUID] = Field(
        default=None,
        description="若提供则把本次分析结果写入该条目的历史记录（须为当前用户所有）。",
    )


class CompetitorAnalyzeXhsOut(BaseModel):
    keyword: str
    top10: List[XhsTopNoteIn] = Field(default_factory=list)
    analysis_markdown: str = ""
    generated_title: str = ""
    generated_body: str = ""
    saved_id: Optional[UUID] = Field(default=None, description="已落库的历史记录 id（仅当请求携带 entry_id 且校验通过时）。")


class CompetitorAnalysisHistoryOut(BaseModel):
    """单条竞品分析历史（与 analyze-xhs 输出字段对齐，便于前端回放）。"""

    id: UUID
    entry_id: UUID
    source_keyword: str = ""
    top10: List[XhsTopNoteIn] = Field(default_factory=list)
    analysis_markdown: str = ""
    generated_title: str = ""
    generated_body: str = ""
    created_at: datetime
