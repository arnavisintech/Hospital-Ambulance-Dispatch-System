"""v2 contract: timeline, tracking payload, share links, feedback, crew/controller/hospital additions, logic fixes."""
from datetime import timedelta

import pytest
from sqlalchemy import select
from starlette.websockets import WebSocketDisconnect

from app.db import SessionLocal
from app.models import (EmergencyRequest, Hospital, PlatformSetting, RequestEvent, RequestStatus, Role, TripRecord,
                        utcnow)
from app.services import sharing, trips
from conftest import sos


@pytest.fixture
def scene(client, world):
    h = world.hospital(lat=13.10, lng=80.29)
    st = world.station(h)
    amb = world.ambulance(st, lat=13.085, lng=80.272, kind="ALS")
    crew = world.user(Role.crew, ambulance_id=amb, name="Murugan Selvaraj", phone="9840100001")
    return {"h": h, "st": st, "amb": amb, "crew": crew, "staff": world.user(Role.hospital_staff, hospital_id=h),
            "ctl": world.user(Role.controller), "admin": world.user(Role.admin),
            "user": world.user(phone="9000000001"), "other": world.user()}


def step(client, crew, rid, st):
    r = client.post(f"/api/crew/trips/{rid}/status", json={"status": st}, headers=crew["h"])
    assert r.status_code == 200, r.text
    return r.json()


def run_trip(client, s, rid, handover=True):
    assert client.post(f"/api/crew/offers/{rid}/accept", headers=s["crew"]["h"]).status_code == 200
    for st in ("en_route", "on_scene", "transporting", "arrived"):
        step(client, s["crew"], rid, st)
    if handover:
        r = client.post(f"/api/hospitals/{s['h']}/handover/{rid}", headers=s["staff"]["h"])
        assert r.status_code == 200, r.text


# ---------------------------------------------------------------- timeline (section 3)
def test_every_transition_is_in_the_timeline(client, scene):
    rid = sos(client, scene["user"]["h"]).json()["id"]
    run_trip(client, scene, rid)
    got = client.get(f"/api/requests/{rid}", headers=scene["user"]["h"]).json()
    assert [e["status"] for e in got["timeline"]] == [
        "received", "matching", "offered", "accepted", "en_route", "on_scene", "transporting", "arrived", "completed"]
    assert all(e["at"] for e in got["timeline"]) and got["zone_label"]
    with SessionLocal() as db:
        ev = db.execute(select(RequestEvent).where(RequestEvent.request_id == rid, RequestEvent.status == "accepted")).scalar_one()
        assert ev.actor_user_id == scene["crew"]["id"]


def test_two_status_changes_in_one_transaction_both_recorded(world):
    u = world.user()
    with SessionLocal() as db:
        req = EmergencyRequest(requester_id=u["id"], lat=13.08, lng=80.27, status=RequestStatus.received)
        db.add(req)
        db.commit()
        trips.transition(req, RequestStatus.matching)
        trips.transition(req, RequestStatus.awaiting_manual)
        db.commit()
        assert [e["status"] for e in trips.timeline(db, req.id)] == ["received", "matching", "awaiting_manual"]


def test_backfill_synthesizes_timelines_once(world):
    u = world.user()
    with SessionLocal() as db:
        now = utcnow()
        req = EmergencyRequest(requester_id=u["id"], lat=13.08, lng=80.27, status=RequestStatus.completed,
                               created_at=now - timedelta(hours=2), dispatched_at=now - timedelta(hours=2),
                               accepted_at=now - timedelta(minutes=119), completed_at=now - timedelta(minutes=60))
        req._hads_no_events = True
        db.add(req)
        db.flush()
        db.add(TripRecord(request_id=req.id, arrived_scene_at=now - timedelta(minutes=110),
                          arrived_hospital_at=now - timedelta(minutes=80), handover_time=now - timedelta(minutes=60)))
        db.commit()
        assert trips.timeline(db, req.id) == []
        assert trips.backfill_events(db) == 9
        db.commit()
        assert trips.backfill_events(db) == 0
        tl = trips.timeline(db, req.id)
        assert [e["status"] for e in tl][0] == "received" and tl[-1]["status"] == "completed"
        assert [e["at"] for e in tl] == sorted(e["at"] for e in tl)


# ---------------------------------------------------------------- tracking payload (section 2)
def test_tracking_payload_v2(client, scene, published):
    s = scene
    rid = sos(client, s["user"]["h"], severity=4, incident_type="cardiac").json()["id"]
    run_trip(client, s, rid, handover=False)
    client.post(f"/api/requests/{rid}/share", headers=s["user"]["h"])
    # crew is driving: two pings give a heading
    t = client.get(f"/api/requests/{rid}/tracking", headers=s["user"]["h"]).json()
    for k in ("route", "crew", "timeline", "share", "bill", "feedback", "ambulance", "hospital", "path", "eta_seconds"):
        assert k in t
    assert t["crew"] == {"name": "Murugan Selvaraj", "phone": "9840100001", "initials": "MS"}
    assert t["ambulance"]["kind"] == "ALS" and "heading_deg" in t["ambulance"]
    assert t["hospital"]["reserved"] == "icu" and "address" in t["hospital"] and "available_icu" in t["hospital"]
    assert t["share"]["url"] == f"/t/{t['share']['token']}" and t["bill"] is None
    assert t["request"]["timeline"] == t["timeline"]

    # authority may view, but not the crew phone; and no share link
    auth = client.get(f"/api/requests/{rid}/tracking", headers=s["admin"]["h"]).json()
    assert auth["crew"]["phone"] == "9840100001"  # admin == controller privileges
    assert client.post(f"/api/hospitals/{s['h']}/handover/{rid}", headers=s["staff"]["h"]).status_code == 200
    done = client.get(f"/api/requests/{rid}/tracking", headers=s["user"]["h"]).json()
    assert done["route"] is None and done["timeline"][-1]["status"] == "completed"
    assert done["bill"] is None or set(done["bill"]) == {"id", "amount", "payment_status", "insurance_claim_status"}


def test_route_and_heading_follow_location_updates(client, scene, published):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    assert client.post(f"/api/crew/offers/{rid}/accept", headers=s["crew"]["h"]).status_code == 200
    assert any(ty == "request.route" for _t, ty, _d in published)  # leg created on accept
    step(client, s["crew"], rid, "en_route")
    published.clear()
    client.post("/api/crew/location", json={"lat": 13.0845, "lng": 80.2715}, headers=s["crew"]["h"])
    loc = [d for t, ty, d in published if ty == "ambulance.location" and t == f"request:{rid}"][0]
    assert loc["phase"] == "to_patient" and loc["heading_deg"] is not None and loc["request_id"] == rid
    t = client.get(f"/api/requests/{rid}/tracking", headers=s["user"]["h"]).json()
    assert t["route"]["phase"] == "to_patient" and t["route"]["polyline"][0] == [13.0845, 80.2715]
    assert t["route"]["eta_seconds"] == t["eta_seconds"] and t["ambulance"]["heading_deg"] == loc["heading_deg"]


def test_authority_tracking_hides_crew_phone(client, scene, world):
    rid = sos(client, scene["user"]["h"]).json()["id"]
    a = world.user(Role.authority)
    t = client.get(f"/api/requests/{rid}/tracking", headers=a["h"]).json()
    assert t["crew"]["phone"] is None and t["share"] is None


# ---------------------------------------------------------------- share links (section 4)
def test_share_link_rules_and_public_view(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    assert client.post(f"/api/requests/{rid}/share", headers=s["other"]["h"]).status_code == 403
    assert client.post(f"/api/requests/{rid}/share", headers=s["crew"]["h"]).status_code == 403
    a = client.post(f"/api/requests/{rid}/share", headers=s["user"]["h"]).json()
    b = client.post(f"/api/requests/{rid}/share", headers=s["ctl"]["h"]).json()
    assert a == b and a["url"] == f"/t/{a['token']}" and sharing.signature_ok(a["token"])  # idempotent

    pub = client.get(f"/api/public/track/{a['token']}")  # NO auth header
    assert pub.status_code == 200
    j = pub.json()
    assert set(j) >= {"status", "timeline", "ambulance", "eta_seconds", "route", "hospital", "patient_area"}
    assert set(j["ambulance"]) == {"registration_number", "lat", "lng", "heading_deg"}
    assert j["patient_area"]["lat"] == round(13.0827, 3) and j["patient_area"]["label"]
    flat = str(j)
    assert "9000000001" not in flat and "9840100001" not in flat and "caller" not in flat and "requester" not in flat

    rid_, sig = a["token"].split(".")
    assert client.get(f"/api/public/track/{rid_}.{'0' * len(sig)}").status_code == 404  # forged signature
    assert client.get("/api/public/track/nonsense").status_code == 404


def test_share_link_expires_two_hours_after_completion(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    tok = client.post(f"/api/requests/{rid}/share", headers=s["user"]["h"]).json()["token"]
    run_trip(client, s, rid)
    assert client.get(f"/api/public/track/{tok}").status_code == 200  # just completed
    assert client.post(f"/api/requests/{rid}/share", headers=s["user"]["h"]).status_code == 409
    with SessionLocal() as db:
        db.get(EmergencyRequest, rid).completed_at = utcnow() - timedelta(hours=2, minutes=1)
        db.commit()
    assert client.get(f"/api/public/track/{tok}").status_code == 404


def test_share_link_expires_after_cancellation(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    tok = client.post(f"/api/requests/{rid}/share", headers=s["user"]["h"]).json()["token"]
    client.post(f"/api/requests/{rid}/cancel", headers=s["user"]["h"])
    assert client.get(f"/api/public/track/{tok}").status_code == 200
    with SessionLocal() as db:
        for ev in db.execute(select(RequestEvent).where(RequestEvent.request_id == rid)).scalars():
            ev.at = utcnow() - timedelta(hours=3)
        db.commit()
    assert client.get(f"/api/public/track/{tok}").status_code == 404


def test_ws_anonymous_share_subscription(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    tok = client.post(f"/api/requests/{rid}/share", headers=s["user"]["h"]).json()["token"]
    with client.websocket_connect(f"/api/ws?share={tok}") as ws:
        assert ws.receive_json()["data"]["topics"] == [f"request:{rid}"]
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/ws?share={tok}&topics=controller") as ws:
            ws.receive_json()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/ws?share=bad.token") as ws:
            ws.receive_json()


# ---------------------------------------------------------------- feedback (section 5)
def test_feedback_rules_and_avg_rating(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    fb = {"rating": 5, "comment": "Arrived fast, very kind crew"}
    assert client.post(f"/api/requests/{rid}/feedback", json=fb, headers=s["user"]["h"]).status_code == 409  # not done
    run_trip(client, s, rid)
    assert client.post(f"/api/requests/{rid}/feedback", json=fb, headers=s["other"]["h"]).status_code == 403
    assert client.post(f"/api/requests/{rid}/feedback", json=fb, headers=s["ctl"]["h"]).status_code == 403
    assert client.post(f"/api/requests/{rid}/feedback", json={"rating": 6}, headers=s["user"]["h"]).status_code == 422
    assert client.post(f"/api/requests/{rid}/feedback", json={"rating": 0}, headers=s["user"]["h"]).status_code == 422
    r = client.post(f"/api/requests/{rid}/feedback", json=fb, headers=s["user"]["h"])
    assert r.status_code == 200 and r.json() == {"rating": 5, "comment": fb["comment"]}
    assert client.post(f"/api/requests/{rid}/feedback", json={"rating": 4}, headers=s["user"]["h"]).json()["rating"] == 4
    with SessionLocal() as db:
        assert db.execute(select(TripRecord).where(TripRecord.request_id == rid)).scalar_one().summary["feedback"]["rating"] == 4
    t = client.get(f"/api/requests/{rid}/tracking", headers=s["user"]["h"]).json()
    assert t["feedback"] == {"rating": 4, "comment": None}
    k = client.get("/api/dashboard/summary?days=7", headers=s["admin"]["h"]).json()["kpis"]
    assert k["avg_rating"] == 4.0


# ---------------------------------------------------------------- crew /me (section 6)
def test_crew_me_offer_details_and_phone_privacy(client, scene):
    s = scene
    with SessionLocal() as db:
        db.add(PlatformSetting(key="crew_ack_timeout_s", value={"value": 45}))
        db.commit()
    rid = sos(client, s["user"]["h"]).json()["id"]
    me = client.get("/api/crew/me", headers=s["crew"]["h"]).json()
    off = me["pending_offer"]
    assert off["id"] == rid and off["caller_phone"] is None and off["zone_label"]
    assert off["distance_km"] > 0 and off["eta_seconds"] > 0
    assert (trips.datetime.fromisoformat(off["offer_expires_at"]) - trips.datetime.fromisoformat(off["offered_at"])).total_seconds() == 45
    assert client.get(f"/api/requests/{rid}", headers=s["crew"]["h"]).json()["caller_phone"] is None
    assert me["crew"] == {"name": "Murugan Selvaraj", "initials": "MS"}
    assert set(me["stats_today"]) == {"trips", "distance_km", "online_minutes"}
    client.post(f"/api/crew/offers/{rid}/accept", headers=s["crew"]["h"])
    me = client.get("/api/crew/me", headers=s["crew"]["h"]).json()
    assert me["active_trip"]["caller_phone"] == "9000000001"
    for st in ("en_route", "on_scene", "transporting", "arrived"):
        step(client, s["crew"], rid, st)
    client.post(f"/api/hospitals/{s['h']}/handover/{rid}", headers=s["staff"]["h"])
    assert client.get("/api/crew/me", headers=s["crew"]["h"]).json()["stats_today"]["trips"] == 1


# ---------------------------------------------------------------- controller / hospital (section 7)
def test_controller_board_and_candidates_additions(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    board = client.get("/api/controller/board", headers=s["ctl"]["h"]).json()
    amb = [a for a in board["ambulances"] if a["id"] == s["amb"]][0]
    assert amb["crew_name"] == "Murugan Selvaraj" and amb["request_id"] == rid and "heading_deg" in amb
    req = [r for r in board["requests"] if r["id"] == rid][0]
    assert req["zone_label"] and req["timeline"]
    cands = client.get(f"/api/controller/requests/{rid}/candidates", headers=s["ctl"]["h"]).json()
    assert cands == [] or "station_name" in cands[0]


def test_hospital_incoming_and_handovers(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"], severity=4, incident_type="cardiac").json()["id"]
    run_trip(client, s, rid, handover=False)
    inc = client.get(f"/api/hospitals/{s['h']}/incoming", headers=s["staff"]["h"]).json()[0]
    assert inc["request"]["id"] == rid and inc["id"] == rid  # v2 item + v1 fields
    assert inc["crew"] == {"name": "Murugan Selvaraj", "phone": "9840100001", "initials": "MS"}
    assert inc["ambulance"]["registration_number"] and inc["reserved"] == "icu" and "eta_seconds" in inc
    client.post(f"/api/hospitals/{s['h']}/handover/{rid}", headers=s["staff"]["h"])
    ho = client.get(f"/api/hospitals/{s['h']}/handovers?limit=5", headers=s["staff"]["h"]).json()
    assert ho[0]["request"]["id"] == rid and ho[0]["handover_confirmed_by"]["id"] == s["staff"]["id"]
    assert ho[0]["ambulance"]["kind"] == "ALS" and ho[0]["handover_time"]
    assert client.get(f"/api/hospitals/{s['h']}/handovers", headers=s["user"]["h"]).status_code == 403


# ---------------------------------------------------------------- logic fixes (section 10)
def test_redirect_avoided_when_destination_kept(client, scene):
    s = scene
    rid = sos(client, s["user"]["h"]).json()["id"]
    run_trip(client, s, rid)
    with SessionLocal() as db:
        assert db.execute(select(TripRecord).where(TripRecord.request_id == rid)).scalar_one().summary["redirect_avoided"] is True


def test_redirect_not_avoided_when_controller_changes_destination(client, scene, world):
    s = scene
    h2 = world.hospital(lat=13.06, lng=80.25)  # farther than the auto-chosen one
    rid = sos(client, s["user"]["h"]).json()["id"]
    assert client.post(f"/api/controller/requests/{rid}/destination", json={"hospital_id": h2},
                       headers=s["ctl"]["h"]).status_code == 200
    staff2 = world.user(Role.hospital_staff, hospital_id=h2)
    run_trip(client, {**s, "h": h2, "staff": staff2}, rid)
    with SessionLocal() as db:
        assert db.execute(select(TripRecord).where(TripRecord.request_id == rid)).scalar_one().summary["redirect_avoided"] is False


def test_capacity_staleness_reads_platform_setting(client, world):
    from app.services import capacity
    h = world.hospital()
    with SessionLocal() as db:
        hosp = db.get(Hospital, h)
        hosp.capacity_updated_at = utcnow() - timedelta(minutes=20)
        db.commit()
        assert capacity.is_stale(hosp) is True  # default 15 min
        db.add(PlatformSetting(key="capacity_stale_min", value={"value": 30}))
        db.commit()
        assert capacity.is_stale(hosp) is False
