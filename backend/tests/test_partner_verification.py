"""Hospital partner verification (Task 7, STRQ2): new partners stay out of routing until an admin verifies them."""
from app.db import SessionLocal
from app.models import AuditLog, EmergencyRequest, Hospital, IncidentType, Role
from app.services import capacity
from conftest import PATIENT, sos
from sqlalchemy import select

BODY = {"name": "New Partner Hospital", "address": "OMR", "registration_number": "TN-CEA-2026-0042",
        "lat": PATIENT[0] + 0.01, "lng": PATIENT[1], "total_beds": 40, "total_icu": 6,
        "specialists": {"cardiology": 1, "neurology": 1, "trauma": 1, "obstetrics": 1}}


def _create(client, admin):
    r = client.post("/api/admin/hospitals", json=BODY, headers=admin["h"])
    assert r.status_code == 201, r.text
    return r.json()


def _ranked_ids(hid_req):
    with SessionLocal() as db:
        req = EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], incident_type=IncidentType.other, severity=3)
        ranking, _ = capacity.rank_hospitals(db, req)
        return [r["hospital"].id for r in ranking]


def test_new_hospital_is_pending_and_not_routed(client, world):
    admin = world.user(Role.admin)
    h = _create(client, admin)
    assert h["partner_verified"] is False and h["registration_number"] == "TN-CEA-2026-0042"
    assert h["id"] not in _ranked_ids(None)


def test_verify_then_suspend(client, world):
    admin = world.user(Role.admin)
    hid = _create(client, admin)["id"]
    r = client.post(f"/api/admin/hospitals/{hid}/verify", headers=admin["h"])
    assert r.status_code == 200 and r.json()["partner_verified"] is True and r.json()["verified_at"]
    assert hid in _ranked_ids(None)
    assert client.post(f"/api/admin/hospitals/{hid}/suspend", headers=admin["h"]).json()["partner_verified"] is False
    assert hid not in _ranked_ids(None)
    with SessionLocal() as db:
        actions = set(db.execute(select(AuditLog.action).where(AuditLog.entity == "hospital")).scalars())
    assert {"admin.hospital.verify", "admin.hospital.suspend"} <= actions


def test_only_admin_can_verify(client, world):
    admin, ctl = world.user(Role.admin), world.user(Role.controller)
    hid = _create(client, admin)["id"]
    assert client.post(f"/api/admin/hospitals/{hid}/verify", headers=ctl["h"]).status_code == 403


def test_registration_number_required(client, world):
    admin = world.user(Role.admin)
    body = {k: v for k, v in BODY.items() if k != "registration_number"}
    assert client.post("/api/admin/hospitals", json=body, headers=admin["h"]).status_code == 422


def test_unverified_staff_cannot_update_capacity(client, world):
    admin = world.user(Role.admin)
    hid = _create(client, admin)["id"]
    staff = world.user(Role.hospital_staff, hospital_id=hid)
    r = client.put(f"/api/hospitals/{hid}/capacity", json={"available_beds": 5, "available_icu": 1}, headers=staff["h"])
    assert r.status_code == 403


def test_controller_cannot_route_to_unverified(client, world):
    admin, ctl, user = world.user(Role.admin), world.user(Role.controller), world.user(Role.requester)
    hid = _create(client, admin)["id"]
    rid = sos(client, user["h"]).json()["id"]
    r = client.post(f"/api/controller/requests/{rid}/destination", json={"hospital_id": hid}, headers=ctl["h"])
    assert r.status_code == 404


def test_public_hospital_list_shows_verified_only(client, world):
    admin, user = world.user(Role.admin), world.user(Role.requester)
    verified = world.hospital()
    hid = _create(client, admin)["id"]
    ids = {h["id"] for h in client.get("/api/hospitals", headers=user["h"]).json()}
    assert verified in ids and hid not in ids
    with SessionLocal() as db:
        assert db.get(Hospital, hid) is not None
