"""Compliance and equity CSV exports (Task 19)."""
import csv
import io

import pytest

from ops_helpers import Env


@pytest.fixture(scope="module")
def env():
    return Env()


def _csv(r):
    return list(csv.reader(io.StringIO(r.text)))


def test_report_csv_header_and_type(env):
    r = env.client.get("/api/dashboard/report.csv?days=30", headers=env.as_("authority@hads.in"))
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert "attachment" in r.headers["content-disposition"]
    rows = _csv(r)
    assert rows[0] == ["section", "metric", "target", "value", "met"]
    metrics = [row[1] for row in rows if row[0] == "compliance"]
    assert len(metrics) == 5 and any("audit" in m.lower() for m in metrics)


def test_report_roles(env):
    c = env.client
    assert c.get("/api/dashboard/report.csv", headers=env.as_("admin@hads.in")).status_code == 200
    assert c.get("/api/dashboard/report.csv", headers=env.as_("controller@hads.in")).status_code == 403
    assert c.get("/api/audit/export.csv", headers=env.as_("controller@hads.in")).status_code == 403


def test_compliance_matches_dashboard_summary(env):
    from app.services import reports
    s = env.client.get("/api/dashboard/summary?days=30", headers=env.as_("admin@hads.in")).json()
    with env.db() as db:
        rows = {r["key"]: r for r in reports.compliance_rows(db, 30)}
    assert rows["dispatch_within_target"]["value"] == s["sla"]["within_target_pct"]
    assert rows["response_p90"]["value"] == s["kpis"]["p90_response_s"]
    assert rows["audit_chain"]["met"] is True
    assert set(rows) == {"response_p90", "dispatch_within_target", "redirect_avoided", "handover_logged", "audit_chain"}


def test_equity_has_four_quartiles_and_unknown(env):
    from app.models import EmergencyRequest, RequestStatus, TripRecord
    from app.services import reports
    with env.db() as db:  # an incident in a zone with no demographics row lands in "unknown"
        req = EmergencyRequest(lat=13.249, lng=80.349, status=RequestStatus.completed)
        db.add(req)
        db.flush()
        db.add(TripRecord(request_id=req.id, response_time_seconds=600))
        db.commit()
        rows = reports.equity_rows(db, 30)
    groups = [r["group"] for r in rows]
    assert groups == ["Q1 (fewest seniors)", "Q2", "Q3", "Q4 (most seniors)", "unknown"]
    assert rows[-1]["requests"] >= 1
    assert sum(r["requests"] for r in rows[:4]) > 50
    for r in rows[:4]:
        assert r["senior_share_min"] <= r["senior_share_max"]
        assert r["median_response_s"] is None or r["median_response_s"] > 0


def test_csv_cells_are_formula_safe():
    from app.services.reports import to_csv
    out = to_csv(["a", "b"], [["=cmd|' /C calc'!A0", "-1"], ["@x", "safe"]])
    rows = list(csv.reader(io.StringIO(out)))
    assert rows[1] == ["'=cmd|' /C calc'!A0", "-1"]   # numbers stay numbers
    assert rows[2] == ["'@x", "safe"]


def test_csv_negative_text_and_plus_are_escaped():
    from app.services.reports import to_csv
    rows = list(csv.reader(io.StringIO(to_csv(["a"], [["+SUM(A1)"], ["-x"], [-2.5]]))))
    assert [r[0] for r in rows[1:]] == ["'+SUM(A1)", "'-x", "-2.5"]


def test_audit_export_filters_and_hashes(env):
    from app import audit
    with env.db() as db:
        audit.log(db, "report.test.one", "thing", 1, None, {"note": "=HYPERLINK(\"x\")"})
        audit.log(db, "report.test.two", "thing", 2, None, {})
        audit.log(db, "report.test.one", "other", 3, None, {})
        db.commit()
    r = env.client.get("/api/audit/export.csv?action=report.test.one", headers=env.as_("authority@hads.in"))
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    rows = _csv(r)
    assert rows[0] == ["id", "ts", "user_id", "action", "entity", "entity_id", "details", "prev_hash", "hash"]
    assert [row[3] for row in rows[1:]] == ["report.test.one", "report.test.one"]
    assert all(len(row[8]) == 64 and len(row[7]) == 64 for row in rows[1:])
    assert not rows[1][6].startswith("=")   # JSON details are never a live formula
    both = _csv(env.client.get("/api/audit/export.csv?action=report.test.one&entity=other", headers=env.as_("admin@hads.in")))
    assert [row[5] for row in both[1:]] == ["3"]
    none = _csv(env.client.get("/api/audit/export.csv?action=no.such.action", headers=env.as_("admin@hads.in")))
    assert len(none) == 1
