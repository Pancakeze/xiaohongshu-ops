from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.deps import get_current_user
from app.models import ComposedDraft, CopyVersion, DraftFolder, DraftImage, Entry, User, XhsPublishedNote
from app.schemas import (
    ComposedDraftCreateIn,
    ComposedDraftDetailOut,
    ComposedDraftOut,
    ComposedDraftPatchIn,
    ComposedDraftSnapshotImageOut,
    DraftFolderCreateIn,
    DraftFolderOut,
    DraftFolderTreeOut,
    DraftFolderUpdateIn,
    PublishedNoteImportIn,
    PublishedNoteOut,
    PublishedNotePatchIn,
    SyncNotesResponse,
)

router = APIRouter(prefix="/notes", tags=["notes"])

_EXPLORE_NOTE_ID_RE = re.compile(r"/explore/([a-f0-9]+)", re.I)


def _explore_note_id(url: str | None) -> str | None:
    if not url:
        return None
    m = _EXPLORE_NOTE_ID_RE.search(url.strip())
    return m.group(1).lower() if m else None


def _apply_published_row_fields(note: XhsPublishedNote, row: PublishedNoteImportRow) -> None:
    note.title = row.title.strip()
    note.body = (row.body or "").strip()
    if row.official_url and row.official_url.strip():
        note.official_url = row.official_url.strip()
    if row.cover_url and row.cover_url.strip():
        note.cover_url = row.cover_url.strip()
    note.published_at = row.published_at
    if row.publish_status:
        note.publish_status = row.publish_status.strip()[:32] or "published"
    note.impressions = row.impressions
    note.views = row.views
    note.click_rate_pct = row.click_rate_pct
    note.watch_count = row.watch_count
    note.likes = row.likes
    note.favorites = row.favorites
    note.comments = row.comments
    note.follower_gain = row.follower_gain
    note.shares = row.shares
    note.avg_watch_seconds = row.avg_watch_seconds
    note.metrics_pending = row.metrics_pending


def _find_published_for_upsert(
    db: Session,
    user: User,
    row: PublishedNoteImportRow,
) -> XhsPublishedNote | None:
    title = row.title.strip()
    if not title:
        return None
    if row.official_url:
        url = row.official_url.strip()
        if url:
            hit = db.scalar(
                select(XhsPublishedNote).where(
                    XhsPublishedNote.owner_id == user.id,
                    XhsPublishedNote.official_url == url,
                )
            )
            if hit is not None:
                return hit
            note_id = _explore_note_id(url)
            if note_id:
                hit = db.scalar(
                    select(XhsPublishedNote).where(
                        XhsPublishedNote.owner_id == user.id,
                        XhsPublishedNote.official_url.ilike(f"%/explore/{note_id}%"),
                    )
                )
                if hit is not None:
                    return hit
    q = select(XhsPublishedNote).where(
        XhsPublishedNote.owner_id == user.id,
        func.lower(XhsPublishedNote.title) == title.lower(),
    )
    if row.published_at is not None:
        q = q.where(XhsPublishedNote.published_at == row.published_at)
    return db.scalars(q.order_by(XhsPublishedNote.synced_at.desc()).limit(1)).first()


def _folder_path_label(folder: Optional[DraftFolder]) -> Optional[str]:
    if folder is None:
        return None
    if folder.parent_id is None:
        return folder.name
    parent = folder.parent
    if parent is not None:
        return f"{parent.name} / {folder.name}"
    return folder.name


def _resolve_level2_folder(
    db: Session,
    user: User,
    folder_id: Optional[UUID],
) -> Optional[DraftFolder]:
    if folder_id is None:
        return None
    folder = db.scalar(
        select(DraftFolder).where(DraftFolder.id == folder_id, DraftFolder.owner_id == user.id)
    )
    if folder is None:
        raise HTTPException(status_code=400, detail="folder_not_found")
    if folder.parent_id is None:
        raise HTTPException(status_code=400, detail="folder_must_be_level2")
    return folder


def _parse_ordered_image_ids(raw_ids: object) -> list[UUID]:
    id_list: list[UUID] = []
    if not isinstance(raw_ids, list):
        return id_list
    for x in raw_ids:
        try:
            id_list.append(UUID(str(x)))
        except (ValueError, TypeError):
            continue
    return id_list


def _snapshot_title_body(d: ComposedDraft, snap: CopyVersion) -> tuple[str, str]:
    title = d.snapshot_title if d.snapshot_title is not None else (snap.title or "")
    body = d.snapshot_body if d.snapshot_body is not None else ((snap.body or "") if snap else "")
    return title.strip(), body


def _composed_draft_out(d: ComposedDraft, entry: Entry, snap: CopyVersion) -> ComposedDraftOut:
    id_list = _parse_ordered_image_ids(d.ordered_image_asset_ids or [])
    snap_title, snap_body = _snapshot_title_body(d, snap)
    return ComposedDraftOut(
        id=d.id,
        entry_id=d.entry_id,
        entry_title=entry.title or "（无标题）",
        snapshot_copy_version_id=d.snapshot_copy_version_id,
        snapshot_title=snap_title,
        snapshot_body=snap_body,
        status=d.status,
        created_at=d.created_at,
        ordered_image_asset_ids=id_list,
        cover_asset_id=d.cover_asset_id,
        optional_cover_preview_url=d.optional_cover_preview_url,
        folder_id=d.folder_id,
        folder_path=_folder_path_label(d.folder),
    )


def _resolve_draft_images(
    db: Session,
    entry_id: UUID,
    ordered: list[UUID],
    cover_id: Optional[UUID],
) -> tuple[list[UUID], Optional[UUID], Optional[str], str]:
    ordered_unique = list(dict.fromkeys(ordered))
    image_by_id: dict[UUID, DraftImage] = {}
    for uid in ordered_unique:
        img = db.scalar(
            select(DraftImage).where(DraftImage.id == uid, DraftImage.entry_id == entry_id)
        )
        if img is None:
            raise HTTPException(status_code=400, detail=f"unknown_image:{uid}")
        image_by_id[uid] = img

    resolved_cover = cover_id
    if resolved_cover is not None and resolved_cover not in image_by_id:
        raise HTTPException(status_code=400, detail="cover_not_in_ordered_selection")
    if resolved_cover is None and ordered_unique:
        resolved_cover = next(
            (uid for uid in ordered_unique if image_by_id[uid].is_cover),
            ordered_unique[0],
        )

    preview: Optional[str] = None
    if resolved_cover is not None:
        preview = image_by_id[resolved_cover].public_url

    status_val = "images_ready" if len(ordered_unique) > 0 else "copy_only"
    return ordered_unique, resolved_cover, preview, status_val


def _get_owned_composed_draft(db: Session, user: User, draft_id: UUID) -> ComposedDraft:
    draft = db.scalar(
        select(ComposedDraft)
        .join(Entry, ComposedDraft.entry_id == Entry.id)
        .where(ComposedDraft.id == draft_id, Entry.owner_id == user.id)
        .options(
            selectinload(ComposedDraft.entry),
            selectinload(ComposedDraft.snapshot_copy_version),
            selectinload(ComposedDraft.folder).selectinload(DraftFolder.parent),
        )
    )
    if draft is None:
        raise HTTPException(status_code=404, detail="draft_not_found")
    return draft


def _composed_draft_detail_out(
    db: Session,
    d: ComposedDraft,
    entry: Entry,
    snap: CopyVersion,
) -> ComposedDraftDetailOut:
    base = _composed_draft_out(d, entry, snap)
    id_list = base.ordered_image_asset_ids
    snapshot_images: list[ComposedDraftSnapshotImageOut] = []
    for pos, uid in enumerate(id_list):
        img = db.scalar(
            select(DraftImage).where(DraftImage.id == uid, DraftImage.entry_id == d.entry_id)
        )
        if img is not None:
            snapshot_images.append(
                ComposedDraftSnapshotImageOut(id=img.id, public_url=img.public_url, position=pos)
            )
    return ComposedDraftDetailOut(
        **base.model_dump(),
        snapshot_images=snapshot_images,
        updated_at=d.updated_at,
    )


@router.get("/published", response_model=list[PublishedNoteOut])
def list_published_notes(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[XhsPublishedNote]:
    reach = func.coalesce(XhsPublishedNote.impressions, XhsPublishedNote.watch_count)
    rows = db.scalars(
        select(XhsPublishedNote)
        .where(XhsPublishedNote.owner_id == user.id)
        .order_by(
            XhsPublishedNote.published_at.desc().nulls_last(),
            reach.desc().nulls_last(),
            XhsPublishedNote.synced_at.desc(),
        )
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
    imported = 0
    updated = 0
    for row in payload.items:
        if payload.upsert:
            existing = _find_published_for_upsert(db, user, row)
            if existing is not None:
                _apply_published_row_fields(existing, row)
                existing.synced_at = now
                updated += 1
                continue
        note = XhsPublishedNote(owner_id=user.id, synced_at=now)
        _apply_published_row_fields(note, row)
        db.add(note)
        imported += 1
    db.commit()
    parts: list[str] = []
    if imported:
        parts.append(f"新增 {imported} 条")
    if updated:
        parts.append(f"更新 {updated} 条")
    with_links = sum(
        1
        for row in payload.items
        if row.official_url and "/explore/" in row.official_url
    )
    msg = "已同步已发布笔记：" + ("，".join(parts) if parts else "无变更")
    if with_links:
        msg += f"，{with_links} 条含笔记链接"
    elif payload.items:
        msg += "；未获取到笔记链接（请重新加载扩展 v0.5.3+ 后点「补全笔记链接」，需已登录创作中心笔记管理页）"
    return SyncNotesResponse(imported_count=imported, updated_count=updated, message=msg)


@router.patch("/published/{note_id}", response_model=PublishedNoteOut)
def patch_published_note(
    note_id: UUID,
    payload: PublishedNotePatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> XhsPublishedNote:
    note = db.scalar(
        select(XhsPublishedNote).where(
            XhsPublishedNote.id == note_id,
            XhsPublishedNote.owner_id == user.id,
        )
    )
    if note is None:
        raise HTTPException(status_code=404, detail="published_note_not_found")
    if payload.official_url is not None:
        url = payload.official_url.strip()
        note.official_url = url if url else None
    note.synced_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(note)
    return note


@router.get("/draft-folders", response_model=list[DraftFolderTreeOut])
def list_draft_folders(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[DraftFolderTreeOut]:
    rows = list(
        db.scalars(
            select(DraftFolder)
            .where(DraftFolder.owner_id == user.id)
            .order_by(DraftFolder.sort_order, DraftFolder.created_at)
        ).all()
    )
    level1 = [r for r in rows if r.parent_id is None]
    children_by_parent: dict[UUID, list[DraftFolder]] = {}
    for r in rows:
        if r.parent_id is not None:
            children_by_parent.setdefault(r.parent_id, []).append(r)
    out: list[DraftFolderTreeOut] = []
    for p in level1:
        kids = children_by_parent.get(p.id, [])
        out.append(
            DraftFolderTreeOut(
                id=p.id,
                name=p.name,
                sort_order=p.sort_order,
                children=[
                    DraftFolderOut(id=c.id, name=c.name, parent_id=c.parent_id, sort_order=c.sort_order)
                    for c in kids
                ],
            )
        )
    return out


@router.post("/draft-folders", response_model=DraftFolderOut, status_code=status.HTTP_201_CREATED)
def create_draft_folder(
    payload: DraftFolderCreateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DraftFolderOut:
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="empty_name")
    parent: Optional[DraftFolder] = None
    if payload.parent_id is not None:
        parent = db.scalar(
            select(DraftFolder).where(
                DraftFolder.id == payload.parent_id,
                DraftFolder.owner_id == user.id,
            )
        )
        if parent is None:
            raise HTTPException(status_code=400, detail="parent_not_found")
        if parent.parent_id is not None:
            raise HTTPException(status_code=400, detail="parent_must_be_level1")
    row = DraftFolder(
        owner_id=user.id,
        parent_id=payload.parent_id,
        name=name,
        sort_order=0,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return DraftFolderOut(id=row.id, name=row.name, parent_id=row.parent_id, sort_order=row.sort_order)


@router.patch("/draft-folders/{folder_id}", response_model=DraftFolderOut)
def update_draft_folder(
    folder_id: UUID,
    payload: DraftFolderUpdateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DraftFolderOut:
    row = db.scalar(
        select(DraftFolder).where(DraftFolder.id == folder_id, DraftFolder.owner_id == user.id)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="folder_not_found")
    if payload.name is not None:
        n = payload.name.strip()
        if not n:
            raise HTTPException(status_code=400, detail="empty_name")
        row.name = n
    if payload.sort_order is not None:
        row.sort_order = payload.sort_order
    db.commit()
    db.refresh(row)
    return DraftFolderOut(id=row.id, name=row.name, parent_id=row.parent_id, sort_order=row.sort_order)


@router.delete("/draft-folders/{folder_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_draft_folder(
    folder_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    row = db.scalar(
        select(DraftFolder).where(DraftFolder.id == folder_id, DraftFolder.owner_id == user.id)
    )
    if row is None:
        raise HTTPException(status_code=404, detail="folder_not_found")
    if row.parent_id is None:
        has_child = db.scalar(
            select(DraftFolder.id).where(DraftFolder.parent_id == row.id).limit(1)
        )
        if has_child is not None:
            raise HTTPException(status_code=400, detail="delete_children_first")
    db.delete(row)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/composed-drafts", response_model=list[ComposedDraftOut])
def list_composed_drafts(
    entry_id: Optional[UUID] = Query(default=None),
    folder_id: Optional[UUID] = Query(default=None),
    uncategorized: bool = Query(default=False),
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
            selectinload(ComposedDraft.folder).selectinload(DraftFolder.parent),
        )
        .order_by(ComposedDraft.created_at.desc())
    )
    if entry_id is not None:
        q = q.where(ComposedDraft.entry_id == entry_id)
    if uncategorized:
        q = q.where(ComposedDraft.folder_id.is_(None))
    elif folder_id is not None:
        q = q.where(ComposedDraft.folder_id == folder_id)
    rows = db.scalars(q).all()
    out: list[ComposedDraftOut] = []
    for d in rows:
        snap = d.snapshot_copy_version
        entry = d.entry
        out.append(_composed_draft_out(d, entry, snap))
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

    folder = _resolve_level2_folder(db, user, payload.folder_id)

    ordered, cover_id, preview, status_val = _resolve_draft_images(
        db,
        payload.entry_id,
        list(payload.ordered_image_asset_ids),
        payload.cover_asset_id,
    )
    snap_title = (cv.title or "").strip()
    snap_body = (cv.body or "") if cv.body else ""
    now = datetime.now(timezone.utc)
    draft = ComposedDraft(
        entry_id=payload.entry_id,
        folder_id=folder.id if folder else None,
        snapshot_copy_version_id=payload.snapshot_copy_version_id,
        snapshot_title=snap_title,
        snapshot_body=snap_body,
        ordered_image_asset_ids=[str(x) for x in ordered],
        cover_asset_id=cover_id,
        optional_cover_preview_url=preview,
        status=status_val,
        updated_at=now,
    )
    db.add(draft)
    entry.updated_at = now
    db.commit()
    draft = db.scalar(
        select(ComposedDraft)
        .where(ComposedDraft.id == draft.id)
        .options(
            selectinload(ComposedDraft.folder).selectinload(DraftFolder.parent),
        )
    )
    assert draft is not None
    return _composed_draft_out(draft, entry, cv)


@router.get("/composed-drafts/{draft_id}", response_model=ComposedDraftDetailOut)
def get_composed_draft(
    draft_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ComposedDraftDetailOut:
    draft = _get_owned_composed_draft(db, user, draft_id)
    return _composed_draft_detail_out(db, draft, draft.entry, draft.snapshot_copy_version)


@router.delete("/composed-drafts/{draft_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_composed_draft(
    draft_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    draft = _get_owned_composed_draft(db, user, draft_id)
    db.delete(draft)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.patch("/composed-drafts/{draft_id}", response_model=ComposedDraftOut)
def patch_composed_draft(
    draft_id: UUID,
    payload: ComposedDraftPatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> ComposedDraftOut:
    draft = _get_owned_composed_draft(db, user, draft_id)
    fields = payload.model_fields_set
    if "folder_id" in fields:
        if payload.folder_id is None:
            draft.folder_id = None
            draft.folder = None
        else:
            folder = _resolve_level2_folder(db, user, payload.folder_id)
            draft.folder_id = folder.id
            draft.folder = folder
    if "snapshot_title" in fields and payload.snapshot_title is not None:
        draft.snapshot_title = payload.snapshot_title.strip()
    if "snapshot_body" in fields and payload.snapshot_body is not None:
        draft.snapshot_body = payload.snapshot_body
    if "ordered_image_asset_ids" in fields or "cover_asset_id" in fields:
        ordered_in = (
            list(payload.ordered_image_asset_ids)
            if "ordered_image_asset_ids" in fields and payload.ordered_image_asset_ids is not None
            else _parse_ordered_image_ids(draft.ordered_image_asset_ids or [])
        )
        cover_in = payload.cover_asset_id if "cover_asset_id" in fields else draft.cover_asset_id
        ordered, cover_id, preview, status_val = _resolve_draft_images(
            db, draft.entry_id, ordered_in, cover_in
        )
        draft.ordered_image_asset_ids = [str(x) for x in ordered]
        draft.cover_asset_id = cover_id
        draft.optional_cover_preview_url = preview
        draft.status = status_val
    draft.updated_at = datetime.now(timezone.utc)
    draft.entry.updated_at = draft.updated_at
    db.commit()
    db.refresh(draft)
    return _composed_draft_out(draft, draft.entry, draft.snapshot_copy_version)
