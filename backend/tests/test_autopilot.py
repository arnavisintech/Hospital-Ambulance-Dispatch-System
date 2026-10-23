"""Demo autopilot (v2 section 9) driven tick-by-tick with a fake clock. Haversine routing, no network."""
import random

import pytest
from sqlalchemy import func, select

from app.db import SessionLocal
from app.geo import haversine_km
from app.models import (Ambulance, AmbulanceLocation, AmbulanceStatus, AuditLog, DarkStation, EmergencyRequest,
                        Role, TripRecord)
from app.services import autopilot, crew_actions, routing
from conftest import sos


@pytest.fixture
def scene(client, world):
    h = world.hospital(lat=13.095, lng=80.285)
    st = world.station(h, lat=13.075, lng=80.262)
    amb = world.ambulance(st, lat=13.075, lng=80.262, kind="ALS")  # parked at its station
    return {"h": h, "st": st, "amb": amb, "crew": world.crew(amb), "user": world.user(),
            "ctl": world.user(Role.controller), "staff": world.user(Role.hospital_staff, hospital_id=h)}


def status_of(rid):
    with SessionLocal() as db:
        return db.get(EmergencyRequest, rid).status.value


def amb_row(aid):
    with SessionLocal() as db:
        return db.get(Ambulance, aid)


def run(ap, t0, seconds, rid=None, until=None, trace=None):
    """Tick once per fake second. Returns the time reached."""
    t = t0
    for _ in range(seconds):
        ap.tick(t)
        if rid is not None and trace is not None:
            st = status_of(rid)
            if not trace or trace[-1] != st:
                trace.append(st)
        if until is not None and until():
            return t
        t += 1.0
    return t


def test_full_trip_runs_itself_and_returns_home(client, scene, published):
    s = scene
    rid = sos(client, s["user"]["h"], severity=3).json()["id"]
    assert status_of(rid) == "offered"
    ap = autopilot.Autopilot(speedup=20, rng=random.Random(7))
    trace = []
    t = run(ap, 0.0, 2, rid, trace=trace)
    assert status_of(rid) == "offered"  # accept is delayed 3-6 s, like a human
    t = run(ap, t, 400, rid, until=lambda: status_of(rid) == "completed", trace=trace)
    assert trace == ["offered", "accepted", "en_route", "on_scene", "transporting", "arrived", "completed"]

    with SessionLocal() as db:
        n_gps = db.scalar(select(func.count(AmbulanceLocation.id)).where(AmbulanceLocation.ambulance_id == s["amb"]))
        trip = db.execute(select(TripRecord).where(TripRecord.request_id == rid)).scalar_one()
        acts = [a.details.get("actor") for a in db.execute(select(AuditLog).where(
            AuditLog.entity_id == str(rid), AuditLog.action.in_(["dispatch.accept", "trip.status", "trip.handover"]))).scalars()]
    assert n_gps >= 5 and trip.handover_time and trip.handover_confirmed_by is None and trip.distance_km > 0
    assert acts and all(a == "autopilot" for a in acts) and len(acts) == 6  # accept + 4 statuses + handover
    locs = [d for tp, ty, d in published if ty == "ambulance.location" and tp == f"request:{rid}"]
    assert len(locs) >= 5 and {d["phase"] for d in locs} >= {"to_patient", "to_hospital"}
    assert any(ty == "request.route" for _t, ty, _d in published)

    # after handover the ambulance is available and drives back to its station
    a = amb_row(s["amb"])
    assert a.status == AmbulanceStatus.available
    with SessionLocal() as db:
        home = db.get(DarkStation, s["st"])
        home = (home.lat, home.lng)
    assert haversine_km(a.lat, a.lng, *home) > 0.2  # it is at the hospital now
    run(ap, t + 1, 300, until=lambda: haversine_km(amb_row(s["amb"]).lat, amb_row(s["amb"]).lng, *home) < 0.01)
    a = amb_row(s["amb"])
    assert haversine_km(a.lat, a.lng, *home) < 0.01 and a.status == AmbulanceStatus.available


def test_real_crew_device_takes_precedence(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    ap = autopilot.Autopilot(speedup=20, rng=random.Random(1), device_grace_s=60)
    crew_actions.note_device(s["amb"], now=0.0)  # a phone pinged at t=0
    run(ap, 1.0, 50)
    assert status_of(rid) == "offered"  # autopilot kept its hands off
    run(ap, 61.0, 10)  # device silent for > 60 s: autopilot takes over
    assert status_of(rid) in ("accepted", "en_route")


def test_human_accept_then_autopilot_continues(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    assert client.post(f"/api/crew/offers/{rid}/accept", headers=s["crew"]["h"]).status_code == 200
    ap = autopilot.Autopilot(speedup=20, rng=random.Random(2))
    run(ap, 0.0, 5)
    assert status_of(rid) == "en_route"


def test_cancellation_mid_drive_sends_unit_home(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    ap = autopilot.Autopilot(speedup=2, rng=random.Random(3))
    t = run(ap, 0.0, 60, until=lambda: status_of(rid) == "en_route")
    t = run(ap, t + 1, 3)
    moved = amb_row(s["amb"])
    assert client.post(f"/api/requests/{rid}/cancel", headers=s["user"]["h"]).status_code == 200
    run(ap, t + 1, 3)
    assert ap.units[s["amb"]].request_id is None and ap.units[s["amb"]].mode in ("home", "idle")
    assert amb_row(s["amb"]).status == AmbulanceStatus.available
    assert (moved.lat, moved.lng) != (13.075, 80.262)


def test_staff_handover_first_wins(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    ap = autopilot.Autopilot(speedup=20, rng=random.Random(4))
    run(ap, 0.0, 400, until=lambda: status_of(rid) == "arrived")
    r = client.post(f"/api/hospitals/{s['h']}/handover/{rid}", headers=s["staff"]["h"])
    assert r.status_code == 200
    run(ap, 1000.0, 10)
    with SessionLocal() as db:
        trip = db.execute(select(TripRecord).where(TripRecord.request_id == rid)).scalar_one()
        assert trip.handover_confirmed_by == s["staff"]["id"]


def test_controller_reassignment_releases_unit(client, scene, world):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    other = world.ambulance(s["st"], lat=13.07, lng=80.26)
    ap = autopilot.Autopilot(speedup=20, rng=random.Random(5))
    run(ap, 0.0, 30, until=lambda: status_of(rid) == "en_route")
    r = client.post(f"/api/controller/requests/{rid}/assign", json={"ambulance_id": other}, headers=s["ctl"]["h"])
    assert r.status_code == 200
    run(ap, 100.0, 15)
    assert amb_row(s["amb"]).status == AmbulanceStatus.available
    with SessionLocal() as db:
        assert db.get(EmergencyRequest, rid).ambulance_id == other


def test_routing_failure_never_crashes_the_loop(client, scene, monkeypatch):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    ap = autopilot.Autopilot(speedup=20, rng=random.Random(6))
    real = routing.route

    def boom(*a, **k):
        raise RuntimeError("router exploded")
    monkeypatch.setattr(routing, "route", boom)
    run(ap, 0.0, 20)  # must not raise
    monkeypatch.setattr(routing, "route", real)
    run(ap, 20.0, 400, until=lambda: status_of(rid) == "completed")
    assert status_of(rid) == "completed"


def test_idle_units_get_gps_heartbeat(client, scene):
    s = scene
    with SessionLocal() as db:
        a = db.get(Ambulance, s["amb"])
        a.location_updated_at = a.location_updated_at.replace(year=2020)
        db.commit()
    ap = autopilot.Autopilot(speedup=4, rng=random.Random(8))
    ap.tick(0.0)
    assert amb_row(s["amb"]).location_updated_at.year > 2020  # stays dispatchable
