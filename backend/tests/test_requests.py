import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, EmergencyRequest, Role
from conftest import PATIENT, sos


def test_intake_validation(client, world):
    u = world.user()
    h = u["h"]
    assert client.post("/api/requests", json={"lat": 99, "lng": 80, "severity": 3}, headers=h).status_code == 422
    assert client.post("/api/requests", json={"lat": 13, "lng": 80, "severity": 9}, headers=h).status_code == 422
    assert client.post("/api/requests", json={"lat": 13, "lng": 80, "incident_type": "alien"}, headers=h).status_code == 422
    assert client.post("/api/requests", json={"lat": 13, "lng": 80}).status_code == 401


def test_create_without_ambulance_escalates_a1(client, world, published):
    u = world.user()
    r = sos(client, u["h"], client_uuid="u-1", address="Anna Salai, manual", caller_name="Ravi")
    assert r.status_code == 201
    got = client.get(f"/api/requests/{r.json()['id']}", headers=u["h"]).json()
    assert got["status"] == "awaiting_manual" and got["ambulance"] is None
    assert any(t == "controller" and ty == "dispatch.escalated" for t, ty, _ in published)
    assert any(ty == "request.created" for _, ty, _ in published)
    with SessionLocal() as db:
        actions = [a.action for a in db.execute(select(AuditLog)).scalars()]
    assert "request.create" in actions and "dispatch.escalate" in actions


def test_idempotent_client_uuid(client, world):
    u = world.user()
    a = sos(client, u["h"], client_uuid="retry-1")
    b = sos(client, u["h"], client_uuid="retry-1")
    assert a.status_code == 201 and b.status_code == 200 and a.json()["id"] == b.json()["id"]
    with SessionLocal() as db:
        assert len(db.execute(select(EmergencyRequest)).scalars().all()) == 1
    other = world.user()
    assert sos(client, other["h"], client_uuid="retry-1").status_code == 409  # not leaked to a stranger


def test_role_checks_on_create(client, world):
    b = world.basic()
    crew = world.crew(world.ambulance(b["station"]))
    staff = world.user(Role.hospital_staff, hospital_id=b["hospital"])
    assert sos(client, crew["h"]).status_code == 403
    assert sos(client, staff["h"]).status_code == 403
    ctl = world.user(Role.controller)
    assert sos(client, ctl["h"]).status_code == 201
    assert client.post("/api/requests/ivr", json={"lat": 13, "lng": 80}, headers=world.user()["h"]).status_code == 403


def test_ivr_by_controller(client, world):
    ctl = world.user(Role.controller)
    r = client.post("/api/requests/ivr", json={"lat": PATIENT[0], "lng": PATIENT[1], "severity": 4, "incident_type": "cardiac",
                                              "caller_name": "Mrs K", "caller_phone": "9000000001", "channel": "app"},
                    headers=ctl["h"])
    assert r.status_code == 201
    body = r.json()
    assert body["channel"] == "ivr" and body["caller_phone"] == "9000000001" and body["requester_id"] is None


def test_access_control_and_mine(client, world):
    a, b = world.user(), world.user()
    rid = sos(client, a["h"]).json()["id"]
    assert client.get(f"/api/requests/{rid}", headers=a["h"]).status_code == 200
    assert client.get(f"/api/requests/{rid}", headers=b["h"]).status_code == 403
    assert client.get(f"/api/requests/{rid}", headers=world.user(Role.controller)["h"]).status_code == 200
    assert client.get(f"/api/requests/{rid}", headers=world.user(Role.authority)["h"]).status_code == 200
    assert client.get("/api/requests/9999", headers=a["h"]).status_code == 404
    assert [x["id"] for x in client.get("/api/requests/mine", headers=a["h"]).json()] == [rid]
    assert client.get("/api/requests/mine", headers=b["h"]).json() == []


def test_cancel_rules(client, world):
    a, b = world.user(), world.user()
    rid = sos(client, a["h"]).json()["id"]
    assert client.post(f"/api/requests/{rid}/cancel", headers=b["h"]).status_code == 403
    r = client.post(f"/api/requests/{rid}/cancel", json={"reason": "false alarm"}, headers=a["h"])
    assert r.status_code == 200 and r.json()["status"] == "cancelled"
    assert client.post(f"/api/requests/{rid}/cancel", headers=a["h"]).status_code == 409  # forward-only


def test_stranger_hospital_staff_cannot_view(client, world):
    b = world.basic()
    staff = world.user(Role.hospital_staff, hospital_id=b["hospital"])
    rid = sos(client, world.user()["h"]).json()["id"]
    assert client.get(f"/api/requests/{rid}", headers=staff["h"]).status_code == 403


# ---------------------------------------------------------------- Task 13: patient age group (optional)
@pytest.mark.parametrize("age", ["child", "adult", "senior", "elderly", "unknown"])
def test_age_group_round_trip(client, world, age):
    u = world.user(Role.requester)
    r = sos(client, u["h"], patient_age_group=age)
    assert r.status_code == 201 and r.json()["patient_age_group"] == age


def test_age_group_defaults_and_validates(client, world):
    u = world.user(Role.requester)
    assert sos(client, u["h"]).json()["patient_age_group"] == "unknown"
    assert sos(client, u["h"], patient_age_group="toddler").status_code == 422


def test_outcome_feeds_age_group_into_history(client, world):
    from app.db import SessionLocal
    from app.models import EmergencyRequest, IncidentHistory, TripRecord
    from app.services import analytics
    from sqlalchemy import select
    u = world.user(Role.requester)
    rid = sos(client, u["h"], patient_age_group="elderly").json()["id"]
    with SessionLocal() as db:
        req = db.get(EmergencyRequest, rid)
        analytics.record_outcome(db, req, TripRecord(request_id=rid, response_time_seconds=420))
        db.commit()
        row = db.execute(select(IncidentHistory).where(IncidentHistory.source == "live")).scalars().one()
    assert row.patient_age_group == "elderly"
