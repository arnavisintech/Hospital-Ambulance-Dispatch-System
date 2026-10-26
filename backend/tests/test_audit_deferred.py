"""PostgreSQL load test finding: audit.log took the global chain lock mid-transaction and held it until commit, so a
dispatch (three audit rows around bed reservation and crew notification) and 40 concurrent intakes formed a lock convoy
(25 sessions waiting on the advisory lock). Chain appends now happen only at commit, holding the lock for the minimum."""
from sqlalchemy import event, func, select

from app import audit
from app.db import SessionLocal, engine
from app.models import AuditLog


def _audit_statements(fn):
    seen = []

    def _log(conn, cursor, statement, *a):
        s = statement.lower()
        if "audit_logs" in s or "advisory" in s or "set key = key" in s:
            seen.append(s)
    event.listen(engine, "before_cursor_execute", _log)
    try:
        fn()
    finally:
        event.remove(engine, "before_cursor_execute", _log)
    return seen


def test_audit_log_touches_nothing_until_commit(client):
    with SessionLocal() as db:
        before = db.scalar(select(func.count(AuditLog.id)))
        assert _audit_statements(lambda: [audit.log(db, "t.one", "thing", 1, None, {}),
                                          audit.log(db, "t.two", "thing", 2, None, {})]) == []
        assert _audit_statements(db.commit)   # lock, chain read and inserts happen inside the commit
        rows = db.execute(select(AuditLog).order_by(AuditLog.id.desc()).limit(2)).scalars().all()
        assert [r.action for r in reversed(rows)] == ["t.one", "t.two"]
        assert db.scalar(select(func.count(AuditLog.id))) == before + 2
        assert audit.verify_chain(db)["ok"]


def test_rolled_back_audit_entries_are_discarded(client):
    with SessionLocal() as db:
        before = db.scalar(select(func.count(AuditLog.id)))
        audit.log(db, "t.never", "thing", 1, None, {})
        db.rollback()
        audit.log(db, "t.kept", "thing", 2, None, {})
        db.commit()
        assert db.scalar(select(func.count(AuditLog.id))) == before + 1
        assert db.execute(select(AuditLog.action).order_by(AuditLog.id.desc()).limit(1)).scalar() == "t.kept"
