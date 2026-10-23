"""In-app notifications for the signed-in user (own rows only)."""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import current_user
from ..models import Notification, User, utcnow
from ..services.notify import notification_out

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("")
def list_notifications(unread: bool | None = None, limit: int = Query(50, ge=1, le=200),
                       user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = select(Notification).where(Notification.user_id == user.id)
    if unread is True:
        q = q.where(Notification.read_at.is_(None))
    elif unread is False:
        q = q.where(Notification.read_at.is_not(None))
    return [notification_out(n) for n in db.execute(q.order_by(Notification.id.desc()).limit(limit)).scalars()]


@router.get("/count")
def unread_count(user: User = Depends(current_user), db: Session = Depends(get_db)):
    n = db.scalar(select(func.count(Notification.id)).where(Notification.user_id == user.id,
                                                            Notification.read_at.is_(None)))
    return {"unread": n or 0}


@router.post("/read-all")
def read_all(user: User = Depends(current_user), db: Session = Depends(get_db)):
    res = db.execute(update(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None))
                     .values(read_at=utcnow()))
    db.commit()
    return {"marked": res.rowcount or 0}


@router.post("/{notification_id}/read")
def read_one(notification_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    n = db.get(Notification, notification_id)
    if n is None or n.user_id != user.id:
        raise HTTPException(404, "Notification not found")
    if n.read_at is None:
        n.read_at = utcnow()
        db.commit()
    return notification_out(n)
