from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import audit as audit_mod
from ..db import get_db
from ..deps import require_roles
from ..models import AuditLog, Role, User

router = APIRouter(prefix="/api/audit", tags=["audit"])
_roles = require_roles(Role.admin, Role.authority)


@router.get("")
def list_audit(action: str | None = None, entity: str | None = None, limit: int = Query(50, ge=1, le=500),
               offset: int = Query(0, ge=0), db: Session = Depends(get_db), _: User = Depends(_roles)):
    """Newest first. `action` and `entity` match exactly, or by prefix when ending with '*' / '.'."""
    q = select(AuditLog)
    for col, val in ((AuditLog.action, action), (AuditLog.entity, entity)):
        if val:
            q = q.where(col.like(val.rstrip("*") + "%")) if val.endswith(("*", ".")) else q.where(col == val)
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rows = db.execute(q.order_by(AuditLog.id.desc()).limit(limit).offset(offset)).scalars().all()
    return {"total": total, "limit": limit, "offset": offset, "items": [
        {"id": r.id, "ts": r.ts.isoformat(), "user_id": r.user_id, "action": r.action, "entity": r.entity,
         "entity_id": r.entity_id, "details": r.details, "prev_hash": r.prev_hash, "hash": r.hash} for r in rows]}


@router.get("/verify")
def verify(db: Session = Depends(get_db), _: User = Depends(_roles)):
    return audit_mod.verify_chain(db)
