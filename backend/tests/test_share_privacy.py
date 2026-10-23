"""Anonymous family-share viewers never receive names, phones or the exact patient location (v2 section 4)."""
import asyncio
import json

from app.db import SessionLocal
from app.events import Hub
from app.models import Ambulance, Role
from app.services import sharing
from conftest import PATIENT, sos

PII = ("caller_phone", "caller_name", "requester_id", "phone", "name_of_caller")
EXACT = (PATIENT[0], PATIENT[1])


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send_text(self, text):
        self.sent.append(json.loads(text))


def _events():
    """Every event type published on request:{id} today, plus a hostile one carrying a full RequestOut."""
    full_request = {"id": 7, "caller_name": "Anitha Krishnan", "caller_phone": "9000000001", "lat": EXACT[0],
                    "lng": EXACT[1], "address": "12 Usman Road", "requester_id": 3}
    return [
        ("request.status", {"request_id": 7, "status": "en_route", "eta_seconds": 200, "ambulance_id": 1,
                            "destination_hospital_id": 2, "request": full_request, "caller_phone": "9000000001"}),
        ("ambulance.location", {"ambulance_id": 1, "request_id": 7, "lat": EXACT[0] + 0.0001, "lng": EXACT[1],
                                "heading_deg": 90.0, "eta_seconds": 0, "phase": "to_patient", "status": "on_scene"}),
        ("request.route", {"request_id": 7, "phase": "to_patient", "eta_seconds": 120, "distance_km": 1.2,
                           "polyline": [[13.095, 80.285], [13.0900, 80.2800], [EXACT[0] + 0.0005, EXACT[1]], list(EXACT)]}),
        ("destination.confirmed", {"request_id": 7, "hospital": {"id": 2, "name": "Apollo", "lat": 13.06, "lng": 80.25,
                                   "phone": "044"}, "eta_seconds": 300, "capacity": "known"}),
        ("dispatch.escalated", {"request_id": 7, "reason": "no_available_ambulance", "lat": EXACT[0], "lng": EXACT[1]}),
        ("hospital.incoming", {"request_id": 7, "hospital_id": 2, "acknowledged": True}),
        ("trip.closed", {"request_id": 7, "trip_id": 4, "closed_manually": False}),
        ("some.future.event", {"request_id": 7, "caller_phone": "9000000001"}),
    ]


def _leaks(msg) -> list[str]:
    flat = json.dumps(msg)
    bad = [k for k in PII if f'"{k}"' in flat] + [v for v in ("9000000001", "Anitha", "Usman Road") if v in flat]
    coords = []

    def walk(x):
        if isinstance(x, dict):
            if "lat" in x and "lng" in x:
                coords.append((x["lat"], x["lng"]))
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            if len(x) == 2 and all(isinstance(v, float) for v in x):
                coords.append(tuple(x))
            else:
                for v in x:
                    walk(v)
    walk(msg)
    for la, ln in coords:  # anything near the patient must sit on the 3-decimal grid
        if abs(la - EXACT[0]) < 0.003 and abs(ln - EXACT[1]) < 0.003 and (round(la, 3) != la or round(ln, 3) != ln):
            bad.append(f"exact location {la},{ln}")
    return bad


def test_sanitizer_whitelists_and_coarsens_every_event_type():
    for type_, data in _events():
        out = sharing.sanitize_event(type_, data, EXACT)
        if type_ in ("hospital.incoming", "some.future.event"):
            assert out is None, type_  # not whitelisted -> dropped
            continue
        assert out is not None and not _leaks(out), (type_, out)
    route = sharing.sanitize_event(*_events()[2], EXACT)
    assert route["polyline"][:2] == [[13.095, 80.285], [13.09, 80.28]]  # far vertices untouched
    assert route["polyline"][-1] == [round(EXACT[0], 3), round(EXACT[1], 3)] and len(route["polyline"]) == 3
    far = sharing.sanitize_event("ambulance.location", {"lat": 13.1234567, "lng": 80.2987654}, EXACT)
    assert far == {"lat": 13.1234567, "lng": 80.2987654}  # en-route positions stay precise


def test_hub_sends_full_payload_to_staff_but_sanitized_to_share_socket():
    hub, staff, family = Hub(), FakeWS(), FakeWS()

    async def go():
        hub.bind_loop(asyncio.get_running_loop())
        await hub.subscribe("request:7", staff)
        await hub.subscribe("request:7", family, sharing.share_filter(EXACT))
        for type_, data in _events():
            hub.publish("request:7", type_, data)
        await asyncio.sleep(0.05)
    asyncio.run(go())
    assert len(staff.sent) == len(_events())
    assert staff.sent[0]["data"]["caller_phone"] == "9000000001"  # unchanged for authorised subscribers
    assert {m["type"] for m in family.sent} == {"request.status", "ambulance.location", "request.route",
                                               "destination.confirmed", "dispatch.escalated", "trip.closed"}
    for m in family.sent:
        assert not _leaks(m), m
    hub.unsubscribe_all(family)
    assert family not in hub.filters


def test_public_payload_coarsens_ambulance_on_scene(client, world):
    h = world.hospital(lat=13.10, lng=80.29)
    st = world.station(h)
    amb = world.ambulance(st, lat=13.085, lng=80.272)
    crew = world.crew(amb)
    user = world.user(phone="9000000001")
    rid = sos(client, user["h"]).json()["id"]
    tok = client.post(f"/api/requests/{rid}/share", headers=user["h"]).json()["token"]
    client.post(f"/api/crew/offers/{rid}/accept", headers=crew["h"])
    j = client.get(f"/api/public/track/{tok}").json()
    assert j["route"]["polyline"][-1] == [round(EXACT[0], 3), round(EXACT[1], 3)] and not _leaks(j)
    for s in ("en_route", "on_scene"):
        client.post(f"/api/crew/trips/{rid}/status", json={"status": s}, headers=crew["h"])
    client.post("/api/crew/location", json={"lat": EXACT[0] + 0.00012, "lng": EXACT[1] - 0.00007}, headers=crew["h"])
    j = client.get(f"/api/public/track/{tok}").json()
    assert j["status"] == "on_scene" and not _leaks(j)
    assert (j["ambulance"]["lat"], j["ambulance"]["lng"]) == (round(EXACT[0] + 0.00012, 3), round(EXACT[1] - 0.00007, 3))
    with SessionLocal() as db:  # staff still see the true position
        assert db.get(Ambulance, amb).lat == EXACT[0] + 0.00012
    staff = client.get(f"/api/requests/{rid}/tracking", headers=world.user(Role.controller)["h"]).json()
    assert staff["ambulance"]["lat"] == EXACT[0] + 0.00012
