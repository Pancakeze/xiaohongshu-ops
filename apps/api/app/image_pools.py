"""图稿池（DraftImagePool）辅助：每组最多 max_draft_images_per_entry 张。"""

from __future__ import annotations

from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.models import DraftImage, DraftImagePool, Entry


def draft_image_count_in_pool(db: Session, pool_id: UUID) -> int:
    n = db.scalar(select(func.count()).select_from(DraftImage).where(DraftImage.pool_id == pool_id))
    return int(n or 0)


def ensure_image_pool_has_room(db: Session, pool_id: UUID, *, adding: int = 1) -> None:
    cap = settings.max_draft_images_per_entry
    if draft_image_count_in_pool(db, pool_id) + adding > cap:
        raise HTTPException(status_code=400, detail="draft_image_pool_full")


def get_owned_pool(db: Session, entry_id: UUID, pool_id: UUID) -> DraftImagePool:
    pool = db.scalar(
        select(DraftImagePool).where(
            DraftImagePool.id == pool_id,
            DraftImagePool.entry_id == entry_id,
        )
    )
    if pool is None:
        raise HTTPException(status_code=404, detail="image_pool_not_found")
    return pool


def ensure_default_pool(db: Session, entry_id: UUID) -> DraftImagePool:
    """条目至少有一个图稿池；无则创建「默认图稿池」。"""
    pool = db.scalar(
        select(DraftImagePool)
        .where(DraftImagePool.entry_id == entry_id)
        .order_by(DraftImagePool.sort_order.asc(), DraftImagePool.created_at.asc())
    )
    if pool is not None:
        return pool
    pool = DraftImagePool(entry_id=entry_id, name="默认图稿池", sort_order=0)
    db.add(pool)
    db.flush()
    return pool


def resolve_pool_id(db: Session, entry_id: UUID, pool_id: UUID | None) -> UUID:
    if pool_id is not None:
        return get_owned_pool(db, entry_id, pool_id).id
    return ensure_default_pool(db, entry_id).id


def next_image_sort_order(db: Session, pool_id: UUID) -> int:
    max_ord = db.scalar(select(func.max(DraftImage.sort_order)).where(DraftImage.pool_id == pool_id))
    return (max_ord + 1) if max_ord is not None else 0


def touch_entry_by_pool(db: Session, pool: DraftImagePool) -> None:
    from datetime import datetime, timezone

    entry = db.get(Entry, pool.entry_id)
    if entry is not None:
        entry.updated_at = datetime.now(timezone.utc)
