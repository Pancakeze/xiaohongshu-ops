from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import Template, User
from app.schemas import TemplateCreateIn, TemplateOut, TemplatePatchIn

router = APIRouter(prefix="/templates", tags=["templates"])


def _touch(t: Template) -> None:
    t.updated_at = datetime.now(timezone.utc)


@router.get("", response_model=list[TemplateOut])
def list_templates(
    enabled: Optional[bool] = Query(None, description="仅返回启用/停用；省略则返回全部"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[Template]:
    q = select(Template).where(Template.owner_id == user.id).order_by(Template.updated_at.desc())
    if enabled is not None:
        q = q.where(Template.enabled == enabled)
    return list(db.scalars(q).all())


@router.post("", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
def create_template(
    body: TemplateCreateIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Template:
    t = Template(
        owner_id=user.id,
        name=body.name.strip(),
        scenario=body.scenario or "",
        structure_description=body.structure_description or "",
        enabled=body.enabled,
        copy_metadata=dict(body.copy_metadata),
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


@router.patch("/{template_id}", response_model=TemplateOut)
def patch_template(
    template_id: UUID,
    body: TemplatePatchIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Template:
    t = db.scalar(select(Template).where(Template.id == template_id, Template.owner_id == user.id))
    if t is None:
        raise HTTPException(status_code=404, detail="template not found")
    if body.name is not None:
        t.name = body.name.strip()
    if body.scenario is not None:
        t.scenario = body.scenario
    if body.structure_description is not None:
        t.structure_description = body.structure_description
    if body.enabled is not None:
        t.enabled = body.enabled
    if body.copy_metadata is not None:
        t.copy_metadata = dict(body.copy_metadata)
    _touch(t)
    db.commit()
    db.refresh(t)
    return t


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(
    template_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Response:
    t = db.scalar(select(Template).where(Template.id == template_id, Template.owner_id == user.id))
    if t is None:
        raise HTTPException(status_code=404, detail="template not found")
    db.delete(t)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{template_id}/duplicate", response_model=TemplateOut, status_code=status.HTTP_201_CREATED)
def duplicate_template(
    template_id: UUID,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Template:
    src = db.scalar(select(Template).where(Template.id == template_id, Template.owner_id == user.id))
    if src is None:
        raise HTTPException(status_code=404, detail="template not found")
    base = src.name.strip()
    dup = Template(
        owner_id=user.id,
        name=f"{base}（副本）" if base else "未命名（副本）",
        scenario=src.scenario,
        structure_description=src.structure_description,
        enabled=src.enabled,
        copy_metadata=dict(src.copy_metadata or {}),
    )
    db.add(dup)
    db.commit()
    db.refresh(dup)
    return dup
