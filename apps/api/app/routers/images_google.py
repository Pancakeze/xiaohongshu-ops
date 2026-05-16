from __future__ import annotations

import base64
import threading
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.image_pools import ensure_default_pool, ensure_image_pool_has_room, next_image_sort_order, resolve_pool_id
from app.models import CopyVersion, DraftImage, Entry, GoogleImageAsset, GoogleImageSession, GoogleImageTurn, User
from app.schemas import (
    GoogleImageSessionCreateOut,
    GoogleImageSessionOut,
    GoogleImageTurnExtensionIn,
    GoogleImageTurnOut,
)

router = APIRouter(prefix="/google-image", tags=["google-image"])

_session_locks: dict[UUID, threading.Lock] = {}
_session_locks_guard = threading.Lock()


def _get_session_lock(session_id: UUID) -> threading.Lock:
    with _session_locks_guard:
        lock = _session_locks.get(session_id)
        if lock is None:
            lock = threading.Lock()
            _session_locks[session_id] = lock
        return lock


def _suffix_for_mime(mime: str) -> str:
    m = (mime or "").lower().split(";")[0].strip()
    if m in ("image/jpeg", "image/jpg"):
        return ".jpg"
    if m == "image/webp":
        return ".webp"
    if m == "image/gif":
        return ".gif"
    return ".png"


def _params_stored(params: dict) -> dict:
    skip = frozenset({"chrome_cdp_url", "chrome_profile_dir", "apiBaseUrl", "bearerToken", "sessionId"})
    return {str(k): v for k, v in params.items() if str(k) not in skip}


def _apply_draft_pool_for_assets(
    db: Session,
    user: User,
    entry_id: UUID,
    source_copy_version_id: UUID | None,
    assets: list[GoogleImageAsset],
    *,
    image_pool_id: UUID | None = None,
) -> None:
    if not assets:
        return
    entry = db.scalar(select(Entry).where(Entry.id == entry_id, Entry.owner_id == user.id))
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    pool_id = resolve_pool_id(db, entry.id, image_pool_id)
    valid = [a for a in assets if a.public_url]
    if not valid:
        return
    ensure_image_pool_has_room(db, pool_id, adding=len(valid))
    cv_id = _resolve_source_copy_version_id(db, entry.id, source_copy_version_id)
    next_ord = next_image_sort_order(db, pool_id)
    for a in valid:
        db.add(
            DraftImage(
                entry_id=entry.id,
                pool_id=pool_id,
                sort_order=next_ord,
                public_url=a.public_url,
                is_cover=False,
                include_in_publish=True,
                source_copy_version_id=cv_id,
            )
        )
        next_ord += 1
    entry.updated_at = datetime.now(timezone.utc)


def _public_url_for_generated(local_path: Path) -> str:
    base = settings.google_generated_path
    try:
        rel = local_path.resolve().relative_to(base.resolve())
    except Exception:
        # Fallback: keep last 2 segments if unexpected path.
        rel = Path(local_path.name)
    rel_posix = rel.as_posix().lstrip("/")
    return f"{settings.public_base_url.rstrip('/')}/api/generated/google/{rel_posix}"


def _resolve_source_copy_version_id(db: Session, entry_id: UUID, requested: UUID | None) -> UUID | None:
    if requested is None:
        return None
    ok = db.scalar(select(CopyVersion.id).where(CopyVersion.id == requested, CopyVersion.entry_id == entry_id))
    if ok is None:
        raise HTTPException(status_code=400, detail="source_copy_version_mismatch")
    return requested


@router.post("/sessions", response_model=GoogleImageSessionCreateOut, status_code=status.HTTP_201_CREATED)
def create_google_image_session(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> GoogleImageSessionCreateOut:
    row = GoogleImageSession(owner_id=user.id, status="active", last_error=None)
    db.add(row)
    db.commit()
    db.refresh(row)
    return GoogleImageSessionCreateOut(id=row.id)


@router.post("/sessions/{session_id}/turns/via-extension", response_model=GoogleImageTurnOut, status_code=status.HTTP_201_CREATED)
def create_google_image_turn_via_extension(
    session_id: UUID,
    payload: GoogleImageTurnExtensionIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> GoogleImageTurn:
    session = db.scalar(select(GoogleImageSession).where(GoogleImageSession.id == session_id))
    if session is None:
        raise HTTPException(status_code=404, detail="session_not_found")
    if session.owner_id != user.id:
        raise HTTPException(status_code=404, detail="session_not_found")

    turn = GoogleImageTurn(
        session_id=session_id,
        prompt=payload.prompt.strip(),
        params=_params_stored(payload.params or {}),
        result_summary="",
        last_error=None,
    )
    db.add(turn)
    db.flush()

    output_dir = settings.google_generated_path / str(session_id) / str(turn.id)
    output_dir.mkdir(parents=True, exist_ok=True)

    lock = _get_session_lock(session_id)
    lock.acquire()
    try:
        assets: list[GoogleImageAsset] = []
        for i, img in enumerate(payload.images):
            raw = base64.b64decode(img.content_base64, validate=False)
            suf = _suffix_for_mime(img.mime)
            out_path = (output_dir / f"ext_{i + 1}{suf}").resolve()
            out_path.write_bytes(raw)
            assets.append(
                GoogleImageAsset(
                    turn_id=turn.id,
                    local_path=str(out_path),
                    public_url=_public_url_for_generated(out_path),
                    width=None,
                    height=None,
                )
            )
        for a in assets:
            db.add(a)

        if payload.write_to_draft_pool:
            if payload.entry_id is None:
                raise HTTPException(status_code=400, detail="entry_id_required_for_draft_pool")
            _apply_draft_pool_for_assets(db, user, payload.entry_id, payload.source_copy_version_id, assets)

        turn.result_summary = f"generated_images:{len(assets)}"
        turn.last_error = None
        session.status = "active"
        session.last_error = None
        session.updated_at = datetime.now(timezone.utc)
    finally:
        lock.release()

    db.commit()
    db.refresh(turn)
    db.refresh(turn, attribute_names=["assets"])
    return turn


@router.get("/sessions/{session_id}", response_model=GoogleImageSessionOut)
def get_google_image_session(
    session_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> GoogleImageSession:
    session = db.scalar(
        select(GoogleImageSession)
        .options(selectinload(GoogleImageSession.turns).selectinload(GoogleImageTurn.assets))
        .where(GoogleImageSession.id == session_id, GoogleImageSession.owner_id == user.id)
    )
    if session is None:
        raise HTTPException(status_code=404, detail="session_not_found")
    return session

