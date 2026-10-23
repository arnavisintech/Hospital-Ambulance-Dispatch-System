"""Unauthenticated endpoints: client configuration and family share-link tracking (v2 section 4)."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
from ..models import User
from ..services import sharing, tracking

router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/config")
def client_config(db: Session = Depends(get_db)):
    """What the login page may offer. Demo accounts and their password are exposed only in demo mode."""
    if not get_settings().is_demo:
        return {"demo_mode": False, "demo_password": None, "demo_accounts": []}
    from ..seed import DEMO_ACCOUNTS, DEMO_PASSWORD
    emails = [a[2] for a in DEMO_ACCOUNTS]
    active = set(db.execute(select(User.email).where(User.email.in_(emails), User.is_active.is_(True))).scalars())
    accounts = [{"role": r, "label": label, "email": e, "hint": hint}
                for r, label, e, hint in DEMO_ACCOUNTS if e in active]
    return {"demo_mode": True, "demo_password": DEMO_PASSWORD if accounts else None, "demo_accounts": accounts}


@router.get("/track/{token}")
def public_track(token: str, db: Session = Depends(get_db)):
    req = sharing.resolve(db, token)
    if req is None:
        raise HTTPException(404, "Link not found or expired")
    out = tracking.public_payload(db, req)
    db.commit()
    return out
