from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, EmergencyRequest, Hospital, Role
from app.services import capacity
from conftest import PATIENT, sos


def new_req(**kw):
    with SessionLocal() as db:
        r = EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=kw.pop("severity", 3), **kw)
        db.add(r)
        db.commit()
        return r.id


def confirm(rid, **kw):
    with SessionLocal() as db:
        req = db.get(EmergencyRequest, rid)
        h = capacity.confirm_destination(db, req, **kw)
        db.commit()
        return h.id if h else None


def hosp(hid):
    with SessionLocal() as db:
        return db.get(Hospital, hid)


def test_specialty_filter_by_incident_type(world):
    nospec = world.hospital(lat=13.085, lng=80.272, specialists={})              # nearest but no specialists
    cardio = world.hospital(lat=13.12, lng=80.30, specialists={"cardiology": 2})
    neuro = world.hospital(lat=13.10, lng=80.28, specialists={"neurology": 1})
    assert confirm(new_req(incident_type="cardiac")) == cardio
    assert confirm(new_req(incident_type="stroke")) == neuro
    assert confirm(new_req(incident_type="other")) == nospec  # no specialty needed -> nearest
    assert confirm(new_req(incident_type="maternity")) is None  # nobody has obstetrics (escalation case)


def test_icu_required_for_severity_4_and_reserved_then_released(world):
    no_icu = world.hospital(lat=13.085, lng=80.272, icu=0)
    icu = world.hospital(lat=13.12, lng=80.30, icu=2)
    rid = new_req(severity=5, incident_type="other")
    assert confirm(rid) == icu
    assert hosp(icu).available_icu == 1 and hosp(no_icu).available_beds == 10   # soft reservation
    with SessionLocal() as db:
        capacity.release_reservation(db, db.get(EmergencyRequest, rid), reason="test")
        db.commit()
    assert hosp(icu).available_icu == 2
    # low severity does not need ICU: nearest wins, general bed held
    rid2 = new_req(severity=2)
    assert confirm(rid2) == no_icu and hosp(no_icu).available_beds == 9


def test_full_hospital_excluded(world):
    full = world.hospital(lat=13.085, lng=80.272, beds=0)
    ok = world.hospital(lat=13.12, lng=80.30, beds=3)
    assert confirm(new_req()) == ok and full != ok


def test_stale_capacity_is_deprioritised_but_usable_as_last_resort(world):
    stale_near = world.hospital(lat=13.085, lng=80.272, fresh=False)
    fresh_far = world.hospital(lat=13.15, lng=80.33, fresh=True)
    assert confirm(new_req()) == fresh_far
    # only stale hospital left -> still chosen ("unknown"), but no bed is decremented
    with SessionLocal() as db:
        db.delete(db.get(Hospital, fresh_far))
        db.commit()
    before = hosp(stale_near).available_beds
    assert confirm(new_req()) == stale_near
    assert hosp(stale_near).available_beds == before
    with SessionLocal() as db:
        q = db.execute(select(AuditLog).where(AuditLog.action == "capacity.query").order_by(AuditLog.id.desc())).scalars().first()
    assert q.details["candidates"][0]["capacity"] == "unknown"


def test_radius_widens_then_escalates(world):
    far = world.hospital(lat=13.0827 + 0.18, lng=80.2707)  # ~20 km: outside 12 km, inside 24 km
    assert confirm(new_req()) == far
    with SessionLocal() as db:
        db.get(Hospital, far).available_beds = 0
        db.commit()
    assert confirm(new_req()) is None
    with SessionLocal() as db:
        last = db.execute(select(AuditLog).where(AuditLog.action == "capacity.query").order_by(AuditLog.id.desc())).scalars().first()
    assert last.details["chosen"] is None


def test_unverified_partner_never_chosen(world):
    world.hospital(lat=13.0828, lng=80.2708, partner_verified=False)
    assert confirm(new_req()) is None


def test_dispatch_escalates_when_no_eligible_hospital_but_still_sends_ambulance(client, world, published):
    h = world.hospital(specialists={}, lat=13.09, lng=80.28)
    st = world.station(h)
    amb = world.ambulance(st, lat=13.085, lng=80.272)
    u = world.user()
    r = sos(client, u["h"], incident_type="cardiac", severity=4).json()
    got = client.get(f"/api/requests/{r['id']}", headers=u["h"]).json()
    assert got["status"] == "offered" and got["ambulance"]["id"] == amb and got["destination_hospital"] is None
    esc = [d for t, ty, d in published if ty == "dispatch.escalated"]
    assert esc and esc[0]["reason"] == "no_eligible_hospital"


def test_dispatch_confirms_destination_and_notifies(client, world, published):
    h = world.hospital(lat=13.09, lng=80.28)
    st = world.station(h)
    world.ambulance(st, lat=13.085, lng=80.272)
    u = world.user()
    r = sos(client, u["h"], incident_type="cardiac", severity=4).json()
    got = client.get(f"/api/requests/{r['id']}", headers=u["h"]).json()
    assert got["destination_hospital"]["id"] == h
    types = {(t, ty) for t, ty, _ in published}
    assert (f"request:{r['id']}", "destination.confirmed") in types
    assert (f"hospital:{h}", "hospital.incoming") in types
    assert ("controller", "capacity.updated") in types
    assert hosp(h).available_icu == 4  # severity 4 -> ICU bed held


def test_cancel_releases_reserved_bed(client, world):
    h = world.hospital(lat=13.09, lng=80.28)
    world.ambulance(world.station(h), lat=13.085, lng=80.272)
    u = world.user()
    rid = sos(client, u["h"], severity=5).json()["id"]
    assert hosp(h).available_icu == 4
    assert client.post(f"/api/requests/{rid}/cancel", headers=u["h"]).status_code == 200
    assert hosp(h).available_icu == 5


# ---------------------------------------------------------------- hospital endpoints
def test_capacity_update_permissions_and_audit(client, world, published):
    h1, h2 = world.hospital(), world.hospital()
    s1 = world.user(Role.hospital_staff, hospital_id=h1)
    s2 = world.user(Role.hospital_staff, hospital_id=h2)
    body = {"available_beds": 3, "available_icu": 1, "specialists": {"cardiology": 4}}
    assert client.put(f"/api/hospitals/{h1}/capacity", json=body, headers=s2["h"]).status_code == 403  # other hospital
    assert client.put(f"/api/hospitals/{h1}/capacity", json=body, headers=world.user()["h"]).status_code == 403
    assert client.put(f"/api/hospitals/{h1}/capacity", json=body, headers=world.user(Role.controller)["h"]).status_code == 403
    assert client.put(f"/api/hospitals/{h1}/capacity", json={**body, "available_beds": 999}, headers=s1["h"]).status_code == 422
    r = client.put(f"/api/hospitals/{h1}/capacity", json=body, headers=s1["h"])
    assert r.status_code == 200 and r.json()["available_beds"] == 3 and r.json()["stale"] is False
    assert hosp(h1).specialists == {"cardiology": 4}
    assert ("controller", "capacity.updated") in {(t, ty) for t, ty, _ in published}
    assert client.put(f"/api/hospitals/{h1}/capacity", json=body, headers=world.user(Role.admin)["h"]).status_code == 200
    with SessionLocal() as db:
        a = db.execute(select(AuditLog).where(AuditLog.action == "capacity.update")).scalars().first()
    assert a.user_id == s1["id"] and a.details["before"]["available_beds"] == 10


def test_stale_flag_and_listing(client, world):
    fresh, stale = world.hospital(), world.hospital(fresh=False)
    u = world.user()
    assert client.get("/api/hospitals").status_code == 401
    rows = {h["id"]: h for h in client.get("/api/hospitals", headers=u["h"]).json()}
    assert rows[fresh]["stale"] is False and rows[stale]["stale"] is True
    assert client.get(f"/api/hospitals/{fresh}", headers=u["h"]).json()["name"]
    assert client.get("/api/hospitals/9999", headers=u["h"]).status_code == 404


def test_controller_manual_destination_override(client, world):
    h1, h2 = world.hospital(lat=13.09, lng=80.28), world.hospital(lat=13.2, lng=80.3, icu=1)
    world.ambulance(world.station(h1), lat=13.085, lng=80.272)
    ctl = world.user(Role.controller)
    u = world.user()
    rid = sos(client, u["h"], severity=5).json()["id"]
    assert hosp(h1).available_icu == 4
    assert client.post(f"/api/controller/requests/{rid}/destination", json={"hospital_id": h2}, headers=u["h"]).status_code == 403
    r = client.post(f"/api/controller/requests/{rid}/destination", json={"hospital_id": h2}, headers=ctl["h"])
    assert r.status_code == 200 and r.json()["destination_hospital"]["id"] == h2
    assert hosp(h1).available_icu == 5 and hosp(h2).available_icu == 0   # hold moved
    assert client.post(f"/api/controller/requests/{rid}/destination", json={"hospital_id": 999}, headers=ctl["h"]).status_code == 404
    with SessionLocal() as db:
        assert db.execute(select(AuditLog).where(AuditLog.action == "capacity.override")).scalar_one().user_id == ctl["id"]
