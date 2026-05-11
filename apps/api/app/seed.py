from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Entry, User

DEMO_EMAIL = "demo@local"


def ensure_seed_data(db: Session) -> None:
    user = db.scalar(select(User).where(User.email == DEMO_EMAIL))
    if user is None:
        user = User(email=DEMO_EMAIL)
        db.add(user)
        db.flush()
        db.add(
            Entry(
                owner_id=user.id,
                title="",
                body="",
                topics=[],
            )
        )
        db.commit()
        return
    entry = db.scalars(select(Entry).where(Entry.owner_id == user.id).limit(1)).first()
    if entry is None:
        db.add(Entry(owner_id=user.id, title="", body="", topics=[]))
        db.commit()
