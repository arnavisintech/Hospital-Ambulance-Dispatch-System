"""FR2 / STRQ5: hospital operations staff see and manage their own stations' fleet - and nobody else's."""
from sqlalchemy import select

from app.db import SessionLocal
from app.models import Ambulance, AmbulanceStatus, AuditLog, Role
from conftest import PATIENT, sos


def _setup(world):
    h, other = world.hospital(), world.hospital()
    st = world.station(h)
    a1, a2 = world.ambulance(st), world.ambulance(st, lat=13.09, lng=80.28)
    world.ambulance(world.station(other))
    return {"h": h, "other": other, "st": st, "a1": a1, "a2": a2,
            "staff": world.user(Role.hospital_staff, hospital_id=h),
            "stranger": world.user(Role.hospital_staff, hospital_id=other)}


def test_staff_see_only_their_own_fleet(client, world):
    s = _setup(world)
    j = client.get(f"/api/hospitals/{s['h']}/fleet", headers=s["staff"]["h"]).json()
    assert [st["id"] for st in j["stations"]] == [s["st"]]
    units = j["stations"][0]["ambulances"]
    assert sorted(u["id"] for u in units) == sorted([s["a1"], s["a2"]])
    assert {"registration_number", "kind", "status", "staffed", "location_age_s"} <= set(units[0])
    assert client.get(f"/api/hospitals/{s['h']}/fleet", headers=s["stranger"]["h"]).status_code == 403
    assert client.get(f"/api/hospitals/{s['h']}/fleet", headers=world.user(Role.controller)["h"]).status_code == 403
    assert client.get(f"/api/hospitals/{s['h']}/fleet", headers=world.user(Role.admin)["h"]).status_code == 200


def test_maintenance_and_staffing_take_a_unit_out_of_dispatch(client, world):
    s = _setup(world)
    h = s["staff"]["h"]
    r = client.patch(f"/api/hospitals/{s['h']}/ambulances/{s['a1']}", json={"maintenance": True}, headers=h)
    assert r.status_code == 200 and r.json()["status"] == "maintenance"
    r = client.patch(f"/api/hospitals/{s['h']}/ambulances/{s['a2']}", json={"staffed": False}, headers=h)
    assert r.status_code == 200 and r.json()["staffed"] is False
    u = world.user()
    rid = sos(client, u["h"]).json()["id"]
    got = client.get(f"/api/requests/{rid}", headers=u["h"]).json()
    assert got["ambulance"] is None or got["ambulance"]["id"] not in (s["a1"], s["a2"])   # neither is dispatchable
    with SessionLocal() as db:
        assert db.get(Ambulance, s["a1"]).status == AmbulanceStatus.maintenance
        assert {a.action for a in db.execute(select(AuditLog).where(AuditLog.action == "fleet.update")).scalars()} == {"fleet.update"}
    # back from maintenance: offline until the crew themselves go on duty (a unit is never dispatchable just
    # because maintenance ended - its crew may be off shift)
    r = client.patch(f"/api/hospitals/{s['h']}/ambulances/{s['a1']}", json={"maintenance": False}, headers=h)
    assert r.json()["status"] == "offline"
    crew = world.crew(s["a1"])
    assert client.post("/api/crew/duty", json={"on_duty": True}, headers=crew["h"]).status_code == 200
    with SessionLocal() as db:
        assert db.get(Ambulance, s["a1"]).status == AmbulanceStatus.available


def test_busy_unit_cannot_be_taken_out_of_service(client, world):
    s = _setup(world)
    with SessionLocal() as db:
        db.get(Ambulance, s["a1"]).status = AmbulanceStatus.en_route
        db.commit()
    for body in ({"maintenance": True}, {"staffed": False}):
        r = client.patch(f"/api/hospitals/{s['h']}/ambulances/{s['a1']}", json=body, headers=s["staff"]["h"])
        assert r.status_code == 409


def test_cannot_touch_another_hospitals_ambulance(client, world):
    s = _setup(world)
    # an ambulance of this hospital, addressed through the other hospital's id, and vice versa
    assert client.patch(f"/api/hospitals/{s['other']}/ambulances/{s['a1']}", json={"staffed": False},
                        headers=s["stranger"]["h"]).status_code == 404
    assert client.patch(f"/api/hospitals/{s['h']}/ambulances/{s['a1']}", json={"staffed": False},
                        headers=s["stranger"]["h"]).status_code == 403
