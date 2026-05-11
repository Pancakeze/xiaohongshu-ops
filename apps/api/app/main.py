from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import SessionLocal, engine
from app.migrations_runtime import ensure_entry_topics_column
from app.models import Base
from app.routers.entries import router as entries_router
from app.seed import ensure_seed_data


@asynccontextmanager
async def lifespan(_app: FastAPI):
    settings.upload_path.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(bind=engine)
    ensure_entry_topics_column()
    db = SessionLocal()
    try:
        ensure_seed_data(db)
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

app.mount(
    "/api/uploads",
    StaticFiles(directory=str(settings.upload_path)),
    name="uploads",
)


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}
