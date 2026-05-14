from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.deps import get_current_user
from app.models import ComposedDraft, CopyVersion, DraftImage, Entry, User, XhsPublishedNote
from app.schemas import (
    ComposedDraftCreateIn,
    ComposedDraftOut,
    PublishedNoteImportIn,
    PublishedNoteOut,
    SyncNotesResponse,
)

router = APIRouter(prefix="/notes", tags=["notes"])


@router.get("/published", response_model=list[PublishedNoteOut])
def list_published_notes(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[XhsPublishedNote]:
    rows = db.scalars(
        select(XhsPublishedNote)
        .where(XhsPublishedNote.owner_id == user.id)
        .order_by(XhsPublishedNote.synced_at.desc())
    ).all()
    return list(rows)


@router.post("/published/import", response_model=SyncNotesResponse)
def import_published_notes(
    payload: PublishedNoteImportIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> SyncNotesResponse:
    if not payload.items:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="empty_items")
    now = datetime.now(timezone.utc)
    for row in payload.items:
        db.add(
            XhsPublishedNote(
                owner_id=user.id,
                title=row.title.strip(),
                body=(row.body or "").strip(),
                official_url=(row.official_url.strip() if row.official_url else None) or None,
                views=row.views,
                click_rate_pct=row.click_rate_pct,
                watch_count=row.watch_count,
                likes=row.likes,
                favorites=row.favorites,
                comments=row.comments,
                follower_gain=row.follower_gain,
                metrics_pending=row.metrics_pending,
                synced_at=now,
            )
        )
    db.commit()
    n = len(payload.items)
    return SyncNotesResponse(imported_count=n, message=f"已导入 {n} 条已发布笔记记录")


@router.get("/composed-drafts", response_model=list[ComposedDraftOut])
def list_composed_drafts(
    entry_id: Optional[UUID] = Query(default=None),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[ComposedDraftOut]:
    q = (
        select(ComposedDraft)
        .join(Entry, ComposedDraft.entry_id == Entry.id)
        .where(Entry.owner_id == user.id)
        .options(
            selectinload(ComposedDraft.entry),
            selectinload(ComposedDraft.snapshot_copy_version),
        )
        .order_by(ComposedDraft.created_at.desc())
    )
    if entry_id is not None:
        q = q.where(ComposedDraft.entry_id == entry_id)
    rows = db.scalars(q).all()
    out: list[ComposedDraftOut] = []
    for d in rows:
        snap = d.snapshot_copy_version
        entry = d.entry
        raw_ids = d.ordered_image_asset_ids or []
        id_list: list[UUID] = []
        for x in raw_ids:
            try:
                id_list.append(UUID(str(x)))
            except (ValueError, TypeError):
                continue
        out.append(
            ComposedDraftOut(
                id=d.id,
                entry_id=d.entry_id,
                entry_title=entry.title or "（无标题）",
                snapshot_copy_version_id=d.snapshot_copy_version_id,
                snapshot_title=(snap.title or "").strip(),
                snapshot_body=(snap.body or "") if snap else "",
                status=d.status,
                created_at=d.created_at,
                ordered_image_asset_ids=id_list,
                cover_asset_id=d.cover_asset_id,
                optional_cover_preview_url=d.optional_cover_preview_url,
            )
        )
    return out


@router.post("/composed-drafts", response_model=ComposedDraftOut, status_code=status.HTTP_201_CREATED)
def create_composed_draft(
    payload: ComposedDraftCreateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ComposedDraftOut:
    entry = db.scalar(select(Entry).where(Entry.id == payload.entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    cv = db.scalar(
        select(CopyVersion).where(
            CopyVersion.id == payload.snapshot_copy_version_id,
            CopyVersion.entry_id == payload.entry_id,
        )
    )
    if cv is None:
        raise HTTPException(status_code=400, detail="snapshot_copy_version_mismatch")

    ordered = list(dict.fromkeys(payload.ordered_image_asset_ids))
    image_by_id: dict[UUID, DraftImage] = {}
    for uid in ordered:
        img = db.scalar(
            select(DraftImage).where(DraftImage.id == uid, DraftImage.entry_id == payload.entry_id)
        )
        if img is None:
            raise HTTPException(status_code=400, detail=f"unknown_image:{uid}")
        image_by_id[uid] = img

    cover_id = payload.cover_asset_id
    if cover_id is not None:
        if cover_id not in image_by_id:
            raise HTTPException(status_code=400, detail="cover_not_in_ordered_selection")
    elif ordered:
        cover_candidate = next((uid for uid in ordered if image_by_id[uid].is_cover), ordered[0])
        cover_id = cover_candidate

    preview: Optional[str] = None
    if cover_id is not None:
        preview = image_by_id[cover_id].public_url

    status_val = "images_ready" if len(ordered) > 0 else "copy_only"
    now = datetime.now(timezone.utc)
    draft = ComposedDraft(
        entry_id=payload.entry_id,
        snapshot_copy_version_id=payload.snapshot_copy_version_id,
        ordered_image_asset_ids=[str(x) for x in ordered],
        cover_asset_id=cover_id,
        optional_cover_preview_url=preview,
        status=status_val,
        updated_at=now,
    )
    db.add(draft)
    entry.updated_at = now
    db.commit()
    db.refresh(draft)
    db.refresh(entry)

    snap = cv
    raw_ids = draft.ordered_image_asset_ids or []
    id_list = []
    for x in raw_ids:
        try:
            id_list.append(UUID(str(x)))
        except (ValueError, TypeError):
            continue
    return ComposedDraftOut(
        id=draft.id,
        entry_id=draft.entry_id,
        entry_title=entry.title or "（无标题）",
        snapshot_copy_version_id=draft.snapshot_copy_version_id,
        snapshot_title=(snap.title or "").strip(),
        snapshot_body=(snap.body or "") if snap else "",
        status=draft.status,
        created_at=draft.created_at,
        ordered_image_asset_ids=id_list,
        cover_asset_id=draft.cover_asset_id,
        optional_cover_preview_url=draft.optional_cover_preview_url,
    )
