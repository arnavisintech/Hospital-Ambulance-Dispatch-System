"""DPDP Act: consent on registration, export of one's own data, account erasure (Task 10, NFR3/STRQ3)."""
from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, EmergencyRequest, RequestStatus, Role, TripRecord, User
from conftest import PATIENT, sos

REG = {"name": "Kavya", "email": "kavya@hads.test", "password": "password123"}


def test_register_requires_consent(client):
    assert client.post("/api/auth/register", json=REG).status_code == 422
    assert client.post("/api/auth/register", json={**REG, "consent": False}).status_code == 422
    r = client.post("/api/auth/register", json={**REG, "consent": True})
    assert r.status_code == 201
    with SessionLocal() as db:
        assert db.get(User, r.json()["user"]["id"]).consented_at is not None


def test_guest_sos_needs_no_consent(client):
    assert client.post("/api/auth/guest", json={}).status_code == 201


def test_export_contains_only_own_data(client, world):
    a, b = world.user(Role.requester), world.user(Role.requester)
    ra = sos(client, a["h"], notes="mine").json()["id"]
    sos(client, b["h"], notes="theirs")
    r = client.get("/api/auth/me/export", headers=a["h"])
    assert r.status_code == 200
    j = r.json()
    assert j["user"]["id"] == a["id"] and [x["id"] for x in j["requests"]] == [ra]
    assert j["requests"][0]["notes"] == "mine" and "trips" in j and "bills" in j
    assert "theirs" not in r.text


def _finish(rid):
    with SessionLocal() as db:
        req = db.get(EmergencyRequest, rid)
        req.status = RequestStatus.completed
        db.add(TripRecord(request_id=rid))
        db.commit()


def test_erase_refused_while_request_active(client, world):
    u = world.user(Role.requester)
    sos(client, u["h"])
    r = client.request("DELETE", "/api/auth/me", json={"password": world.password}, headers=u["h"])
    assert r.status_code == 409


def test_erase_wrong_password(client, world):
    u = world.user(Role.requester)
    assert client.request("DELETE", "/api/auth/me", json={"password": "nope-nope"}, headers=u["h"]).status_code == 403


def test_erase_anonymises_and_keeps_records(client, world):
    u = world.user(Role.requester, phone="9840099999")
    rid = sos(client, u["h"], caller_name="Kavya R", notes="asthma", address="Adyar").json()["id"]
    _finish(rid)
    r = client.request("DELETE", "/api/auth/me", json={"password": world.password}, headers=u["h"])
    assert r.status_code == 200
    with SessionLocal() as db:
        usr = db.get(User, u["id"])
        assert usr.name == "Erased user" and usr.email is None and usr.phone is None
        assert usr.is_active is False and usr.erased_at is not None and usr.token_version >= 1
        req = db.get(EmergencyRequest, rid)
        assert (req.caller_name, req.caller_phone, req.notes, req.address) == (None, None, None, None)
        assert db.execute(select(TripRecord).where(TripRecord.request_id == rid)).scalar_one() is not None
        assert db.execute(select(AuditLog).where(AuditLog.action == "auth.erase")).scalar_one().entity_id == str(u["id"])
    assert client.get("/api/auth/me", headers=u["h"]).status_code == 401
    assert client.post("/api/auth/login", json={"identifier": u["email"], "password": world.password}).status_code == 401


def test_erase_clears_every_identifying_trace(client, world):
    """Final review: erasure also clears insurance policy details, free-text feedback and cancel reasons, removes the
    person's notifications and coarsens exact pickup coordinates (often a home address) to about 1 km."""
    from app.models import BillingRecord, InsuranceClaim, Notification, RequestEvent
    u = world.user(Role.requester, phone="9840098888")
    rid = sos(client, u["h"], caller_name="Kavya R").json()["id"]
    _finish(rid)
    with SessionLocal() as db:
        trip = db.execute(select(TripRecord).where(TripRecord.request_id == rid)).scalar_one()
        trip.summary = {**(trip.summary or {}), "feedback": {"rating": 5, "comment": "Thanks, my mother at 12 Lake St is fine"}}
        bill = BillingRecord(trip_id=trip.id, amount=500, base_fare=500, distance_charge=0, surcharge=0,
                             hospital_share=350, platform_share=150)
        db.add(bill)
        db.flush()
        db.add(InsuranceClaim(bill_id=bill.id, insurer="Star Health", policy_number="SH-77812345", amount_claimed=500))
        db.add(RequestEvent(request_id=rid, status="cancelled", note="Kavya called back: wrong address 12 Lake St"))
        db.add(Notification(user_id=u["id"], type="trip", title="Your ambulance is here"))
        db.commit()
    assert client.request("DELETE", "/api/auth/me", json={"password": world.password}, headers=u["h"]).status_code == 200
    with SessionLocal() as db:
        trip = db.execute(select(TripRecord).where(TripRecord.request_id == rid)).scalar_one()
        assert trip.summary["feedback"]["comment"] is None and trip.summary["feedback"]["rating"] == 5
        claim = db.execute(select(InsuranceClaim)).scalar_one()
        assert claim.policy_number == "erased" and claim.insurer == "erased"
        assert all(e.note is None for e in db.execute(select(RequestEvent).where(RequestEvent.request_id == rid)).scalars())
        assert db.execute(select(Notification).where(Notification.user_id == u["id"])).first() is None
        req = db.get(EmergencyRequest, rid)
        assert (req.lat, req.lng) == (round(PATIENT[0], 2), round(PATIENT[1], 2))


def test_guests_can_erase_without_a_password(client):
    import uuid
    tok = client.post("/api/auth/guest", json={"device_id": str(uuid.uuid4())}).json()
    assert tok["user"]["is_guest"] is True
    h = {"Authorization": f"Bearer {tok['token']}"}
    assert client.request("DELETE", "/api/auth/me", json={}, headers=h).status_code == 200
