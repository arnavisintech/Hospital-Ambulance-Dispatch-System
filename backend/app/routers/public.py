"""Unauthenticated endpoints (v2 section 4): family share-link tracking."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..services import sharing, tracking

router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/track/{token}")
def public_track(token: str, db: Session = Depends(get_db)):
    req = sharing.resolve(db, token)
    if req is None:
        raise HTTPException(404, "Link not found or expired")
    out = tracking.public_payload(db, req)
    db.commit()
    return out
