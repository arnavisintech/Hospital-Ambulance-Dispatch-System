"""NFR7: append-only audit trail with a SHA-256 hash chain so tampering is detectable."""
import hashlib
import json
from datetime import timezone

from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .models import AUDIT_TRIGGERS, AuditLog, utcnow


def _digest(prev: str, ts: str, user_id, action: str, entity: str, entity_id, details: dict) -> str:
    body = json.dumps([prev, ts, user_id, action, entity, entity_id, details], sort_keys=True, default=str)
    return hashlib.sha256(body.encode()).hexdigest()


def log(db: Session, action: str, entity: str, entity_id=None, user_id: int | None = None, details: dict | None = None) -> AuditLog:
    """Add an audit row to the current session (caller commits)."""
    details = details or {}
    if db.get_bind().dialect.name == "postgresql":  # serialise chain appends across workers until commit
        db.execute(text("select pg_advisory_xact_lock(7242001)"))
    elif db.get_bind().dialect.name == "sqlite":  # take the write lock first so concurrent appenders can't fork the chain
        db.execute(text("update platform_settings set key = key where 0"))
    last =db.execute(select(AuditLog).order_by(AuditLog.id.desc()).limit(1)).scalar_one_or_none()
    prev = last.hash if last else ""
    ts = utcnow()
    row = AuditLog(ts=ts, user_id=user_id, action=action, entity=entity,
                   entity_id=str(entity_id) if entity_id is not None else None,
                   details=details, prev_hash=prev,
                   hash=_digest(prev, ts.isoformat(), user_id, action, entity,
                                str(entity_id) if entity_id is not None else None, details))
    db.add(row)
    db.flush()
    return row


def drop_immutability_triggers(db: Session) -> None:
    """TEST / DBA ONLY: remove the append-only triggers, simulating a privileged bypass the hash chain must catch."""
    for name in (*AUDIT_TRIGGERS, "audit_logs_no_truncate"):
        if db.get_bind().dialect.name == "postgresql":
            db.execute(text(f"DROP TRIGGER IF EXISTS {name} ON audit_logs"))
        else:
            db.execute(text(f"DROP TRIGGER IF EXISTS {name}"))
    db.commit()


def verify_chain(db: Session) -> dict:
    """Recompute the chain. Returns {'ok': bool, 'checked': n, 'broken_at': id|None}."""
    prev, n = "", 0
    for row in db.execute(select(AuditLog).order_by(AuditLog.id)).scalars():
        ts = (row.ts if row.ts.tzinfo else row.ts.replace(tzinfo=timezone.utc)).isoformat()  # SQLite drops tzinfo
        if row.prev_hash != prev or row.hash != _digest(prev, ts, row.user_id, row.action, row.entity, row.entity_id, row.details):
            return {"ok": False, "checked": n, "broken_at": row.id}
        prev, n = row.hash, n + 1
    return {"ok": True, "checked": n, "broken_at": None}
