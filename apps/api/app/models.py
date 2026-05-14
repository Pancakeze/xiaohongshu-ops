from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text, func, text as sql_text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    entries: Mapped[list["Entry"]] = relationship(back_populates="owner", cascade="all, delete-orphan")
    templates: Mapped[list["Template"]] = relationship(back_populates="owner", cascade="all, delete-orphan")
    xhs_published_notes: Mapped[list["XhsPublishedNote"]] = relationship(
        back_populates="owner",
        cascade="all, delete-orphan",
    )
    google_image_sessions: Mapped[list["GoogleImageSession"]] = relationship(
        back_populates="owner",
        cascade="all, delete-orphan",
        order_by="GoogleImageSession.created_at.desc()",
    )


class Entry(Base):
    __tablename__ = "entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(500), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    topics: Mapped[list] = mapped_column(
        JSONB,
        nullable=False,
        server_default=sql_text("'[]'::jsonb"),
    )
    selected_template_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("templates.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    owner: Mapped["User"] = relationship(back_populates="entries")
    selected_template: Mapped[Optional["Template"]] = relationship(
        foreign_keys=[selected_template_id],
        back_populates="entries_selected",
    )
    copy_versions: Mapped[list["CopyVersion"]] = relationship(
        back_populates="entry",
        cascade="all, delete-orphan",
        foreign_keys="CopyVersion.entry_id",
        order_by="CopyVersion.created_at.desc()",
    )
    images: Mapped[list["DraftImage"]] = relationship(
        back_populates="entry",
        cascade="all, delete-orphan",
        order_by="DraftImage.sort_order",
    )
    composed_drafts: Mapped[list["ComposedDraft"]] = relationship(
        back_populates="entry",
        cascade="all, delete-orphan",
    )
    publish_attempts: Mapped[list["PublishAttempt"]] = relationship(
        back_populates="entry",
        cascade="all, delete-orphan",
        order_by="PublishAttempt.created_at.desc()",
    )
    competitor_analyses: Mapped[list["CompetitorAnalysisSnapshot"]] = relationship(
        back_populates="entry",
        cascade="all, delete-orphan",
        order_by="CompetitorAnalysisSnapshot.created_at.desc()",
    )


class CompetitorAnalysisSnapshot(Base):
    """竞品参考（站内 Top10）每次分析结果快照，按条目保留。"""

    __tablename__ = "competitor_analysis_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("entries.id", ondelete="CASCADE"),
        index=True,
    )
    source_keyword: Mapped[str] = mapped_column(Text, default="", nullable=False)
    top10_items: Mapped[list] = mapped_column(
        JSONB,
        nullable=False,
        server_default=sql_text("'[]'::jsonb"),
    )
    analysis_markdown: Mapped[str] = mapped_column(Text, default="", nullable=False)
    generated_title: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    generated_body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    entry: Mapped["Entry"] = relationship(back_populates="competitor_analyses")


class Template(Base):
    """PRD §5.10：文案模版；名称、适用场景、段落结构说明、启用/停用、复制用元数据。"""

    __tablename__ = "templates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    scenario: Mapped[str] = mapped_column(Text, default="", nullable=False)
    structure_description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    copy_metadata: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        server_default=sql_text("'{}'::jsonb"),
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    owner: Mapped["User"] = relationship(back_populates="templates")
    entries_selected: Mapped[list["Entry"]] = relationship(
        back_populates="selected_template",
        foreign_keys="Entry.selected_template_id",
    )


class CopyVersion(Base):
    """PRD §5.6: 文案版本；主版本由 is_primary 标记（每 entry 至多一条）。"""

    __tablename__ = "copy_versions"
    __table_args__ = (
        Index(
            "uq_copy_version_one_primary_per_entry",
            "entry_id",
            unique=True,
            postgresql_where=sql_text("is_primary"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("entries.id", ondelete="CASCADE"),
        index=True,
    )
    title: Mapped[str] = mapped_column(String(500), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    # 生成 / 人工 — 存英文枚举便于查询；展示层可映射 PRD 文案
    source: Mapped[str] = mapped_column(String(32), default="manual", nullable=False)
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    entry: Mapped["Entry"] = relationship(
        back_populates="copy_versions",
        foreign_keys=[entry_id],
    )
    images_sourced_from: Mapped[list["DraftImage"]] = relationship(
        back_populates="source_copy_version",
        foreign_keys="DraftImage.source_copy_version_id",
    )


class DraftImage(Base):
    __tablename__ = "draft_images"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entry_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("entries.id", ondelete="CASCADE"), index=True)
    source_copy_version_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("copy_versions.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    public_url: Mapped[str] = mapped_column(Text, nullable=False)
    is_cover: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    include_in_publish: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    entry: Mapped["Entry"] = relationship(back_populates="images")
    source_copy_version: Mapped[Optional["CopyVersion"]] = relationship(
        back_populates="images_sourced_from",
        foreign_keys=[source_copy_version_id],
    )


class XhsPublishedNote(Base):
    """PRD §5.9：小红书已发布历史笔记（指标可手工导入 / 待补数）。"""

    __tablename__ = "xhs_published_notes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    title: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    body: Mapped[str] = mapped_column(Text, default="", nullable=False)
    official_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    views: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    click_rate_pct: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    watch_count: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    likes: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    favorites: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    comments: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    follower_gain: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    metrics_pending: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    owner: Mapped["User"] = relationship(back_populates="xhs_published_notes")


class ComposedDraft(Base):
    """PRD §5.6 / §5.9: 组合笔记草稿，持不可变快照（文案版本 + 图稿顺序 + 封面）。"""

    __tablename__ = "composed_drafts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("entries.id", ondelete="CASCADE"),
        index=True,
    )
    snapshot_copy_version_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("copy_versions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    ordered_image_asset_ids: Mapped[list] = mapped_column(
        JSONB,
        nullable=False,
        server_default=sql_text("'[]'::jsonb"),
    )
    cover_asset_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("draft_images.id", ondelete="RESTRICT"),
        nullable=True,
    )
    optional_cover_preview_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # copy_only ≈ 仅文案；images_ready ≈ 图文齐全
    status: Mapped[str] = mapped_column(String(32), default="copy_only", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    entry: Mapped["Entry"] = relationship(back_populates="composed_drafts")
    snapshot_copy_version: Mapped["CopyVersion"] = relationship(
        foreign_keys=[snapshot_copy_version_id],
    )


class PublishAttempt(Base):
    """P1 观测：发布桥接尝试（扩展成功 / 降级剪贴板 / 仅错误），便于排障与可选埋点。"""

    __tablename__ = "publish_attempts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entry_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("entries.id", ondelete="CASCADE"),
        index=True,
    )
    outcome: Mapped[str] = mapped_column(String(64), nullable=False)
    extension_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    bridge_payload: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    client_hints: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    entry: Mapped["Entry"] = relationship(back_populates="publish_attempts")


class GoogleImageSession(Base):
    """Google Gemini 网页生图会话（绑定 owner + 复用浏览器上下文的抽象）。"""

    __tablename__ = "google_image_sessions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    status: Mapped[str] = mapped_column(String(32), default="active", nullable=False)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    owner: Mapped["User"] = relationship(back_populates="google_image_sessions")
    turns: Mapped[list["GoogleImageTurn"]] = relationship(
        back_populates="session",
        cascade="all, delete-orphan",
        order_by="GoogleImageTurn.created_at.asc()",
    )


class GoogleImageTurn(Base):
    """会话内一轮输入/输出（prompt + 参数 + 结果摘要/错误）。"""

    __tablename__ = "google_image_turns"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    session_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("google_image_sessions.id", ondelete="CASCADE"),
        index=True,
    )
    prompt: Mapped[str] = mapped_column(Text, default="", nullable=False)
    params: Mapped[dict] = mapped_column(
        JSONB,
        nullable=False,
        server_default=sql_text("'{}'::jsonb"),
    )
    result_summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    session: Mapped["GoogleImageSession"] = relationship(back_populates="turns")
    assets: Mapped[list["GoogleImageAsset"]] = relationship(
        back_populates="turn",
        cascade="all, delete-orphan",
        order_by="GoogleImageAsset.created_at.asc()",
    )


class GoogleImageAsset(Base):
    """单张生成图片资源（本地文件 + 可选 public_url）。"""

    __tablename__ = "google_image_assets"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    turn_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("google_image_turns.id", ondelete="CASCADE"),
        index=True,
    )
    local_path: Mapped[str] = mapped_column(Text, nullable=False)
    public_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    width: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    height: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    turn: Mapped["GoogleImageTurn"] = relationship(back_populates="assets")
