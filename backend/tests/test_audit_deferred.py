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


def test_a_failed_savepoint_keeps_the_outer_transactions_audit_entries(client):
    """Security review: a rolled-back nested savepoint must not discard audit entries of the enclosing transaction."""
    with SessionLocal() as db:
        before = db.scalar(select(func.count(AuditLog.id)))
        audit.log(db, "t.outer", "thing", 1, None, {})
        sp = db.begin_nested()
        audit.log(db, "t.inner", "thing", 2, None, {})
        sp.rollback()
        db.commit()
        actions = db.execute(select(AuditLog.action).order_by(AuditLog.id.desc()).limit(1)).scalars().all()
        assert db.scalar(select(func.count(AuditLog.id))) == before + 1
        assert actions == ["t.outer"]


def test_entry_logged_first_in_a_fresh_session_is_discarded_by_rollback(client):
    """Security review: audit.log as the first call of a session (no transaction begun yet) must still be owned by a
    transaction, or a rollback would leave it pending and a later commit would record an action that never happened."""
    with SessionLocal() as db:
        before = db.scalar(select(func.count(AuditLog.id)))
    with SessionLocal() as db:
        audit.log(db, "t.ghost", "thing", 1, None, {})
        db.rollback()
        audit.log(db, "t.real", "thing", 2, None, {})
        db.commit()
    with SessionLocal() as db:
        assert db.scalar(select(func.count(AuditLog.id))) == before + 1
        assert db.execute(select(AuditLog.action).order_by(AuditLog.id.desc()).limit(1)).scalar() == "t.real"


def test_closing_without_commit_leaves_nothing_pending(client):
    db = SessionLocal()
    audit.log(db, "t.abandoned", "thing", 1, None, {})
    db.close()
    assert not db.info.get("hads_pending_audit")


def test_commit_never_waits_on_a_row_while_holding_the_audit_lock(client, world):
    """PostgreSQL load test: before_commit took the chain lock and only then flushed the transaction's own updates,
    so a cancel holding the lock waited on a hospital row that another committer held while waiting for the lock:
    PostgreSQL aborted the cancel (DeadlockDetected, 500). Pending changes must be flushed before the lock."""
    import threading

    import pytest

    from app.models import Hospital
    if SessionLocal().bind.dialect.name != "postgresql":
        pytest.skip("row and advisory lock ordering only exist on PostgreSQL")
    hid = world.hospital(icu=5)
    a, b = SessionLocal(), SessionLocal()
    errors = []
    try:
        a.get(Hospital, hid).available_icu = 4      # A updates the hospital row first (row lock held)...
        a.flush()

        def b_commits():
            try:
                audit.log(b, "t.b", "thing", 2, None, {})
                b.get(Hospital, hid).available_icu = 3
                b.commit()                           # ...B must wait for that row WITHOUT holding the chain lock
            except Exception as e:  # noqa: BLE001
                errors.append(e)
                b.rollback()
        t = threading.Thread(target=b_commits)
        t.start()
        t.join(1.5)                                  # let B reach its commit and block on A's row
        audit.log(a, "t.a", "thing", 1, None, {})
        a.commit()                                   # A now needs the chain lock: with the bug, B holds it -> deadlock
        t.join(10)
        assert not t.is_alive() and errors == [], errors
    finally:
        a.close()
        b.close()
