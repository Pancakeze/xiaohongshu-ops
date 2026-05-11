from __future__ import annotations

from datetime import datetime
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator


class DraftImageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    sort_order: int
    public_url: str
    is_cover: bool
    include_in_publish: bool


class EntrySummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    updated_at: datetime


class EntryDetailOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    title: str
    body: str
    topics: List[str] = Field(default_factory=list)
    updated_at: datetime
    images: List[DraftImageOut]

    @field_validator("topics", mode="before")
    @classmethod
    def topics_coerce(cls, v: object) -> list[str]:
        if v is None:
            return []
        if isinstance(v, list):
            return [str(x) for x in v]
        return []


class EntryPatchIn(BaseModel):
    title: Optional[str] = Field(default=None, max_length=500)
    body: Optional[str] = None
    topics: Optional[List[str]] = None

    @field_validator("topics")
    @classmethod
    def normalize_topics(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return None
        out: list[str] = []
        for raw in v[:35]:
            s = (raw or "").strip().lstrip("#").strip()
            if not s or "\n" in s or "\r" in s:
                continue
            if len(s) > 80:
                s = s[:80]
            out.append(s)
        return out


class DraftImageCreateIn(BaseModel):
    public_url: str = Field(..., min_length=1, max_length=8000)
    sort_order: Optional[int] = None
    is_cover: bool = False
    include_in_publish: bool = True


class DraftImagePatchIn(BaseModel):
    sort_order: Optional[int] = None
    is_cover: Optional[bool] = None
    include_in_publish: Optional[bool] = None


class ImageReorderIn(BaseModel):
    ids: List[UUID]
