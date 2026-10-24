import pytest
from sqlalchemy import select, text

from ops_helpers import Env
from app import audit
from app.models import AuditLog


@pytest.fixture(scope="module")
def env():
    return Env()


def test_roles(env):
    c = env.client
    for who in ("admin@hads.in", "authority@hads.in"):
        assert c.get("/api/audit", headers=env.as_(who)).status_code == 200
        assert c.get("/api/audit/verify", headers=env.as_(who)).status_code == 200
    for who in ("controller@hads.in", "user@hads.in", "staff1@hads.in", "crew1@hads.in"):
        assert c.get("/api/audit", headers=env.as_(who)).status_code == 403
        assert c.get("/api/audit/verify", headers=env.as_(who)).status_code == 403
    assert c.get("/api/audit").status_code == 401


def test_list_filter_paginate(env):
    c, h = env.client, env.as_("admin@hads.in")
    c.post("/api/rebalance/generate", headers=h)
    c.put("/api/admin/settings", json={"base_fare": 700}, headers=h)
    j = c.get("/api/audit?limit=2", headers=h).json()
    assert j["total"] >= 3 and len(j["items"]) == 2 and j["items"][0]["id"] > j["items"][1]["id"]
    only = c.get("/api/audit?action=admin.settings.update", headers=h).json()
    assert only["total"] == 1 and only["items"][0]["details"]["base_fare"] == {"from": 500.0, "to": 700.0}
    assert c.get("/api/audit?entity=settings", headers=h).json()["total"] == 1
    assert c.get("/api/audit?action=rebalance.", headers=h).json()["total"] >= 1      # prefix match
    p2 = c.get("/api/audit?limit=2&offset=2", headers=h).json()
    assert p2["items"][0]["id"] < j["items"][1]["id"]
    assert c.get("/api/audit?limit=0", headers=h).status_code == 422


def test_verify_chain_ok_and_detects_tampering(env):
    c, h = env.client, env.as_("authority@hads.in")
    v = c.get("/api/audit/verify", headers=h).json()
    assert v["broken_at"] is None and v["ok"] and v["checked"] > 0
    with env.db() as db:
        audit.drop_immutability_triggers(db)  # privileged bypass: the database alone would refuse this edit
        row = db.execute(select(AuditLog).order_by(AuditLog.id)).scalars().first()
        rid = row.id
        row.details = {"tampered": True}
        db.commit()
    v = c.get("/api/audit/verify", headers=h).json()
    assert v["ok"] is False and v["broken_at"] == rid
