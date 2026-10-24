"""Operations: structured logs, request ids, worker heartbeats, retention, health/readiness, system status (Task 20)."""
import asyncio
import json
import logging
import time
from datetime import timedelta

import pytest
from sqlalchemy import func, select

from app.db import SessionLocal
from app.models import AmbulanceLocation, EmergencyRequest, Notification, Role, utcnow
from app.services import background


@pytest.fixture
def beats(monkeypatch):
    hb: dict[str, float] = {}
    monkeypatch.setattr(background, "HEARTBEATS", hb)
    return hb


def test_retention_removes_old_gps_and_old_read_notifications(world):
    amb = world.ambulance(world.station(world.hospital()))
    uid = world.user()["id"]
    now = utcnow()
    with SessionLocal() as db:
        db.add_all([AmbulanceLocation(ambulance_id=amb, lat=13.0, lng=80.2, recorded_at=now - timedelta(hours=30)),
                    AmbulanceLocation(ambulance_id=amb, lat=13.0, lng=80.2, recorded_at=now - timedelta(hours=1))])
        old = now - timedelta(days=40)
        db.add_all([Notification(user_id=uid, type="t", title="old read", created_at=old, read_at=old),
                    Notification(user_id=uid, type="t", title="old unread", created_at=old),
                    Notification(user_id=uid, type="t", title="new read", created_at=now, read_at=now)])
        db.commit()
    out = background.run_retention_once(now)
    assert out == {"gps_locations": 1, "notifications": 1}
    with SessionLocal() as db:
        assert db.scalar(select(func.count(AmbulanceLocation.id))) == 1
        assert sorted(n.title for n in db.execute(select(Notification)).scalars()) == ["new read", "old unread"]


def test_json_log_line_carries_request_id(client, caplog):
    from app.logging_setup import JsonFormatter
    with caplog.at_level(logging.INFO, logger="hads.access"):
        r = client.get("/api/health", headers={"X-Request-ID": "abc-123"})
    assert r.headers["X-Request-ID"] == "abc-123"
    rec = next(x for x in caplog.records if x.name == "hads.access")
    line = json.loads(JsonFormatter().format(rec))
    assert line["request_id"] == "abc-123" and line["status"] == 200 and line["path"] == "/api/health"
    assert line["method"] == "GET" and isinstance(line["ms"], (int, float)) and line["level"] == "INFO"


def test_request_id_generated_when_absent(client):
    rid = client.get("/api/health").headers["X-Request-ID"]
    assert len(rid) >= 16
    assert client.get("/api/health").headers["X-Request-ID"] != rid


def test_supplied_request_id_is_sanitised(client):
    rid = client.get("/api/health", headers={"X-Request-ID": "bad id\nwith newline" + "x" * 200}).headers["X-Request-ID"]
    assert "\n" not in rid and " " not in rid and len(rid) <= 64


def test_ready_tracks_the_ack_timeout_heartbeat(client, beats):
    assert client.get("/api/ready").status_code == 503          # worker never started
    beats["ack_timeout"] = time.monotonic()
    assert client.get("/api/ready").status_code == 200
    beats["ack_timeout"] = time.monotonic() - 30
    r = client.get("/api/ready")
    assert r.status_code == 503 and "ack_timeout" in r.json()["detail"]


def test_health_degraded_when_a_worker_is_stale(client, beats):
    beats["ack_timeout"] = time.monotonic()
    beats["retention"] = time.monotonic()
    j = client.get("/api/health").json()
    assert j["status"] == "ok" and j["db"] is True and set(j["workers"]) == {"ack_timeout", "retention"}
    beats["ack_timeout"] = time.monotonic() - 30
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "degraded"


def test_admin_system_status(client, world):
    admin = world.user(Role.admin)
    with SessionLocal() as db:
        for ms in range(10, 201, 10):   # 20 requests: 10..200 ms
            db.add(EmergencyRequest(lat=13.08, lng=80.27, match_duration_ms=ms))
        db.add(EmergencyRequest(lat=13.08, lng=80.27, match_duration_ms=99999, created_at=utcnow() - timedelta(days=2)))
        db.commit()
    j = client.get("/api/admin/system", headers=admin["h"]).json()
    assert j["dispatch_p50_ms"] == 105.0 and j["dispatch_p95_ms"] == 190.5
    assert j["dispatch_within_target_pct"] == 100.0
    assert j["audit_chain"]["ok"] is True and j["db_dialect"] == "sqlite"
    assert {"version", "mae", "r2", "senior_demand_ratio"} <= set(j["model"]) and "gps_rows" in j and "workers" in j
    assert client.get("/api/admin/system", headers=world.user(Role.controller)["h"]).status_code == 403


def test_retention_loop_starts_without_demo_autopilot():
    async def go():
        tasks = background.start_background()
        names = {t.get_name() for t in tasks}
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        return names
    names = asyncio.run(go())
    assert "hads-retention" in names and "hads-demo-autopilot" not in names


def test_workers_beat_each_iteration(beats, monkeypatch):
    from app.services import dispatch
    monkeypatch.setattr(dispatch, "expire_stale_offers", lambda: None)
    monkeypatch.setattr(dispatch, "retry_escalated", lambda: None)
    monkeypatch.setattr(background, "run_retention_once", lambda now=None: {})

    async def go():
        tasks = [asyncio.create_task(background.ack_timeout_loop(0.01)),
                 asyncio.create_task(background.retention_loop(0.01))]
        await asyncio.sleep(0.1)
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    asyncio.run(go())
    assert {"ack_timeout", "retention"} <= set(beats)


def test_admission_control_caps_in_flight_requests():
    """At most `limit` HTTP requests run at once; the rest wait before they touch the database (an SOS burst can then
    never hold every pool connection while waiting for worker threads). Probes are never queued."""
    import httpx

    from app.middleware import ConcurrencyLimitMiddleware
    state = {"now": 0, "max": 0}

    async def slow_app(scope, receive, send):
        state["now"] += 1
        state["max"] = max(state["max"], state["now"])
        await asyncio.sleep(0.05)
        state["now"] -= 1
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    app = ConcurrencyLimitMiddleware(slow_app, limit=3)

    async def go():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
            rs = await asyncio.gather(*(c.get("/api/requests/1") for _ in range(12)))
            assert all(r.status_code == 200 for r in rs)
            assert state["max"] == 3
            state["max"] = 0
            await asyncio.gather(*(c.get("/api/ready") for _ in range(6)))   # probes bypass the queue
            assert state["max"] == 6
    asyncio.run(go())
