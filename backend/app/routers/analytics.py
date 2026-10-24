from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from .. import audit
from ..db import get_db
from ..deps import require_roles
from ..models import Hospital, Role, User
from ..services import analytics as svc, trips

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/risk-map")
def risk_map(hour: int | None = Query(None, ge=0, le=23), db: Session = Depends(get_db),
             _: User = Depends(require_roles(Role.controller, Role.admin, Role.authority))):
    return svc.risk_map(db, hour)


@router.post("/retrain")
def retrain(db: Session = Depends(get_db), user: User = Depends(require_roles(Role.admin))):
    try:
        metrics = svc.train_model(db)
    except ValueError as e:
        raise HTTPException(422, str(e))
    except RuntimeError as e:
        raise HTTPException(409, str(e))
    audit.log(db, "analytics.retrain", "model", metrics["model_version"], user.id,
              {k: metrics[k] for k in ("mae", "r2", "n_train", "n_live")})
    db.commit()
    return metrics


@router.get("/model")
def model(db: Session = Depends(get_db), _: User = Depends(require_roles(Role.controller, Role.admin, Role.authority))):
    return svc.model_info(db)


@router.get("/hospitals/{hospital_id}/area")
def hospital_area(hospital_id: int, radius_km: float = Query(5.0, gt=0, le=25), hour: int | None = Query(None, ge=0, le=23),
                  db: Session = Depends(get_db), user: User = Depends(require_roles(Role.hospital_staff, Role.admin))):
    """Demand forecast around a partner hospital (hospital analytics): its own staff, or an admin."""
    if user.role == Role.hospital_staff and trips.user_hospital_id(db, user) != hospital_id:
        raise HTTPException(403, "Not permitted for this hospital")
    h = db.get(Hospital, hospital_id)
    if h is None:
        raise HTTPException(404, "Hospital not found")
    return {"hospital_id": hospital_id, **svc.area_demand(db, h.lat, h.lng, radius_km, hour)}
