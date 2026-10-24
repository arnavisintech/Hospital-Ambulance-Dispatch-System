"""FR11 operational dashboard and compliance / equity report (computations in services/kpis.py, services/reports.py)."""
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import require_roles
from ..models import Role, User, utcnow
from ..services import kpis, reports

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


@router.get("/summary")
def summary(days: int = Query(7, ge=1, le=365), db: Session = Depends(get_db),
            _: User = Depends(require_roles(Role.admin, Role.authority, Role.controller))):
    return kpis.summary(db, days)


@router.get("/report.csv")
def report_csv(days: int = Query(30, ge=1, le=365), db: Session = Depends(get_db),
               _: User = Depends(require_roles(Role.admin, Role.authority))):
    """Compliance (SRS targets) and equity (response by zone senior-share quartile) for the last `days` days."""
    body = reports.report_csv(db, days)
    name = f"hads-compliance-{utcnow():%Y%m%d}-{days}d.csv"
    return Response(body, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})
