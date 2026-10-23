"""OSRM provider (v2 section 1) against a mocked httpx transport -- never touches the network."""
import json

import httpx
import pytest

from app.config import get_settings
from app.services import routing
from conftest import sos

A, B = (13.0418, 80.2341), (13.0604, 80.2521)


def osrm_route_json(duration=600.0, distance=4200.0):
    return {"code": "Ok", "routes": [{
        "distance": distance, "duration": duration,
        "geometry": {"type": "LineString", "coordinates": [[80.2341, 13.0418], [80.2400, 13.0450], [80.2521, 13.0604]]},
        "legs": [{"steps": [
            {"name": "Usman Road", "distance": 900, "duration": 120,
             "maneuver": {"type": "depart", "bearing_after": 45, "location": [80.2341, 13.0418]}},
            {"name": "Anna Salai", "distance": 2500, "duration": 360,
             "maneuver": {"type": "turn", "modifier": "left", "location": [80.2400, 13.0450]}},
            {"name": "", "ref": "", "distance": 300, "duration": 40,
             "maneuver": {"type": "roundabout", "modifier": "right", "exit": 2, "location": [80.2480, 13.0550]}},
            {"name": "Greams Road", "distance": 500, "duration": 80,
             "maneuver": {"type": "end of road", "modifier": "right", "location": [80.2500, 13.0590]}},
            {"name": "Greams Road", "distance": 0, "duration": 0,
             "maneuver": {"type": "arrive", "modifier": "left", "location": [80.2521, 13.0604]}},
        ]}]}]}


class FakeOsrm:
    """Records calls; answers /table and /route like osrm-routed."""

    def __init__(self, mode="ok", table_duration=300.0):
        self.mode, self.calls, self.table_duration = mode, [], table_duration

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.mode == "timeout":
            raise httpx.ReadTimeout("timed out", request=request)
        if self.mode == "500":
            return httpx.Response(500, text="boom")
        path = request.url.path
        if path.startswith("/route/v1/driving/"):
            return httpx.Response(200, json=osrm_route_json())
        if path.startswith("/table/v1/driving/"):
            src = request.url.params["sources"].split(";")
            dst = request.url.params["destinations"].split(";")
            durs = [[self.table_duration * (i + 1) + j for j in range(len(dst))] for i in range(len(src))]
            if self.mode == "null_cell":
                durs[0][0] = None
            dists = [[1000.0 * (i + 1) for _ in dst] for i in range(len(src))]
            return httpx.Response(200, json={"code": "Ok", "durations": durs, "distances": dists})
        return httpx.Response(404, json={"code": "InvalidUrl"})


@pytest.fixture
def osrm(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "routing_provider", "osrm")
    monkeypatch.setattr(s, "osrm_url", "http://osrm.test:5000")
    fake = FakeOsrm()
    routing.reset()
    routing.set_http_client(httpx.Client(transport=httpx.MockTransport(fake)))
    yield fake
    routing.reset()


def test_route_turn_by_turn_shape_and_traffic(osrm):
    r = routing.route(A, B, hour=9)  # peak hour: x1.6 on top of OSRM free-flow
    assert r["provider"] == "osrm" and r["eta_seconds"] == int(600 * routing.traffic_factor(9))
    assert r["distance_km"] == 4.2 and r["polyline"][0] == [13.0418, 80.2341] and r["polyline"][-1] == [13.0604, 80.2521]
    assert r["bearing_deg"] == 45
    st = r["steps"]
    assert set(st[0]) == {"instruction", "name", "maneuver", "distance_m", "duration_s", "lat", "lng"}
    assert [s["instruction"] for s in st] == [
        "Head north-east on Usman Road", "Turn left onto Anna Salai", "At the roundabout, take the second exit",
        "At the end of the road, turn right onto Greams Road", "Arrive at destination on the left"]
    assert st[1]["maneuver"] == {"type": "turn", "modifier": "left"} and st[1]["duration_s"] == int(round(360 * 1.6))
    q = osrm.calls[0].url
    assert q.params["steps"] == "true" and q.params["geometries"] == "geojson" and q.params["overview"] == "full"
    assert "80.234100,13.041800;80.252100,13.060400" in q.path  # lng,lat order


def test_route_is_cached_briefly(osrm):
    routing.route(A, B, hour=3)
    routing.route(A, B, hour=3)
    assert len(osrm.calls) == 1
    routing.route(A, (13.07, 80.26), hour=3)
    assert len(osrm.calls) == 2


def test_table_batches_all_sources_in_one_call(osrm):
    srcs = [(13.0 + i / 100, 80.2) for i in range(7)]
    etas = routing.eta_many(srcs, A, hour=3)
    assert len(osrm.calls) == 1 and etas == [300 * (i + 1) for i in range(7)]
    p = osrm.calls[0].url.params
    assert p["sources"] == "0;1;2;3;4;5;6" and p["destinations"] == "7"
    hs = routing.eta_from(A, [B, (13.1, 80.28)], hour=3)
    assert len(osrm.calls) == 2 and hs == [300, 301]
    assert osrm.calls[1].url.params["sources"] == "0" and osrm.calls[1].url.params["destinations"] == "1;2"


def test_unroutable_cell_falls_back_per_pair(osrm):
    osrm.mode = "null_cell"
    etas = routing.eta_many([A, (13.1, 80.25)], B, hour=3)
    assert etas[0] == routing._haversine_eta(A, B, 3) and etas[1] == 600


@pytest.mark.parametrize("mode", ["timeout", "500"])
def test_failure_falls_back_to_haversine(osrm, mode):
    osrm.mode = mode
    assert routing.route(A, B, hour=3)["provider"] == "haversine"
    assert routing.eta_seconds(A, B, hour=3) == routing._haversine_eta(A, B, 3)


def test_circuit_breaker_opens_then_recovers(osrm, monkeypatch):
    clock = [1000.0]
    s = get_settings()
    br = routing.CircuitBreaker(s.osrm_breaker_failures, 30.0, clock=lambda: clock[0])
    monkeypatch.setattr(routing, "_breaker", br)
    osrm.mode = "timeout"
    for _ in range(s.osrm_breaker_failures):
        routing.eta_seconds(A, B, hour=3)
    assert br.state == "open" and len(osrm.calls) == s.osrm_breaker_failures
    for _ in range(5):  # open: OSRM is not even attempted
        assert routing.eta_seconds(A, B, hour=3) == routing._haversine_eta(A, B, 3)
    assert len(osrm.calls) == s.osrm_breaker_failures
    clock[0] += 31  # cooldown elapsed -> one half-open probe, which succeeds
    osrm.mode = "ok"
    assert routing.eta_seconds(A, B, hour=3) == 300
    assert br.state == "closed" and routing.status()["circuit"] == "closed"


def test_half_open_probe_failure_reopens(osrm, monkeypatch):
    clock = [0.0]
    br = routing.CircuitBreaker(1, 10.0, clock=lambda: clock[0])
    monkeypatch.setattr(routing, "_breaker", br)
    osrm.mode = "500"
    routing.eta_seconds(A, B)
    assert br.state == "open"
    clock[0] = 11
    routing.eta_seconds(A, B)  # probe fails
    assert br.state == "open" and len(osrm.calls) == 2


def test_osrm_timeout_is_configured_to_1_5s():
    routing.reset()
    c = routing.http_client()
    assert get_settings().osrm_timeout_s == 1.5 and c.timeout.read == 1.5
    routing.reset()


@pytest.mark.parametrize("args,expected", [
    (("turn", "right", "Anna Salai"), "Turn right onto Anna Salai"),
    (("turn", "slight left", "Kamarajar Salai"), "Bear left onto Kamarajar Salai"),
    (("turn", "sharp right", ""), "Turn sharp right"),
    (("turn", "uturn", "OMR"), "Make a U-turn onto OMR"),
    (("new name", "straight", "Rajiv Gandhi Salai"), "Continue onto Rajiv Gandhi Salai"),
    (("continue", "straight", "GST Road"), "Continue straight on GST Road"),
    (("fork", "slight right", "Inner Ring Road"), "Keep right at the fork onto Inner Ring Road"),
    (("merge", "slight left", "Poonamallee High Road"), "Merge left onto Poonamallee High Road"),
    (("off ramp", "right", ""), "Take the exit on the right"),
    (("exit roundabout", "right", "100 Feet Road"), "Exit the roundabout onto 100 Feet Road"),
])
def test_instruction_text(args, expected):
    assert routing.instruction(*args) == expected


def test_dispatch_ranks_candidates_with_one_table_call(osrm, client, world):
    b = world.basic()
    for i in range(5):
        world.ambulance(b["station"], lat=13.08 + i / 500, lng=80.27)
    u = world.user()
    osrm.calls.clear()
    rid = sos(client, u["h"]).json()["id"]
    got = client.get(f"/api/requests/{rid}", headers=u["h"]).json()
    assert got["status"] == "offered"
    tables = [c for c in osrm.calls if c.url.path.startswith("/table/")]
    # one /table for the 5 ambulance candidates, one for hospital ranking
    assert len(tables) == 2
    assert len(tables[0].url.params["sources"].split(";")) == 5
    assert got["attempts"][0]["eta_seconds"] == max(1, int(round(300 * routing.traffic_factor())))


def test_crew_route_endpoint_v2_shape(osrm, client, world):
    b = world.basic()
    amb = world.ambulance(b["station"])
    crew = world.crew(amb)
    u = world.user()
    rid = sos(client, u["h"]).json()["id"]
    assert client.post(f"/api/crew/offers/{rid}/accept", headers=crew["h"]).status_code == 200
    r = client.get(f"/api/crew/trips/{rid}/route", headers=crew["h"]).json()
    assert r["phase"] == "to_patient" and r["bearing_deg"] == 45 and r["provider"] == "osrm"
    assert r["steps"][1]["instruction"] == "Turn left onto Anna Salai" and r["steps"][1]["name"] == "Anna Salai"
    assert len(r["polyline"]) == 3
    json.dumps(r)
