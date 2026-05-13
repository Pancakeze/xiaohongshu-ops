"""组合草稿快照对图稿的引用（PRD §5.3 / §七：快照引用则禁止物理删除）。"""

from __future__ import annotations

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ComposedDraft


def draft_image_referenced_in_composed_snapshots(db: Session, *, entry_id: UUID, image_id: UUID) -> bool:
    sid = str(image_id)
    rows = db.scalars(select(ComposedDraft).where(ComposedDraft.entry_id == entry_id)).all()
    for row in rows:
        if row.cover_asset_id == image_id:
            return True
        raw_ids = row.ordered_image_asset_ids
        if not raw_ids:
            continue
        for x in raw_ids:
            if str(x) == sid:
                return True
    return False
