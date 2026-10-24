"""Provider-neutral interop API for external dispatch centres (Task 18, NFR8: 108/102-compatible exchange)."""
import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import ApiClient, AuditLog, EmergencyRequest, RequestStatus, Role, TripRecord
from conftest import PATIENT

INCIDENT = {"external_id": "108-TN-2026-000123", "caller_name": "Control room", "caller_phone": "108",
            "lat": PATIENT[0], "lng": PATIENT[1], "address": "Anna Salai", "nature": "trauma", "priority": 4,
            "notes": "two-wheeler collision"}


@pytest.fixture
def key(client, world):
    admin = world.user(Role.admin)
    r = client.post("/api/admin/api-clients", json={"name": "TN 108 CAD"}, headers=admin["h"])
    assert r.status_code == 201
    j = r.json()
    assert j["api_key"] and j["name"] == "TN 108 CAD"
    with SessionLocal() as db:
        row = db.get(ApiClient, j["id"])
        assert row.key_hash != j["api_key"] and len(row.key_hash) == 64   # only the hash is stored
    return {"id": j["id"], "h": {"X-API-Key": j["api_key"]}, "admin": admin}


def test_rejects_missing_or_bad_key(client):
    assert client.post("/api/interop/incidents", json=INCIDENT).status_code == 401
    assert client.post("/api/interop/incidents", json=INCIDENT, headers={"X-API-Key": "nope"}).status_code == 401


def test_create_is_idempotent_and_dispatches(client, world, key):
    h = world.hospital()
    st = world.station(h)
    world.ambulance(st)
    r1 = client.post("/api/interop/incidents", json=INCIDENT, headers=key["h"])
    assert r1.status_code == 201
    r2 = client.post("/api/interop/incidents", json=INCIDENT, headers=key["h"])
    assert r2.status_code == 200 and r2.json()["request_id"] == r1.json()["request_id"]
    with SessionLocal() as db:
        req = db.get(EmergencyRequest, r1.json()["request_id"])
        assert req.channel == "external" and req.external_id == INCIDENT["external_id"] and req.severity == 4
        assert req.status == RequestStatus.offered and req.incident_type.value == "trauma"
        assert db.execute(select(AuditLog).where(AuditLog.action == "interop.incident.create")).scalars().first()


def test_status_hides_caller_pii(client, key):
    client.post("/api/interop/incidents", json=INCIDENT, headers=key["h"])
    s = client.get(f"/api/interop/incidents/{INCIDENT['external_id']}", headers=key["h"])
    assert s.status_code == 200 and s.json()["external_id"] == INCIDENT["external_id"]
    assert "caller_phone" not in s.text and "Control room" not in s.text
    assert client.get("/api/interop/incidents/unknown-id", headers=key["h"]).status_code == 404


def test_outside_city_rejected(client, key):
    assert client.post("/api/interop/incidents", json={**INCIDENT, "lat": 28.6, "lng": 77.2},
                       headers=key["h"]).status_code == 422


def test_export_completed_since_without_pii(client, key):
    rid = client.post("/api/interop/incidents", json=INCIDENT, headers=key["h"]).json()["request_id"]
    with SessionLocal() as db:
        req = db.get(EmergencyRequest, rid)
        req.status = RequestStatus.completed
        db.add(TripRecord(request_id=rid, response_time_seconds=480))
        db.commit()
    rows = client.get("/api/interop/export?since=2000-01-01T00:00:00Z", headers=key["h"]).json()
    assert [r["external_id"] for r in rows] == [INCIDENT["external_id"]]
    assert rows[0]["response_time_seconds"] == 480 and "caller_phone" not in rows[0] and "caller_name" not in rows[0]
    assert client.get("/api/interop/export?since=2999-01-01T00:00:00Z", headers=key["h"]).json() == []


def test_rotate_and_deactivate(client, key):
    adm = key["admin"]["h"]
    new = client.post(f"/api/admin/api-clients/{key['id']}/rotate", headers=adm).json()["api_key"]
    assert client.get("/api/interop/export", headers=key["h"]).status_code == 401
    assert client.get("/api/interop/export", headers={"X-API-Key": new}).status_code == 200
    client.post(f"/api/admin/api-clients/{key['id']}/deactivate", headers=adm)
    assert client.get("/api/interop/export", headers={"X-API-Key": new}).status_code == 401


def test_centres_cannot_see_each_others_incidents(client, key):
    other = client.post("/api/admin/api-clients", json={"name": "TN 102 CAD"}, headers=key["admin"]["h"]).json()
    oh = {"X-API-Key": other["api_key"]}
    client.post("/api/interop/incidents", json=INCIDENT, headers=key["h"])
    assert client.get(f"/api/interop/incidents/{INCIDENT['external_id']}", headers=oh).status_code == 404
    # the same external id from another centre is a different incident, not a replay
    r = client.post("/api/interop/incidents", json=INCIDENT, headers=oh)
    assert r.status_code == 201


def test_api_client_admin_only(client, world):
    ctl = world.user(Role.controller)
    assert client.post("/api/admin/api-clients", json={"name": "x"}, headers=ctl["h"]).status_code == 403


def test_rate_limited_per_key(client, key, monkeypatch):
    from app.routers import interop
    monkeypatch.setattr(interop.INTEROP_LIMIT, "limit", 3)
    codes = [client.get("/api/interop/export", headers=key["h"]).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]
