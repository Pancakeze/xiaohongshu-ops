from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import Entry, Template, User

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


def ensure_template_seed(db: Session) -> None:
    """与原型 #view-templates 对齐的默认模版；仅当该用户尚无模版时写入。"""
    user = db.scalar(select(User).where(User.email == DEMO_EMAIL))
    if user is None:
        return
    n = db.scalar(select(func.count()).select_from(Template).where(Template.owner_id == user.id))
    if n and int(n) > 0:
        return
    seeds = [
        Template(
            owner_id=user.id,
            name="教育 · 三步提分法",
            scenario="适用初一数学。",
            structure_description="结构：痛点钩子 → 三步可执行 → 资料/评论引导。",
            enabled=True,
            copy_metadata={"visual_style_hint": "清晰分步、教育向配图"},
        ),
        Template(
            owner_id=user.id,
            name="教育 · 错题复盘故事",
            scenario="情绪共鸣与单点方法。",
            structure_description="故事线 + 情绪曲线 + 单点方法。",
            enabled=True,
            copy_metadata={},
        ),
        Template(
            owner_id=user.id,
            name="教育 · 资料引流软转化",
            scenario="敏感场景默认停用，需运营复核后启用。",
            structure_description="软引导至资料/私信；注意合规边界。",
            enabled=False,
            copy_metadata={},
        ),
    ]
    for t in seeds:
        db.add(t)
    db.commit()
    first_tpl = db.scalar(
        select(Template)
        .where(Template.owner_id == user.id, Template.enabled.is_(True))
        .order_by(Template.created_at.asc())
    )
    if first_tpl is None:
        return
    entry = db.scalars(select(Entry).where(Entry.owner_id == user.id).limit(1)).first()
    if entry is not None and entry.selected_template_id is None:
        entry.selected_template_id = first_tpl.id
        db.commit()
