"""Session revocation: bumping a user's token_version invalidates every issued token and unused websocket ticket;
once that commit lands, their already-open websockets are closed too (code 4401)."""
from __future__ import annotations

from sqlalchemy import event
from sqlalchemy.orm import Session

from .events import hub
from .models import User

_PENDING = "hads_revoked_users"


def _after_commit(session: Session) -> None:
    for uid in session.info.pop(_PENDING, set()):
        hub.revoke_user(uid)


def _after_rollback(session: Session) -> None:
    session.info.pop(_PENDING, None)


def revoke_sessions(db: Session, user: User) -> None:
    """Revoke all of `user`'s sessions (caller commits)."""
    user.token_version = (user.token_version or 0) + 1
    if _PENDING not in db.info:
        db.info[_PENDING] = set()
        if not event.contains(db, "after_commit", _after_commit):
            event.listen(db, "after_commit", _after_commit)
            event.listen(db, "after_soft_rollback", lambda s, _tx: _after_rollback(s))
    db.info[_PENDING].add(user.id)
