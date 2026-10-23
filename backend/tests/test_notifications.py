"""Durable in-app notifications (Task 16, WBS 4.5): stored per user, pushed on user:{id}, readable after reconnect."""
import pytest
from starlette.websockets import WebSocketDisconnect

from app.models import Role
from conftest import sos, ws_url


@pytest.fixture
def scene(client, world):
    h = world.hospital(lat=13.10, lng=80.29)
    st = world.station(h)
    amb = world.ambulance(st, lat=13.085, lng=80.272, kind="ALS")
    return {"h": h, "amb": amb, "crew": world.crew(amb), "staff": world.user(Role.hospital_staff, hospital_id=h),
            "ctl": world.user(Role.controller), "user": world.user()}


def types(client, who, unread=None):
    q = "" if unread is None else f"?unread={'true' if unread else 'false'}"
    return [n["type"] for n in client.get(f"/api/notifications{q}", headers=who["h"]).json()]


def _trip(client, s):
    rid = sos(client, s["user"]["h"], incident_type="cardiac", severity=4).json()["id"]
    c = s["crew"]["h"]
    assert client.post(f"/api/crew/offers/{rid}/accept", headers=c).status_code == 200
    for st in ("en_route", "on_scene", "transporting"):
        assert client.post(f"/api/crew/trips/{rid}/status", json={"status": st}, headers=c).status_code == 200
    return rid


def test_trip_notifies_each_party(client, scene):
    s = scene
    rid = _trip(client, s)
    assert "dispatch.offer" in types(client, s["crew"])
    assert "hospital.incoming" in types(client, s["staff"])
    assert "destination.confirmed" in types(client, s["user"])
    assert client.post(f"/api/hospitals/{s['h']}/incoming/{rid}/acknowledge", headers=s["staff"]["h"]).status_code == 200
    assert "hospital.acknowledged" in types(client, s["user"])
    assert client.post(f"/api/crew/trips/{rid}/status", json={"status": "arrived"}, headers=s["crew"]["h"]).status_code == 200
    assert client.post(f"/api/hospitals/{s['h']}/handover/{rid}", headers=s["staff"]["h"]).status_code == 200
    assert "request.completed" in types(client, s["user"])


def test_escalation_notifies_controllers(client, world):
    ctl, user = world.user(Role.controller), world.user()
    sos(client, user["h"])          # no ambulances at all -> awaiting_manual
    assert "dispatch.escalated" in types(client, ctl)


def test_read_count_and_isolation(client, scene):
    s = scene
    _trip(client, s)
    u = s["user"]["h"]
    n = client.get("/api/notifications/count", headers=u).json()["unread"]
    items = client.get("/api/notifications?unread=true", headers=u).json()
    assert n == len(items) >= 1 and all(i["read_at"] is None for i in items)
    first = items[0]["id"]
    assert client.post(f"/api/notifications/{first}/read", headers=s["staff"]["h"]).status_code == 404  # not theirs
    assert client.post(f"/api/notifications/{first}/read", headers=u).status_code == 200
    assert client.get("/api/notifications/count", headers=u).json()["unread"] == n - 1
    assert client.post("/api/notifications/read-all", headers=u).status_code == 200
    assert client.get("/api/notifications/count", headers=u).json()["unread"] == 0
    assert types(client, s["user"], unread=True) == []


def test_user_topic_only_for_self(client, scene):
    s = scene
    me = s["user"]
    with client.websocket_connect(ws_url(client, me, f"user:{me['id']}")) as ws:
        assert ws.receive_json()["type"] == "subscribed"
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(ws_url(client, s["staff"], f"user:{me['id']}")) as ws:
            ws.receive_json()


def test_requires_auth(client):
    assert client.get("/api/notifications").status_code == 401


def test_pushed_on_user_topic_after_commit(client, world, published):
    ctl, user = world.user(Role.controller), world.user()
    sos(client, user["h"])
    pushes = [(t, ty, d) for t, ty, d in published if t == f"user:{ctl['id']}"]
    assert pushes and pushes[0][1] == "notification" and pushes[0][2]["type"] == "dispatch.escalated"
    assert pushes[0][2]["id"]  # a real row id: published only once the row was committed
