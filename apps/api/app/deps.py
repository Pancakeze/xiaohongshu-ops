from typing import Optional

from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import User

security = HTTPBearer(auto_error=False)

DEMO_EMAIL = "demo@local"


def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Security(security),
    db: Session = Depends(get_db),
) -> User:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="Missing bearer token")
    if creds.credentials != settings.api_bearer_token:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.scalar(select(User).where(User.email == DEMO_EMAIL))
    if user is None:
        raise HTTPException(status_code=500, detail="Demo user not bootstrapped")
    return user
