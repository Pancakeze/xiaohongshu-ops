"""组合草稿快照对图稿的引用（PRD §5.3 / §七：快照引用则禁止物理删除）。"""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models import ComposedDraft


def _parse_asset_id(raw: object) -> UUID | None:
    try:
        return UUID(str(raw))
    except (TypeError, ValueError):
        return None


def locked_image_ids_for_entry(db: Session, entry_id: UUID) -> set[UUID]:
    """该条目下被任意组合草稿快照引用的图稿 id（含封面与顺序列表）。"""
    locked: set[UUID] = set()
    rows = db.scalars(select(ComposedDraft).where(ComposedDraft.entry_id == entry_id)).all()
    for row in rows:
        if row.cover_asset_id is not None:
            locked.add(row.cover_asset_id)
        for raw in row.ordered_image_asset_ids or []:
            uid = _parse_asset_id(raw)
            if uid is not None:
                locked.add(uid)
    return locked


def draft_image_referenced_in_composed_snapshots(db: Session, *, entry_id: UUID, image_id: UUID) -> bool:
    return image_id in locked_image_ids_for_entry(db, entry_id)


def unlink_image_from_composed_snapshots(db: Session, *, entry_id: UUID, image_id: UUID) -> int:
    """从本条目所有组合草稿快照中移除对该图稿的引用，便于随后物理删除。返回更新的草稿数。"""
    sid = str(image_id)
    rows = db.scalars(select(ComposedDraft).where(ComposedDraft.entry_id == entry_id)).all()
    updated = 0
    for row in rows:
        changed = False
        if row.cover_asset_id == image_id:
            row.cover_asset_id = None
            changed = True
        raw_ids = list(row.ordered_image_asset_ids or [])
        filtered = [x for x in raw_ids if str(x) != sid]
        if len(filtered) != len(raw_ids):
            row.ordered_image_asset_ids = filtered
            flag_modified(row, "ordered_image_asset_ids")
            changed = True
        if changed:
            row.updated_at = datetime.now(timezone.utc)
            updated += 1
    return updated
