"""启动时轻量补列 / 补表（无 Alembic 时的 dev 友好方案）。"""

from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.database import engine


def ensure_entry_topics_column() -> None:
    if engine.dialect.name != "postgresql":
        return
    insp = inspect(engine)
    if "entries" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("entries")}
    if "topics" in cols:
        return
    with engine.begin() as conn:
        conn.execute(
            text("ALTER TABLE entries ADD COLUMN topics JSONB NOT NULL DEFAULT '[]'::jsonb")
        )


def ensure_v12_domain_schema() -> None:
    """PRD §5.6：CopyVersion（含 is_primary）、composed_drafts、draft_images.source_copy_version_id。

    若曾创建过 entries.primary_copy_version_id（旧迭代），在此清理以避免与 is_primary 双轨。
    """
    if engine.dialect.name != "postgresql":
        return
    insp = inspect(engine)
    tables = set(insp.get_table_names())

    with engine.begin() as conn:
        insp_conn = inspect(conn)
        if "copy_versions" not in tables:
            conn.execute(
                text(
                    """
                    CREATE TABLE copy_versions (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        entry_id UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                        title VARCHAR(500) NOT NULL DEFAULT '',
                        body TEXT NOT NULL DEFAULT '',
                        source VARCHAR(32) NOT NULL DEFAULT 'manual',
                        is_primary BOOLEAN NOT NULL DEFAULT false,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_copy_versions_entry_id ON copy_versions (entry_id)"))
            conn.execute(
                text(
                    """
                    CREATE UNIQUE INDEX uq_copy_version_one_primary_per_entry
                    ON copy_versions (entry_id)
                    WHERE is_primary
                    """
                )
            )

        cols_cv = (
            {c["name"] for c in insp_conn.get_columns("copy_versions")}
            if "copy_versions" in insp_conn.get_table_names()
            else set()
        )
        if "copy_versions" in insp_conn.get_table_names() and "is_primary" not in cols_cv:
            conn.execute(
                text("ALTER TABLE copy_versions ADD COLUMN is_primary BOOLEAN NOT NULL DEFAULT false")
            )
            conn.execute(
                text(
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS uq_copy_version_one_primary_per_entry
                    ON copy_versions (entry_id)
                    WHERE is_primary
                    """
                )
            )

        cols_entries = (
            {c["name"] for c in insp_conn.get_columns("entries")} if "entries" in insp_conn.get_table_names() else set()
        )
        if "entries" in insp_conn.get_table_names() and "primary_copy_version_id" in cols_entries:
            conn.execute(text("ALTER TABLE entries DROP CONSTRAINT IF EXISTS fk_entries_primary_copy_version"))
            conn.execute(text("ALTER TABLE entries DROP COLUMN primary_copy_version_id"))

        cols_di = (
            {c["name"] for c in insp_conn.get_columns("draft_images")}
            if "draft_images" in insp_conn.get_table_names()
            else set()
        )
        if "draft_images" in insp_conn.get_table_names() and "source_copy_version_id" not in cols_di:
            conn.execute(text("ALTER TABLE draft_images ADD COLUMN source_copy_version_id UUID NULL"))
            conn.execute(
                text(
                    """
                    ALTER TABLE draft_images
                    ADD CONSTRAINT fk_draft_images_source_copy_version
                    FOREIGN KEY (source_copy_version_id)
                    REFERENCES copy_versions(id)
                    ON DELETE SET NULL
                    """
                )
            )
            conn.execute(
                text("CREATE INDEX ix_draft_images_source_copy_version_id ON draft_images (source_copy_version_id)")
            )

        if "composed_drafts" not in set(insp_conn.get_table_names()):
            conn.execute(
                text(
                    """
                    CREATE TABLE composed_drafts (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        entry_id UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                        snapshot_copy_version_id UUID NOT NULL REFERENCES copy_versions(id) ON DELETE RESTRICT,
                        ordered_image_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                        cover_asset_id UUID REFERENCES draft_images(id) ON DELETE RESTRICT,
                        optional_cover_preview_url TEXT,
                        status VARCHAR(32) NOT NULL DEFAULT 'copy_only',
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_composed_drafts_entry_id ON composed_drafts (entry_id)"))
            conn.execute(
                text(
                    "CREATE INDEX ix_composed_drafts_snapshot_copy_version_id ON composed_drafts (snapshot_copy_version_id)"
                )
            )


def ensure_templates_schema() -> None:
    """PRD §5.10：templates 表；entries.selected_template_id（当前条目所选模版）。"""
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as conn:
        insp_conn = inspect(conn)
        tables = set(insp_conn.get_table_names())
        if "templates" not in tables:
            conn.execute(
                text(
                    """
                    CREATE TABLE templates (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        name VARCHAR(200) NOT NULL,
                        scenario TEXT NOT NULL DEFAULT '',
                        structure_description TEXT NOT NULL DEFAULT '',
                        enabled BOOLEAN NOT NULL DEFAULT true,
                        copy_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_templates_owner_id ON templates (owner_id)"))
        cols_entries = (
            {c["name"] for c in insp_conn.get_columns("entries")} if "entries" in insp_conn.get_table_names() else set()
        )
        if "entries" in insp_conn.get_table_names() and "selected_template_id" not in cols_entries:
            conn.execute(text("ALTER TABLE entries ADD COLUMN selected_template_id UUID NULL"))
            conn.execute(
                text(
                    """
                    ALTER TABLE entries
                    ADD CONSTRAINT fk_entries_selected_template
                    FOREIGN KEY (selected_template_id)
                    REFERENCES templates(id)
                    ON DELETE SET NULL
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_entries_selected_template_id ON entries (selected_template_id)"))


def ensure_xhs_published_notes_schema() -> None:
    """PRD §5.9：小红书历史笔记（手工导入指标）。"""
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as conn:
        insp_conn = inspect(conn)
        tables = set(insp_conn.get_table_names())
        if "xhs_published_notes" not in tables:
            conn.execute(
                text(
                    """
                    CREATE TABLE xhs_published_notes (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        title VARCHAR(500) NOT NULL DEFAULT '',
                        body TEXT NOT NULL DEFAULT '',
                        official_url TEXT,
                        views INTEGER,
                        click_rate_pct DOUBLE PRECISION,
                        watch_count INTEGER,
                        likes INTEGER,
                        favorites INTEGER,
                        comments INTEGER,
                        follower_gain INTEGER,
                        synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        metrics_pending BOOLEAN NOT NULL DEFAULT false
                    )
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_xhs_published_notes_owner_id ON xhs_published_notes (owner_id)"))
        insp_conn = inspect(conn)
        cols_xhs = (
            {c["name"] for c in insp_conn.get_columns("xhs_published_notes")}
            if "xhs_published_notes" in insp_conn.get_table_names()
            else set()
        )
        if "xhs_published_notes" in insp_conn.get_table_names() and "body" not in cols_xhs:
            conn.execute(
                text("ALTER TABLE xhs_published_notes ADD COLUMN body TEXT NOT NULL DEFAULT ''")
            )


def ensure_publish_attempts_schema() -> None:
    """P0 并行硬化：PublishAttempt 观测表（扩展 / 剪贴板降级）。"""
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as conn:
        insp_conn = inspect(conn)
        tables = set(insp_conn.get_table_names())
        if "publish_attempts" not in tables:
            conn.execute(
                text(
                    """
                    CREATE TABLE publish_attempts (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        entry_id UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                        outcome VARCHAR(64) NOT NULL,
                        extension_error TEXT,
                        bridge_payload JSONB,
                        client_hints JSONB,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_publish_attempts_entry_id ON publish_attempts (entry_id)"))
            conn.execute(text("CREATE INDEX ix_publish_attempts_created_at ON publish_attempts (created_at DESC)"))


def ensure_google_image_schema() -> None:
    """Google Gemini 网页生图：sessions / turns / assets（dev 环境无 Alembic 时确保建表）。"""
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as conn:
        insp_conn = inspect(conn)
        tables = set(insp_conn.get_table_names())

        if "google_image_sessions" not in tables:
            conn.execute(
                text(
                    """
                    CREATE TABLE google_image_sessions (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        status VARCHAR(32) NOT NULL DEFAULT 'active',
                        last_error TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_google_image_sessions_owner_id ON google_image_sessions (owner_id)"))
            conn.execute(text("CREATE INDEX ix_google_image_sessions_created_at ON google_image_sessions (created_at DESC)"))

        insp_conn = inspect(conn)
        tables = set(insp_conn.get_table_names())

        if "google_image_turns" not in tables:
            conn.execute(
                text(
                    """
                    CREATE TABLE google_image_turns (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        session_id UUID NOT NULL REFERENCES google_image_sessions(id) ON DELETE CASCADE,
                        prompt TEXT NOT NULL DEFAULT '',
                        params JSONB NOT NULL DEFAULT '{}'::jsonb,
                        result_summary TEXT NOT NULL DEFAULT '',
                        last_error TEXT,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_google_image_turns_session_id ON google_image_turns (session_id)"))
            conn.execute(text("CREATE INDEX ix_google_image_turns_created_at ON google_image_turns (created_at ASC)"))

        if "google_image_assets" not in tables:
            conn.execute(
                text(
                    """
                    CREATE TABLE google_image_assets (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        turn_id UUID NOT NULL REFERENCES google_image_turns(id) ON DELETE CASCADE,
                        local_path TEXT NOT NULL,
                        public_url TEXT,
                        width INTEGER,
                        height INTEGER,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_google_image_assets_turn_id ON google_image_assets (turn_id)"))


def ensure_draft_image_pools_schema() -> None:
    """条目内多图稿池分组；draft_images.pool_id。"""
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as conn:
        insp_conn = inspect(conn)
        tables = set(insp_conn.get_table_names())

        if "draft_image_pools" not in tables:
            conn.execute(
                text(
                    """
                    CREATE TABLE draft_image_pools (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        entry_id UUID NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
                        name VARCHAR(120) NOT NULL DEFAULT '图稿池',
                        sort_order INTEGER NOT NULL DEFAULT 0,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_draft_image_pools_entry_id ON draft_image_pools (entry_id)"))

        insp_conn = inspect(conn)
        cols_di = (
            {c["name"] for c in insp_conn.get_columns("draft_images")}
            if "draft_images" in insp_conn.get_table_names()
            else set()
        )
        if "draft_images" in insp_conn.get_table_names() and "pool_id" not in cols_di:
            conn.execute(text("ALTER TABLE draft_images ADD COLUMN pool_id UUID NULL"))
            conn.execute(
                text(
                    """
                    INSERT INTO draft_image_pools (id, entry_id, name, sort_order)
                    SELECT gen_random_uuid(), e.id, '默认图稿池', 0
                    FROM entries e
                    WHERE NOT EXISTS (
                        SELECT 1 FROM draft_image_pools p WHERE p.entry_id = e.id
                    )
                    """
                )
            )
            conn.execute(
                text(
                    """
                    UPDATE draft_images di
                    SET pool_id = (
                        SELECT p.id FROM draft_image_pools p
                        WHERE p.entry_id = di.entry_id
                        ORDER BY p.sort_order ASC, p.created_at ASC
                        LIMIT 1
                    )
                    WHERE di.pool_id IS NULL
                    """
                )
            )
            conn.execute(
                text(
                    """
                    ALTER TABLE draft_images
                    ADD CONSTRAINT fk_draft_images_pool
                    FOREIGN KEY (pool_id)
                    REFERENCES draft_image_pools(id)
                    ON DELETE CASCADE
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_draft_images_pool_id ON draft_images (pool_id)"))
            conn.execute(text("ALTER TABLE draft_images ALTER COLUMN pool_id SET NOT NULL"))


def ensure_draft_folders_schema() -> None:
    """笔记管理：组合草稿二级分类目录 + composed_drafts.folder_id。"""
    if engine.dialect.name != "postgresql":
        return
    with engine.begin() as conn:
        insp_conn = inspect(conn)
        tables = set(insp_conn.get_table_names())
        if "draft_folders" not in tables:
            conn.execute(
                text(
                    """
                    CREATE TABLE draft_folders (
                        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                        owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                        parent_id UUID REFERENCES draft_folders(id) ON DELETE CASCADE,
                        name VARCHAR(100) NOT NULL,
                        sort_order INTEGER NOT NULL DEFAULT 0,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_draft_folders_owner_id ON draft_folders (owner_id)"))
            conn.execute(text("CREATE INDEX ix_draft_folders_parent_id ON draft_folders (parent_id)"))

        insp_conn = inspect(conn)
        cols_cd = (
            {c["name"] for c in insp_conn.get_columns("composed_drafts")}
            if "composed_drafts" in insp_conn.get_table_names()
            else set()
        )
        if "composed_drafts" in insp_conn.get_table_names() and "folder_id" not in cols_cd:
            conn.execute(text("ALTER TABLE composed_drafts ADD COLUMN folder_id UUID NULL"))
            conn.execute(
                text(
                    """
                    ALTER TABLE composed_drafts
                    ADD CONSTRAINT fk_composed_drafts_folder
                    FOREIGN KEY (folder_id)
                    REFERENCES draft_folders(id)
                    ON DELETE SET NULL
                    """
                )
            )
            conn.execute(text("CREATE INDEX ix_composed_drafts_folder_id ON composed_drafts (folder_id)"))

        insp_conn = inspect(conn)
        cols_cd2 = (
            {c["name"] for c in insp_conn.get_columns("composed_drafts")}
            if "composed_drafts" in insp_conn.get_table_names()
            else set()
        )
        if "composed_drafts" in insp_conn.get_table_names():
            if "snapshot_title" not in cols_cd2:
                conn.execute(text("ALTER TABLE composed_drafts ADD COLUMN snapshot_title TEXT NULL"))
            if "snapshot_body" not in cols_cd2:
                conn.execute(text("ALTER TABLE composed_drafts ADD COLUMN snapshot_body TEXT NULL"))
            conn.execute(
                text(
                    """
                    UPDATE composed_drafts cd
                    SET snapshot_title = cv.title,
                        snapshot_body = COALESCE(cv.body, '')
                    FROM copy_versions cv
                    WHERE cd.snapshot_copy_version_id = cv.id
                      AND cd.snapshot_title IS NULL
                    """
                )
            )


def backfill_primary_copy_versions(db: Session) -> None:
    """每条 Entry 至少一条主文案 CopyVersion（is_primary=true）；幂等。"""
    from sqlalchemy import select

    from app.models import CopyVersion, Entry

    entries = list(db.scalars(select(Entry)).all())
    touched = False
    for entry in entries:
        primary = db.scalar(
            select(CopyVersion).where(
                CopyVersion.entry_id == entry.id,
                CopyVersion.is_primary.is_(True),
            )
        )
        if primary is not None:
            continue
        versions = list(
            db.scalars(
                select(CopyVersion)
                .where(CopyVersion.entry_id == entry.id)
                .order_by(CopyVersion.created_at.desc())
            ).all()
        )
        if versions:
            chosen = versions[0]
            for v in versions:
                v.is_primary = v.id == chosen.id
            touched = True
            continue
        cv = CopyVersion(
            entry_id=entry.id,
            title=entry.title or "",
            body=entry.body or "",
            source="manual",
            is_primary=True,
        )
        db.add(cv)
        touched = True
    if touched:
        db.commit()
