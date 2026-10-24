"""NFR7: the audit trail is append-only at the database level, and its export is verifiable (Task 21)."""
import hashlib
import io
import json

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DatabaseError

from app import audit
from app.audit_export import export_audit
from app.db import SessionLocal


def _seed(n=3):
    with SessionLocal() as db:
        for i in range(n):
            audit.log(db, "test.action", "thing", i, None, {"i": i})
        db.commit()


@pytest.mark.parametrize("sql", ["UPDATE audit_logs SET action = 'x'", "DELETE FROM audit_logs"])
def test_update_and_delete_are_rejected_by_the_database(sql):
    _seed()
    with SessionLocal() as db:
        with pytest.raises(DatabaseError, match="append-only"):
            db.execute(text(sql))
        db.rollback()
        assert db.execute(text("SELECT count(*) FROM audit_logs")).scalar() == 3


def test_inserts_still_work_and_chain_verifies():
    _seed(5)
    with SessionLocal() as db:
        assert audit.verify_chain(db) == {"ok": True, "checked": 5, "broken_at": None}


def test_export_is_jsonl_with_matching_sha256():
    _seed(4)
    buf = io.StringIO()
    with SessionLocal() as db:
        out = export_audit(db, buf)
    data = buf.getvalue()
    lines = data.splitlines()
    assert len(lines) == 4 and [json.loads(x)["entity_id"] for x in lines] == ["0", "1", "2", "3"]
    assert {"id", "ts", "user_id", "action", "entity", "entity_id", "details", "prev_hash", "hash"} <= set(json.loads(lines[0]))
    assert out["rows"] == 4 and out["chain_ok"] is True
    assert out["first_id"] == json.loads(lines[0])["id"] and out["last_id"] == json.loads(lines[-1])["id"]
    assert out["sha256"] == hashlib.sha256(data.encode("utf-8")).hexdigest()


def test_export_of_tampered_chain_reports_failure():
    _seed(3)
    with SessionLocal() as db:
        audit.drop_immutability_triggers(db)   # a privileged DBA bypass: the hash chain must still catch it
        db.execute(text("UPDATE audit_logs SET details = '{\"forged\": true}' WHERE id = 2"))
        db.commit()
        out = export_audit(db, io.StringIO())
    assert out["chain_ok"] is False and out["broken_at"] == 2


def test_export_script_exits_non_zero_on_broken_chain(tmp_path, monkeypatch):
    import scripts.export_audit as script
    _seed(2)
    good = tmp_path / "ok.jsonl"
    assert script.main(["--out", str(good)]) == 0 and good.read_text(encoding="utf-8").count("\n") == 2
    with SessionLocal() as db:
        audit.drop_immutability_triggers(db)
        db.execute(text("DELETE FROM audit_logs WHERE id = 1"))
        db.commit()
    assert script.main(["--out", str(tmp_path / "bad.jsonl")]) == 1
