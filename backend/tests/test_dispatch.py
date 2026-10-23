import threading
from datetime import timedelta

from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.models import (Ambulance, AmbulanceStatus, AuditLog, DispatchAttempt, EmergencyRequest, RequestStatus, Role,
                        utcnow)
from app.services import dispatch, routing
from conftest import PATIENT, sos


def fetch(client, headers, rid):
    return client.get(f"/api/requests/{rid}", headers=headers).json()


def test_nearest_by_eta_is_chosen_and_audited(client, world):
    b = world.basic()
    far = world.ambulance(b["station"], lat=13.14, lng=80.33)
    near = world.ambulance(b["station"], lat=13.085, lng=80.272)
    mid = world.ambulance(b["station"], lat=13.10, lng=80.29)
    u = world.user()
    body = sos(client, u["h"]).json()
    got = fetch(client, u["h"], body["id"])
    assert got["status"] == "offered" and got["ambulance"]["id"] == near
    assert got["match_duration_ms"] is not None and got["match_duration_ms"] < 8000
    assert got["dispatched_at"] and got["eta_seconds"] > 0
    assert got["attempts"][0]["rank"] == 1 and got["attempts"][0]["ambulance_id"] == near
    with SessionLocal() as db:
        assert db.get(Ambulance, near).status == AmbulanceStatus.assigned
        assert db.get(Ambulance, mid).status == AmbulanceStatus.available
        row = db.execute(select(AuditLog).where(AuditLog.action == "dispatch.assign")).scalar_one()
        assert [c["ambulance_id"] for c in row.details["ranking"]] == [near, mid, far]


def test_only_genuinely_available_ambulances(client, world):
    b = world.basic()
    world.ambulance(b["station"], lat=13.0828, lng=80.2708, status=AmbulanceStatus.offline)
    world.ambulance(b["station"], lat=13.0828, lng=80.2708, status=AmbulanceStatus.en_route)
    world.ambulance(b["station"], lat=13.0828, lng=80.2708, staffed=False)
    world.ambulance(b["station"], lat=13.0828, lng=80.2708, fresh=False)      # stale GPS
    world.ambulance(b["station"], gps=False)                                     # never reported GPS
    world.ambulance(b["station"], lat=14.5, lng=80.27)                           # outside search radius
    ok = world.ambulance(b["station"], lat=13.10, lng=80.28)
    u = world.user()
    assert fetch(client, u["h"], sos(client, u["h"]).json()["id"])["ambulance"]["id"] == ok


def _free_all():
    with SessionLocal() as db:
        for a in db.execute(select(Ambulance)).scalars():
            a.status = AmbulanceStatus.available
        db.commit()


def test_severity_prefers_als_and_low_severity_saves_it(client, world):
    b = world.basic()
    bls = world.ambulance(b["station"], lat=13.085, lng=80.272, kind="BLS")
    als = world.ambulance(b["station"], lat=13.092, lng=80.277, kind="ALS")  # slightly further (<4 min)
    u = world.user()
    crit = sos(client, u["h"], severity=5).json()
    assert fetch(client, u["h"], crit["id"])["ambulance"]["id"] == als
    _free_all()
    minor = sos(client, u["h"], severity=1).json()
    assert fetch(client, u["h"], minor["id"])["ambulance"]["id"] == bls


def test_ranking_ignores_requester_identity(client, world):
    """STRQ1: same incident from different people/phones/addresses gets identical ranking."""
    b = world.basic()
    for dlat in (0.005, 0.02, 0.04):
        world.ambulance(b["station"], lat=13.0827 + dlat, lng=80.2707)
    rankings = []
    for name, phone, addr in [("VIP Minister", "9000000001", "Raj Bhavan"), ("Nobody", "9000000002", "Slum 5")]:
        with SessionLocal() as db:
            req = EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=3, caller_name=name, caller_phone=phone,
                                   address=addr)
            rankings.append([(c["ambulance_id"], c["eta_seconds"]) for c in dispatch.rank_candidates(db, req, set())])
    assert rankings[0] == rankings[1] and len(rankings[0]) == 3


def test_two_simultaneous_requests_one_ambulance(client, world):
    b = world.basic()
    amb = world.ambulance(b["station"], lat=13.085, lng=80.272)
    ids = []
    with SessionLocal() as db:
        for _ in range(2):
            r = EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=3)
            db.add(r)
            db.commit()
            ids.append(r.id)
    errors = []

    def go(rid):
        try:
            dispatch.run_dispatch(rid)
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    ts = [threading.Thread(target=go, args=(i,)) for i in ids]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errors
    with SessionLocal() as db:
        reqs = [db.get(EmergencyRequest, i) for i in ids]
        assert sorted(r.status.value for r in reqs) == ["awaiting_manual", "offered"]
        assert sum(1 for r in reqs if r.ambulance_id == amb) == 1
        assert len(db.execute(select(DispatchAttempt)).scalars().all()) == 1


def test_api_level_concurrent_requests_never_share_an_ambulance(client, world):
    b = world.basic()
    a1 = world.ambulance(b["station"], lat=13.085, lng=80.272)
    a2 = world.ambulance(b["station"], lat=13.09, lng=80.28)
    users = [world.user() for _ in range(4)]
    out = {}

    def go(i):
        out[i] = sos(client, users[i]["h"]).json()["id"]

    ts = [threading.Thread(target=go, args=(i,)) for i in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    with SessionLocal() as db:
        reqs = [db.get(EmergencyRequest, i) for i in out.values()]
    assigned = [r.ambulance_id for r in reqs if r.ambulance_id]
    assert sorted(assigned) == sorted([a1, a2])
    assert sum(1 for r in reqs if r.status == RequestStatus.awaiting_manual) == 2


def test_higher_severity_dispatched_first(client, world):
    b = world.basic()
    amb = world.ambulance(b["station"], lat=13.085, lng=80.272)
    with SessionLocal() as db:
        low = EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=2, created_at=utcnow() - timedelta(seconds=30))
        high = EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=5)
        db.add_all([low, high])
        db.commit()
        low_id, high_id = low.id, high.id
    dispatch.run_dispatch(low_id)  # the earlier, minor request triggers the run, but the critical one is served first
    with SessionLocal() as db:
        assert db.get(EmergencyRequest, high_id).ambulance_id == amb
        assert db.get(EmergencyRequest, low_id).status == RequestStatus.awaiting_manual


def test_retry_escalated_when_ambulance_frees(client, world):
    b = world.basic()
    amb = world.ambulance(b["station"], status=AmbulanceStatus.offline)
    u = world.user()
    rid = sos(client, u["h"]).json()["id"]
    assert fetch(client, u["h"], rid)["status"] == "awaiting_manual"
    assert dispatch.retry_escalated() == []
    with SessionLocal() as db:
        db.get(Ambulance, amb).status = AmbulanceStatus.available
        db.commit()
    assert dispatch.retry_escalated() == [rid]
    got = fetch(client, u["h"], rid)
    assert got["status"] == "offered" and got["ambulance"]["id"] == amb


def test_zone_risk_only_breaks_ties(client, world, monkeypatch):
    b = world.basic()
    a1 = world.ambulance(b["station"], lat=13.085, lng=80.272)
    a2 = world.ambulance(b["station"], lat=13.085, lng=80.272)  # identical ETA
    from app.geo import zone_of
    monkeypatch.setattr(dispatch.analytics, "get_zone_risk", lambda db, hour=None: {zone_of(13.085, 80.272): 0.9})
    req = EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=3)
    with SessionLocal() as db:
        ranked = dispatch.rank_candidates(db, req)
    assert [c["ambulance_id"] for c in ranked] == [a1, a2]
    far = world.ambulance(b["station"], lat=13.2, lng=80.3)
    with SessionLocal() as db:
        ranked = dispatch.rank_candidates(db, req)
    assert ranked[-1]["ambulance_id"] == far  # risk never overrides a clearly faster unit


# ---------------------------------------------------------------- routing provider
def test_routing_eta_uses_road_and_traffic():
    a, b = (13.08, 80.27), (13.12, 80.31)
    from app.geo import haversine_km
    straight_s = haversine_km(*a, *b) / get_settings().avg_speed_kmph * 3600
    assert routing.eta_seconds(a, b, hour=3) > straight_s            # detour factor
    assert routing.eta_seconds(a, b, hour=9) > routing.eta_seconds(a, b, hour=3)  # rush hour slower
    r = routing.route(a, b, hour=9)
    assert r["steps"][-1]["instruction"].startswith("Arrive") and r["polyline"][0] == [13.08, 80.27]
    assert r["eta_seconds"] == routing.eta_seconds(a, b, hour=9)


def test_osrm_failure_falls_back(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "routing_provider", "osrm")
    monkeypatch.setattr(s, "osrm_url", "http://127.0.0.1:9")  # nothing listens here
    a, b = (13.08, 80.27), (13.12, 80.31)
    assert routing.eta_seconds(a, b, hour=3) > 0
    assert routing.route(a, b)["provider"] == "haversine"


# ---------------------------------------------------------------- UC-2 E1 / reject
def test_crew_reject_reassigns_next_ranked(client, world):
    b = world.basic()
    a1 = world.ambulance(b["station"], lat=13.085, lng=80.272)
    a2 = world.ambulance(b["station"], lat=13.10, lng=80.29)
    c1 = world.crew(a1)
    u = world.user()
    rid = sos(client, u["h"]).json()["id"]
    assert fetch(client, u["h"], rid)["ambulance"]["id"] == a1
    r = client.post(f"/api/crew/offers/{rid}/reject", json={"reason": "vehicle fault"}, headers=c1["h"])
    assert r.status_code == 200
    got = fetch(client, u["h"], rid)
    assert got["ambulance"]["id"] == a2 and got["status"] == "offered"
    assert [(a["ambulance_id"], a["status"]) for a in got["attempts"]] == [(a1, "rejected"), (a2, "offered")]
    with SessionLocal() as db:
        assert db.get(Ambulance, a1).status == AmbulanceStatus.available
    assert client.post(f"/api/crew/offers/{rid}/reject", headers=c1["h"]).status_code == 403  # no longer theirs


def test_ack_timeout_reassigns_and_audits(client, world, monkeypatch, published):
    b = world.basic()
    a1 = world.ambulance(b["station"], lat=13.085, lng=80.272)
    a2 = world.ambulance(b["station"], lat=13.10, lng=80.29)
    u = world.user()
    rid = sos(client, u["h"]).json()["id"]
    assert dispatch.expire_stale_offers() == []  # not yet due
    monkeypatch.setattr(get_settings(), "crew_ack_timeout_s", 30)
    assert dispatch.expire_stale_offers(now=utcnow() + timedelta(seconds=31)) == [rid]
    got = fetch(client, u["h"], rid)
    assert got["ambulance"]["id"] == a2
    assert [a["status"] for a in got["attempts"]] == ["timeout", "offered"]
    with SessionLocal() as db:
        assert db.get(Ambulance, a1).status == AmbulanceStatus.available
        assert db.execute(select(AuditLog).where(AuditLog.action == "dispatch.timeout")).scalar_one().entity_id == str(rid)
    # last unit times out too -> nobody left -> escalate
    assert dispatch.expire_stale_offers(now=utcnow() + timedelta(seconds=120)) == [rid]
    assert fetch(client, u["h"], rid)["status"] == "awaiting_manual"
    assert any(ty == "dispatch.escalated" for _, ty, _ in published)


def test_late_accept_after_timeout_is_rejected(client, world):
    b = world.basic()
    a1 = world.ambulance(b["station"], lat=13.085, lng=80.272)
    c1 = world.crew(a1)
    u = world.user()
    rid = sos(client, u["h"]).json()["id"]
    dispatch.expire_stale_offers(now=utcnow() + timedelta(seconds=999))
    assert client.post(f"/api/crew/offers/{rid}/accept", headers=c1["h"]).status_code in (403, 409)


# ---------------------------------------------------------------- controller overrides
def test_controller_manual_assign_cross_station(client, world):
    b = world.basic()
    far_station = world.station(b["hospital"], lat=13.3, lng=80.5)
    far = world.ambulance(far_station, lat=13.3, lng=80.5)  # outside auto radius
    ctl = world.user(Role.controller)
    u = world.user()
    rid = sos(client, u["h"]).json()["id"]
    assert fetch(client, u["h"], rid)["status"] == "awaiting_manual"
    assert client.get("/api/controller/board", headers=ctl["h"]).json()["escalations"] == [rid]
    assert client.post(f"/api/controller/requests/{rid}/assign", json={"ambulance_id": far}, headers=u["h"]).status_code == 403
    r = client.post(f"/api/controller/requests/{rid}/assign", json={"ambulance_id": far, "reason": "cross-station"}, headers=ctl["h"])
    assert r.status_code == 200 and r.json()["status"] == "offered" and r.json()["ambulance"]["id"] == far
    assert client.post(f"/api/controller/requests/{rid}/assign", json={"ambulance_id": far}, headers=ctl["h"]).status_code == 409
    with SessionLocal() as db:
        row = db.execute(select(AuditLog).where(AuditLog.action == "dispatch.override")).scalar_one()
        assert row.user_id == ctl["id"] and row.details["ambulance_id"] == far


def test_candidates_endpoint_explains_ranking(client, world):
    b = world.basic()
    world.ambulance(b["station"], lat=13.085, lng=80.272)  # takes the offer
    a2 = world.ambulance(b["station"], lat=13.10, lng=80.29)
    ctl = world.user(Role.controller)
    rid = sos(client, world.user()["h"]).json()["id"]
    c = client.get(f"/api/controller/requests/{rid}/candidates", headers=ctl["h"]).json()
    assert [x["ambulance_id"] for x in c] == [a2]  # the first unit is already offered
    assert c[0]["eta_seconds"] > 0 and c[0]["rank"] == 1
    assert client.get(f"/api/controller/requests/{rid}/candidates", headers=world.user()["h"]).status_code == 403
