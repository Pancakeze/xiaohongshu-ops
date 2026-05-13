from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import SessionLocal, engine
from app.migrations_runtime import (
    backfill_primary_copy_versions,
    ensure_entry_topics_column,
    ensure_publish_attempts_schema,
    ensure_templates_schema,
    ensure_v12_domain_schema,
    ensure_xhs_published_notes_schema,
)
from app.models import Base
from app.routers.competitors import router as competitors_router
from app.routers.entries import router as entries_router
from app.routers.notes import router as notes_router
from app.routers.overview import router as overview_router
from app.routers.templates import router as templates_router
from app.seed import ensure_seed_data, ensure_template_seed


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.upload_path.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=engine)
    ensure_entry_topics_column()
    ensure_v12_domain_schema()
    ensure_templates_schema()
    ensure_xhs_published_notes_schema()
    ensure_publish_attempts_schema()
    db = SessionLocal()
    try:
        ensure_seed_data(db)
        ensure_template_seed(db)
        backfill_primary_copy_versions(db)
    finally:
        db.close()
    yield


app = FastAPI(title="XHS Ops API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(entries_router, prefix="/api")
app.include_router(notes_router, prefix="/api")
app.include_router(overview_router, prefix="/api")
app.include_router(templates_router, prefix="/api")
app.include_router(competitors_router, prefix="/api")

# StaticFiles 会在 import 时校验目录存在；避免仅做 import 自检时失败
settings.upload_path.mkdir(parents=True, exist_ok=True)
app.mount(
    "/api/uploads",
    StaticFiles(directory=str(settings.upload_path)),
    name="uploads",
)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}
