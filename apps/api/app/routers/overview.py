from __future__ import annotations

from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.models import ComposedDraft, Entry, User, XhsPublishedNote
from app.schemas import OverviewOut, OverviewTopNoteOut

router = APIRouter(prefix="/overview", tags=["overview"])


def _published_reach_expr():
    """优质笔记与 Top 排行：优先曝光量，曝光为空则用观看量。"""
    return func.coalesce(XhsPublishedNote.impressions, XhsPublishedNote.watch_count)


def _current_week_bounds_utc() -> tuple[datetime, datetime, str]:
    tz = ZoneInfo(settings.overview_week_timezone)
    now_local = datetime.now(tz)
    d = now_local.date()
    monday = d - timedelta(days=d.weekday())
    sunday = monday + timedelta(days=6)
    start_local = datetime.combine(monday, time.min, tzinfo=tz)
    end_local = start_local + timedelta(days=7)
    label = f"{monday.isoformat()}–{sunday.isoformat()}"
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc), label


def _body_summary(body: str, max_len: int = 80) -> str:
    one = (body or "").strip().replace("\n", " ")
    if len(one) <= max_len:
        return one
    return one[: max_len - 1] + "…"


@router.get("", response_model=OverviewOut)
def get_overview(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> OverviewOut:
    week_start_utc, week_end_utc, week_label = _current_week_bounds_utc()
    threshold = settings.overview_quality_views_threshold

    published_total = (
        db.scalar(
            select(func.count()).select_from(XhsPublishedNote).where(XhsPublishedNote.owner_id == user.id)
        )
        or 0
    )

    published_this_week = (
        db.scalar(
            select(func.count())
            .select_from(XhsPublishedNote)
            .where(
                XhsPublishedNote.owner_id == user.id,
                XhsPublishedNote.synced_at >= week_start_utc,
                XhsPublishedNote.synced_at < week_end_utc,
            )
        )
        or 0
    )

    reach = _published_reach_expr()
    quality_notes = (
        db.scalar(
            select(func.count())
            .select_from(XhsPublishedNote)
            .where(
                XhsPublishedNote.owner_id == user.id,
                XhsPublishedNote.metrics_pending.is_(False),
                reach.isnot(None),
                reach >= threshold,
            )
        )
        or 0
    )

    pending_drafts = (
        db.scalar(
            select(func.count())
            .select_from(ComposedDraft)
            .join(Entry, ComposedDraft.entry_id == Entry.id)
            .where(Entry.owner_id == user.id)
        )
        or 0
    )

    top_rows = db.scalars(
        select(XhsPublishedNote)
        .where(XhsPublishedNote.owner_id == user.id)
        .order_by(
            _published_reach_expr().desc().nulls_last(),
            XhsPublishedNote.synced_at.desc(),
        )
        .limit(5)
    ).all()

    top_notes = [
        OverviewTopNoteOut(
            id=r.id,
            title=(r.title or "").strip() or "（无标题）",
            summary=_body_summary(r.body or ""),
            views=r.impressions if r.impressions is not None else r.watch_count,
            official_url=r.official_url,
            metrics_pending=r.metrics_pending,
        )
        for r in top_rows
    ]

    return OverviewOut(
        published_notes_total=int(published_total),
        published_this_week_count=int(published_this_week),
        quality_notes_count=int(quality_notes),
        quality_views_threshold=threshold,
        pending_composed_drafts_count=int(pending_drafts),
        week_range_mon_sun_label=week_label,
        top_notes=top_notes,
    )
