import pytest
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app.db import SessionLocal
from app.models import (Ambulance, AmbulanceLocation, AmbulanceStatus, AuditLog, Hospital, Role, TripRecord)
from app.services import analytics, billing, capacity, trips
from app.audit import verify_chain
from conftest import PATIENT, sos, ws_url


@pytest.fixture
def scene(client, world):
    h = world.hospital(lat=13.10, lng=80.29)
    st = world.station(h)
    amb = world.ambulance(st, lat=13.085, lng=80.272, kind="ALS")
    return {"h": h, "amb": amb, "crew": world.crew(amb), "staff": world.user(Role.hospital_staff, hospital_id=h),
            "ctl": world.user(Role.controller), "user": world.user()}


def status(client, crew, rid, st):
    return client.post(f"/api/crew/trips/{rid}/status", json={"status": st}, headers=crew["h"])


def test_full_happy_path_uc1_to_uc4(client, scene, monkeypatch, published):
    s, crew, user = scene, scene["crew"], scene["user"]
    spies = []
    monkeypatch.setattr(billing, "create_bill_for_trip", lambda db, trip: spies.append(("bill", trip.id)))
    monkeypatch.setattr(analytics, "record_outcome", lambda db, req, trip: spies.append(("outcome", req.id)))

    r = sos(client, user["h"], incident_type="cardiac", severity=4)
    assert r.status_code == 201 and r.json()["status"] == "received"
    rid = r.json()["id"]

    me = client.get("/api/crew/me", headers=crew["h"]).json()
    assert me["pending_offer"]["id"] == rid and me["active_trip"] is None and me["station"]["id"]
    assert ("crew:%d" % s["amb"], "dispatch.offer") in {(t, ty) for t, ty, _ in published}

    acc = client.post(f"/api/crew/offers/{rid}/accept", headers=crew["h"])
    assert acc.status_code == 200 and acc.json()["status"] == "accepted" and acc.json()["accepted_at"]
    assert client.post(f"/api/crew/offers/{rid}/accept", headers=crew["h"]).status_code == 409  # not twice
    assert client.get("/api/crew/me", headers=crew["h"]).json()["active_trip"]["id"] == rid

    # navigation to the patient (FR6)
    route = client.get(f"/api/crew/trips/{rid}/route", headers=crew["h"]).json()
    assert route["phase"] == "to_patient" and route["steps"] and route["polyline"] and route["eta_seconds"] > 0

    assert status(client, crew, rid, "en_route").status_code == 200
    # live location push -> recomputed ETA + events
    published.clear()
    assert client.post("/api/crew/location", json={"lat": 13.0835, "lng": 80.2715}, headers=crew["h"]).status_code == 204
    loc_events = {(t, ty) for t, ty, _ in published}
    assert (f"request:{rid}", "ambulance.location") in loc_events and ("controller", "ambulance.location") in loc_events
    trk = client.get(f"/api/requests/{rid}/tracking", headers=user["h"]).json()
    assert trk["ambulance"]["lat"] == 13.0835 and trk["path"][-1] == [13.0835, 80.2715]
    assert trk["hospital"]["id"] == s["h"] and trk["eta_seconds"] is not None

    assert status(client, crew, rid, "on_scene").status_code == 200
    assert status(client, crew, rid, "transporting").status_code == 200
    route = client.get(f"/api/crew/trips/{rid}/route", headers=crew["h"]).json()
    assert route["phase"] == "to_hospital"
    assert ("hospital:%d" % s["h"], "hospital.incoming") in {(t, ty) for t, ty, _ in published}

    # hospital sees the incoming patient, acknowledges, but cannot hand over before arrival
    inc = client.get(f"/api/hospitals/{s['h']}/incoming", headers=s["staff"]["h"]).json()
    assert [x["id"] for x in inc] == [rid] and inc[0]["acknowledged"] is False
    assert client.post(f"/api/hospitals/{s['h']}/incoming/{rid}/acknowledge", headers=s["staff"]["h"]).status_code == 200
    assert client.get(f"/api/hospitals/{s['h']}/incoming", headers=s["staff"]["h"]).json()[0]["acknowledged"] is True
    assert client.post(f"/api/hospitals/{s['h']}/handover/{rid}", headers=s["staff"]["h"]).status_code == 409

    assert status(client, crew, rid, "arrived").status_code == 200
    ho = client.post(f"/api/hospitals/{s['h']}/handover/{rid}", json={"notes": "stable"}, headers=s["staff"]["h"])
    assert ho.status_code == 200 and ho.json()["status"] == "completed" and ho.json()["completed_at"]

    with SessionLocal() as db:
        trip = db.execute(select(TripRecord).where(TripRecord.request_id == rid)).scalar_one()
        assert trip.handover_confirmed_by == s["staff"]["id"] and trip.handover_time
        assert trip.arrived_scene_at and trip.arrived_hospital_at and trip.response_time_seconds is not None
        assert trip.distance_km and trip.closed_manually is False
        assert db.get(Ambulance, s["amb"]).status == AmbulanceStatus.available
        actions = [a.action for a in db.execute(select(AuditLog).order_by(AuditLog.id)).scalars()]
        assert verify_chain(db)["ok"]
    for a in ("request.create", "dispatch.assign", "capacity.query", "dispatch.accept", "trip.handover", "hospital.acknowledge"):
        assert a in actions
    assert spies == [("outcome", rid), ("bill", trip.id)]
    assert ("controller", "trip.closed") in {(t, ty) for t, ty, _ in published}
    # ambulance is dispatchable again and bed hold was consumed (patient occupies it)
    assert client.get(f"/api/requests/{rid}", headers=user["h"]).json()["status"] == "completed"
    assert client.post(f"/api/hospitals/{s['h']}/handover/{rid}", headers=s["staff"]["h"]).status_code == 409


def test_state_machine_is_forward_only(client, scene):
    crew, user = scene["crew"], scene["user"]
    rid = sos(client, user["h"]).json()["id"]
    assert status(client, crew, rid, "en_route").status_code == 409        # not accepted yet
    client.post(f"/api/crew/offers/{rid}/accept", headers=crew["h"])
    assert status(client, crew, rid, "on_scene").status_code == 409        # skipping en_route
    assert status(client, crew, rid, "en_route").status_code == 200
    assert status(client, crew, rid, "en_route").status_code == 409        # repeat
    assert status(client, crew, rid, "arrived").status_code == 409
    assert client.post(f"/api/crew/trips/{rid}/status", json={"status": "completed"}, headers=crew["h"]).status_code == 422
    assert status(client, crew, rid, "on_scene").status_code == 200
    # cannot cancel/regress after pickup either way
    assert status(client, crew, rid, "en_route").status_code == 409
    assert status(client, crew, rid, "transporting").status_code == 200
    assert client.post(f"/api/requests/{rid}/cancel", headers=user["h"]).status_code == 409


def test_crew_permissions(client, world, scene):
    other_amb = world.ambulance(world.station(scene["h"]), lat=13.5, lng=80.9)
    other_crew = world.crew(other_amb)
    rid = sos(client, scene["user"]["h"]).json()["id"]
    assert client.post(f"/api/crew/offers/{rid}/accept", headers=other_crew["h"]).status_code == 403
    assert status(client, other_crew, rid, "en_route").status_code == 403
    assert client.get(f"/api/crew/trips/{rid}/route", headers=other_crew["h"]).status_code == 403
    assert client.get("/api/crew/me", headers=scene["user"]["h"]).status_code == 403
    assert client.get("/api/crew/me", headers=scene["staff"]["h"]).status_code == 403
    assert client.post("/api/crew/location", json={"lat": 1, "lng": 1}, headers=scene["ctl"]["h"]).status_code == 403
    assert client.post("/api/crew/location", json={"lat": 100, "lng": 1}, headers=scene["crew"]["h"]).status_code == 422


def test_duty_toggle(client, scene):
    crew = scene["crew"]
    assert client.post("/api/crew/duty", json={"on_duty": False}, headers=crew["h"]).json()["status"] == "offline"
    rid = sos(client, scene["user"]["h"]).json()["id"]
    assert client.get(f"/api/requests/{rid}", headers=scene["user"]["h"]).json()["status"] == "awaiting_manual"  # offline unit not used
    assert client.post("/api/crew/duty", json={"on_duty": True}, headers=crew["h"]).json()["status"] == "available"
    client.post("/api/crew/location", json={"lat": 13.085, "lng": 80.272}, headers=crew["h"])
    rid2 = sos(client, scene["user"]["h"]).json()["id"]
    assert client.get(f"/api/requests/{rid2}", headers=scene["user"]["h"]).json()["status"] == "offered"
    assert client.post("/api/crew/duty", json={"on_duty": False}, headers=crew["h"]).status_code == 409  # busy


def test_hospital_staff_only_own_hospital(client, world, scene):
    h2 = world.hospital(lat=13.3, lng=80.5)  # farther than the scene hospital
    staff2 = world.user(Role.hospital_staff, hospital_id=h2)
    crew = scene["crew"]
    rid = sos(client, scene["user"]["h"]).json()["id"]
    client.post(f"/api/crew/offers/{rid}/accept", headers=crew["h"])
    for st in ("en_route", "on_scene", "transporting", "arrived"):
        assert status(client, crew, rid, st).status_code == 200
    h1 = scene["h"]
    assert client.get(f"/api/hospitals/{h1}/incoming", headers=staff2["h"]).status_code == 403
    assert client.post(f"/api/hospitals/{h1}/handover/{rid}", headers=staff2["h"]).status_code == 403
    assert client.post(f"/api/hospitals/{h2}/handover/{rid}", headers=staff2["h"]).status_code == 404  # not routed there
    assert client.get(f"/api/requests/{rid}", headers=staff2["h"]).status_code == 403
    assert client.get(f"/api/requests/{rid}", headers=scene["staff"]["h"]).status_code == 200
    assert client.post(f"/api/hospitals/{h1}/handover/{rid}", headers=scene["user"]["h"]).status_code == 403
    assert client.post(f"/api/hospitals/{h1}/handover/{rid}", headers=scene["staff"]["h"]).status_code == 200


def test_manual_close_uc4_e1(client, scene, monkeypatch):
    spies = []
    monkeypatch.setattr(billing, "create_bill_for_trip", lambda db, trip: spies.append(trip.closed_manually))
    crew, ctl, user = scene["crew"], scene["ctl"], scene["user"]
    rid = sos(client, user["h"], severity=5).json()["id"]
    client.post(f"/api/crew/offers/{rid}/accept", headers=crew["h"])
    status(client, crew, rid, "en_route")
    assert client.post(f"/api/controller/requests/{rid}/close", json={"reason": "crew lost connectivity"}, headers=user["h"]).status_code == 403
    assert client.post(f"/api/controller/requests/{rid}/close", json={}, headers=ctl["h"]).status_code == 422
    r = client.post(f"/api/controller/requests/{rid}/close", json={"reason": "crew lost connectivity"}, headers=ctl["h"])
    assert r.status_code == 200 and r.json()["status"] == "completed"
    assert spies == [True]
    with SessionLocal() as db:
        trip = db.execute(select(TripRecord).where(TripRecord.request_id == rid)).scalar_one()
        assert trip.closed_manually and trip.handover_confirmed_by == ctl["id"]
        assert db.get(Ambulance, scene["amb"]).status == AmbulanceStatus.available
        assert db.get(Hospital, scene["h"]).available_icu == 5  # hold released on manual close
        assert db.execute(select(AuditLog).where(AuditLog.action == "trip.close_manual")).scalar_one()
    assert client.post(f"/api/controller/requests/{rid}/close", json={"reason": "again"}, headers=ctl["h"]).status_code == 409


def test_cancel_after_accept_frees_ambulance(client, scene):
    rid = sos(client, scene["user"]["h"]).json()["id"]
    client.post(f"/api/crew/offers/{rid}/accept", headers=scene["crew"]["h"])
    assert client.post(f"/api/requests/{rid}/cancel", headers=scene["ctl"]["h"]).status_code == 200
    with SessionLocal() as db:
        assert db.get(Ambulance, scene["amb"]).status == AmbulanceStatus.available


def test_billing_hook_failure_does_not_block_closure(client, scene, monkeypatch):
    def boom(db, trip):
        raise RuntimeError("billing down")
    monkeypatch.setattr(billing, "create_bill_for_trip", boom)
    crew = scene["crew"]
    rid = sos(client, scene["user"]["h"]).json()["id"]
    client.post(f"/api/crew/offers/{rid}/accept", headers=crew["h"])
    for st in ("en_route", "on_scene", "transporting", "arrived"):
        status(client, crew, rid, st)
    assert client.post(f"/api/hospitals/{scene['h']}/handover/{rid}", headers=scene["staff"]["h"]).json()["status"] == "completed"


def test_board_shape(client, scene):
    rid = sos(client, scene["user"]["h"]).json()["id"]
    b = client.get("/api/controller/board", headers=scene["ctl"]["h"]).json()
    assert [r["id"] for r in b["requests"]] == [rid]
    assert b["ambulances"][0]["location_age_s"] is not None and b["ambulances"][0]["station_name"]
    assert {"id", "name", "available_beds", "available_icu", "capacity_age_min", "stale"} <= set(b["hospitals"][0])
    assert b["escalations"] == [] and b["stations"]
    assert client.get("/api/controller/board", headers=scene["staff"]["h"]).status_code == 403
    assert client.get("/api/controller/board", headers=world_admin(client)).status_code in (200,)


def world_admin(client):
    from conftest import World
    return World().user(Role.admin)["h"]


# ---------------------------------------------------------------- websocket
def test_websocket_authorisation(client, world, scene):
    rid = sos(client, scene["user"]["h"]).json()["id"]
    other = world.user()
    with client.websocket_connect(ws_url(client, scene['user'], f"request:{rid}")) as ws:
        assert ws.receive_json()["data"]["topics"] == [f"request:{rid}"]
        ws.send_text("ping")
        assert ws.receive_json()["type"] == "pong"
    with client.websocket_connect(ws_url(client, scene['ctl'], f"controller,crew:{scene['amb']},hospital:{scene['h']}")) as ws:
        assert ws.receive_json()["type"] == "subscribed"
    with client.websocket_connect(ws_url(client, scene['crew'], f"crew:{scene['amb']},request:{rid}")) as ws:
        assert ws.receive_json()["type"] == "subscribed"
    with client.websocket_connect(ws_url(client, scene['staff'], f"hospital:{scene['h']}")) as ws:
        assert ws.receive_json()["type"] == "subscribed"
    for who, topics in [(other, f"request:{rid}"), (scene["user"], "controller"),
                        (scene["crew"], "crew:999"), (scene["staff"], "hospital:999"), (None, "controller")]:
        url = ws_url(client, who, topics) if who else f"/api/ws?ticket=garbage&topics={topics}"
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(url) as ws:
                ws.receive_json()
