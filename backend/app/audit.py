"""NFR7: append-only audit trail with a SHA-256 hash chain so tampering is detectable."""
import hashlib
import json
from datetime import timezone

from sqlalchemy import event, select, text
from sqlalchemy.orm import Session

from .models import AUDIT_TRIGGERS, AuditLog, utcnow


def _digest(prev: str, ts: str, user_id, action: str, entity: str, entity_id, details: dict) -> str:
    body = json.dumps([prev, ts, user_id, action, entity, entity_id, details], sort_keys=True, default=str)
    return hashlib.sha256(body.encode()).hexdigest()


_PENDING = "hads_pending_audit"


def log(db: Session, action: str, entity: str, entity_id=None, user_id: int | None = None, details: dict | None = None) -> None:
    """Record an audit entry in the current transaction (caller commits). The entry is appended to the hash chain at
    commit (see _append_pending), so the chain-wide lock is held only for the append and the commit itself, never
    across the rest of the caller's work: holding it mid-transaction made concurrent intakes and dispatch convoy."""
    # The innermost transaction owns the entry. A fresh session has not begun one yet (autobegin is lazy): begin it,
    # so the entry is never ownerless and a rollback always discards it.
    tx = db.get_nested_transaction() or db.get_transaction() or db.begin()
    db.info.setdefault(_PENDING, []).append(
        (tx, (utcnow(), user_id, action, entity, str(entity_id) if entity_id is not None else None, details or {})))


@event.listens_for(Session, "before_commit")
def _append_pending(db: Session) -> None:
    pending = db.info.pop(_PENDING, None)
    if not pending:
        return
    # Flush the transaction's own changes first, so the chain lock is the LAST lock it takes: a holder of the lock then
    # never waits on a row another committer holds while waiting for the lock (PostgreSQL deadlock, load test).
    db.flush()
    if db.get_bind().dialect.name == "postgresql":  # serialise chain appends across workers until commit
        db.execute(text("select pg_advisory_xact_lock(7242001)"))
    elif db.get_bind().dialect.name == "sqlite":  # take the write lock first so concurrent appenders can't fork the chain
        db.execute(text("update platform_settings set key = key where 0"))
    last = db.execute(select(AuditLog).order_by(AuditLog.id.desc()).limit(1)).scalar_one_or_none()
    prev = last.hash if last else ""
    for _tx, (ts, user_id, action, entity, entity_id, details) in pending:
        h = _digest(prev, ts.isoformat(), user_id, action, entity, entity_id, details)
        db.add(AuditLog(ts=ts, user_id=user_id, action=action, entity=entity, entity_id=entity_id,
                        details=details, prev_hash=prev, hash=h))
        db.flush()   # one at a time: ids follow chain order
        prev = h


def _within(tx, ancestor) -> bool:
    while tx is not None:
        if tx is ancestor:
            return True
        tx = tx.parent
    return False


@event.listens_for(Session, "after_soft_rollback")
def _discard_pending(db: Session, previous_transaction) -> None:
    """Drop only the entries logged inside the rolled-back transaction (or savepoints within it): a failed savepoint
    must not discard the audit entries of the enclosing transaction, which may still commit."""
    pending = db.info.get(_PENDING)
    if pending:
        db.info[_PENDING] = [e for e in pending if not _within(e[0], previous_transaction)]


@event.listens_for(Session, "after_transaction_end")
def _clear_on_end(db: Session, transaction) -> None:
    """Backstop: when the outermost transaction ends without its entries being appended (rollback, close), drop
    them; nothing pending may outlive the transaction that logged it."""
    if transaction.parent is None and db.info.get(_PENDING):
        db.info[_PENDING] = [e for e in db.info[_PENDING] if not _within(e[0], transaction)]


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
