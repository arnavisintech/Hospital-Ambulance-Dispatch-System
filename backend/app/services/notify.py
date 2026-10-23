"""Durable in-app notifications (WBS 4.5 without third-party SMS / push).

Rows are added to the caller's session; each one is pushed on the websocket topic ``user:{id}`` only after that
session commits (a rolled-back action never notifies anyone). Clients also fetch unread rows on (re)connect, so
nothing is lost while a device is offline.
"""
from __future__ import annotations

from sqlalchemy import event, select
from sqlalchemy.orm import Session

from .. import events
from ..models import CrewProfile, EmergencyRequest, HospitalStaffProfile, Notification, Role, User

_PENDING = "hads_pending_notifications"


def notification_out(n: Notification) -> dict:
    return {"id": n.id, "type": n.type, "title": n.title, "body": n.body, "data": n.data or {},
            "created_at": n.created_at.isoformat() if n.created_at else None,
            "read_at": n.read_at.isoformat() if n.read_at else None}


def _after_commit(session: Session) -> None:
    for n in session.info.pop(_PENDING, []):
        events.publish(f"user:{n.user_id}", "notification", notification_out(n))


def _after_rollback(session: Session) -> None:
    session.info.pop(_PENDING, None)


def _queue(db: Session, n: Notification) -> None:
    if _PENDING not in db.info:
        db.info[_PENDING] = []
        if not event.contains(db, "after_commit", _after_commit):
            event.listen(db, "after_commit", _after_commit)
            event.listen(db, "after_soft_rollback", lambda s, _tx: _after_rollback(s))
    db.info[_PENDING].append(n)


def notify_user(db: Session, user_id: int | None, type: str, title: str, body: str = "",
                data: dict | None = None) -> Notification | None:
    if not user_id:
        return None
    n = Notification(user_id=user_id, type=type, title=title[:120], body=(body or "")[:255], data=data or {})
    db.add(n)
    db.flush()
    _queue(db, n)
    return n


def _many(db: Session, user_ids, type: str, title: str, body: str, data: dict | None) -> list[Notification]:
    return [n for uid in dict.fromkeys(user_ids) if (n := notify_user(db, uid, type, title, body, data))]


def notify_role(db: Session, role: Role, type: str, title: str, body: str = "", data: dict | None = None):
    ids = db.execute(select(User.id).where(User.role == role, User.is_active.is_(True))).scalars()
    return _many(db, ids, type, title, body, data)


def notify_crew(db: Session, ambulance_id: int | None, type: str, title: str, body: str = "", data: dict | None = None):
    if not ambulance_id:
        return []
    ids = db.execute(select(CrewProfile.user_id).join(User, User.id == CrewProfile.user_id)
                     .where(CrewProfile.ambulance_id == ambulance_id, User.is_active.is_(True))).scalars()
    return _many(db, ids, type, title, body, data)


def notify_hospital(db: Session, hospital_id: int | None, type: str, title: str, body: str = "",
                    data: dict | None = None):
    if not hospital_id:
        return []
    ids = db.execute(select(HospitalStaffProfile.user_id).join(User, User.id == HospitalStaffProfile.user_id)
                     .where(HospitalStaffProfile.hospital_id == hospital_id, User.is_active.is_(True))).scalars()
    return _many(db, ids, type, title, body, data)


def notify_requester(db: Session, req: EmergencyRequest, type: str, title: str, body: str = "",
                     data: dict | None = None):
    return notify_user(db, req.requester_id, type, title, body, {"request_id": req.id, **(data or {})})
