from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_roles
from ..models import RebalanceRecommendation, RebalanceStatus, Role, User
from ..services import rebalance as svc

router = APIRouter(prefix="/api/rebalance", tags=["rebalance"])
_roles = require_roles(Role.controller, Role.admin)


@router.get("/recommendations")
def list_recommendations(status: str | None = Query("pending"), db: Session = Depends(get_db), _: User = Depends(_roles)):
    q = select(RebalanceRecommendation).order_by(RebalanceRecommendation.expected_gain_seconds.desc(),
                                                 RebalanceRecommendation.id.desc())
    if status and status != "all":
        try:
            q = q.where(RebalanceRecommendation.status == RebalanceStatus(status))
        except ValueError:
            return []
    return [svc.rec_out(db, r) for r in db.execute(q.limit(200)).scalars()]


@router.post("/generate")
def generate(db: Session = Depends(get_db), user: User = Depends(_roles)):
    return [svc.rec_out(db, r) for r in svc.generate(db, user.id)]


@router.post("/{rec_id}/accept")
def accept(rec_id: int, db: Session = Depends(get_db), user: User = Depends(_roles)):
    return svc.rec_out(db, svc.accept(db, rec_id, user.id))


@router.post("/{rec_id}/dismiss")
def dismiss(rec_id: int, db: Session = Depends(get_db), user: User = Depends(_roles)):
    return svc.rec_out(db, svc.dismiss(db, rec_id, user.id))
