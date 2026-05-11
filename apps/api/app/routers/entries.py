from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.models import DraftImage, Entry, User
from app.schemas import (
    DraftImageCreateIn,
    DraftImageOut,
    DraftImagePatchIn,
    EntryDetailOut,
    EntryPatchIn,
    EntrySummaryOut,
    ImageReorderIn,
)

router = APIRouter(prefix="/entries", tags=["entries"])

ALLOWED_IMAGE_TYPES = frozenset({"image/jpeg", "image/png", "image/webp", "image/gif"})
_IMAGE_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024


def _touch_entry(entry: Entry) -> None:
    entry.updated_at = datetime.now(timezone.utc)


@router.get("", response_model=list[EntrySummaryOut])
def list_entries(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Entry]:
    rows = db.scalars(select(Entry).where(Entry.owner_id == user.id).order_by(Entry.updated_at.desc())).all()
    return list(rows)


@router.get("/{entry_id}", response_model=EntryDetailOut)
def get_entry(
    entry_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Entry:
    entry = db.scalar(
        select(Entry)
        .options(selectinload(Entry.images))
        .where(Entry.id == entry_id, Entry.owner_id == user.id)
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    entry.images.sort(key=lambda i: i.sort_order)
    return entry


@router.patch("/{entry_id}", response_model=EntryDetailOut)
def patch_entry(
    entry_id: UUID,
    body: EntryPatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Entry:
    entry = db.scalar(
        select(Entry).options(selectinload(Entry.images)).where(Entry.id == entry_id, Entry.owner_id == user.id)
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    if body.title is not None:
        entry.title = body.title
    if body.body is not None:
        entry.body = body.body
    if body.topics is not None:
        entry.topics = list(body.topics)
    _touch_entry(entry)
    db.commit()
    db.refresh(entry)
    entry.images.sort(key=lambda i: i.sort_order)
    return entry


@router.post("/{entry_id}/images", response_model=DraftImageOut, status_code=status.HTTP_201_CREATED)
def add_image(
    entry_id: UUID,
    payload: DraftImageCreateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DraftImage:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    max_ord = db.scalar(select(func.max(DraftImage.sort_order)).where(DraftImage.entry_id == entry_id))
    next_ord = (max_ord + 1) if max_ord is not None else 0
    sort_order = payload.sort_order if payload.sort_order is not None else next_ord
    if payload.is_cover:
        for img in db.scalars(select(DraftImage).where(DraftImage.entry_id == entry_id)):
            img.is_cover = False
    img = DraftImage(
        entry_id=entry_id,
        sort_order=sort_order,
        public_url=payload.public_url,
        is_cover=payload.is_cover,
        include_in_publish=payload.include_in_publish,
    )
    db.add(img)
    _touch_entry(entry)
    db.commit()
    db.refresh(img)
    return img


@router.post("/{entry_id}/images/upload", response_model=DraftImageOut, status_code=status.HTTP_201_CREATED)
async def upload_image_file(
    entry_id: UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DraftImage:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    ct = (file.content_type or "").split(";")[0].strip().lower()
    if ct not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail="invalid_image_mime")
    raw = await file.read()
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail="file_too_large")
    ext = _IMAGE_EXT.get(ct, ".img")
    fname = f"{entry_id}_{uuid.uuid4().hex}{ext}"
    dest: Path = settings.upload_path / fname
    dest.write_bytes(raw)
    public_url = f"{settings.public_base_url.rstrip('/')}/api/uploads/{fname}"

    max_ord = db.scalar(select(func.max(DraftImage.sort_order)).where(DraftImage.entry_id == entry_id))
    next_ord = (max_ord + 1) if max_ord is not None else 0
    img = DraftImage(
        entry_id=entry_id,
        sort_order=next_ord,
        public_url=public_url,
        is_cover=False,
        include_in_publish=True,
    )
    db.add(img)
    _touch_entry(entry)
    db.commit()
    db.refresh(img)
    return img


@router.patch("/{entry_id}/images/{image_id}", response_model=DraftImageOut)
def patch_image(
    entry_id: UUID,
    image_id: UUID,
    payload: DraftImagePatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> DraftImage:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    img = db.scalar(select(DraftImage).where(DraftImage.id == image_id, DraftImage.entry_id == entry_id))
    if img is None:
        raise HTTPException(status_code=404, detail="Image not found")
    if payload.sort_order is not None:
        img.sort_order = payload.sort_order
    if payload.include_in_publish is not None:
        img.include_in_publish = payload.include_in_publish
    if payload.is_cover is not None:
        if payload.is_cover:
            for other in db.scalars(select(DraftImage).where(DraftImage.entry_id == entry_id)):
                other.is_cover = other.id == image_id
        else:
            img.is_cover = False
    _touch_entry(entry)
    db.commit()
    db.refresh(img)
    return img


@router.delete("/{entry_id}/images/{image_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_image(
    entry_id: UUID,
    image_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> None:
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    img = db.scalar(select(DraftImage).where(DraftImage.id == image_id, DraftImage.entry_id == entry_id))
    if img is None:
        raise HTTPException(status_code=404, detail="Image not found")
    if "/api/uploads/" in img.public_url:
        name = img.public_url.rsplit("/", maxsplit=1)[-1]
        try:
            (settings.upload_path / name).unlink(missing_ok=True)
        except OSError:
            pass
    db.delete(img)
    _touch_entry(entry)
    db.commit()


@router.put("/{entry_id}/images/reorder", response_model=EntryDetailOut)
def reorder_images(
    entry_id: UUID,
    payload: ImageReorderIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Entry:
    entry = db.scalar(
        select(Entry).options(selectinload(Entry.images)).where(Entry.id == entry_id, Entry.owner_id == user.id)
    )
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    images = {i.id: i for i in entry.images}
    for idx, uid in enumerate(payload.ids):
        img = images.get(uid)
        if img is None:
            raise HTTPException(status_code=400, detail=f"Unknown image id: {uid}")
        img.sort_order = idx
    _touch_entry(entry)
    db.commit()
    db.refresh(entry)
    entry.images.sort(key=lambda i: i.sort_order)
    return entry
