"""启动时轻量补列（无 Alembic 时的 dev 友好方案）。"""

from __future__ import annotations

from sqlalchemy import inspect, text

from app.database import engine


def ensure_entry_topics_column() -> None:
    if engine.dialect.name != "postgresql":
        return
    insp = inspect(engine)
    if "entries" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("entries")}
    if "topics" in cols:
        return
    with engine.begin() as conn:
        conn.execute(
            text("ALTER TABLE entries ADD COLUMN topics JSONB NOT NULL DEFAULT '[]'::jsonb")
        )
