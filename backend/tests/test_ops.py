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


def _ok_app(state, gate=None):
    async def app(scope, receive, send):
        body = b""
        while True:
            m = await receive()
            body += m.get("body", b"")
            if not m.get("more_body"):
                break
        state["bodies"].append(body)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        if gate is not None:
            await gate.wait()                       # a client that is slow to read the response
        await send({"type": "http.response.body", "body": b"ok"})
    return app


def test_admission_slot_not_held_by_a_slow_uploader():
    """Security review: the request body is read before a slot is taken, so trickling a body cannot starve SOS calls."""
    from app.middleware import ConcurrencyLimitMiddleware

    async def go():
        state = {"bodies": []}
        mw = ConcurrencyLimitMiddleware(_ok_app(state), limit=1)
        slow_more = asyncio.Event()
        sent = []

        async def slow_receive():
            if not sent:
                sent.append(1)
                return {"type": "http.request", "body": b"part1", "more_body": True}
            await slow_more.wait()
            return {"type": "http.request", "body": b"part2", "more_body": False}

        async def fast_receive():
            return {"type": "http.request", "body": b"sos", "more_body": False}

        async def send(_m):
            pass
        scope = {"type": "http", "path": "/api/requests", "method": "POST", "headers": []}
        slow = asyncio.create_task(mw(scope, slow_receive, send))
        await asyncio.sleep(0.01)
        await asyncio.wait_for(mw(dict(scope), fast_receive, send), 1)   # completes while the slow body is pending
        assert state["bodies"] == [b"sos"]
        slow_more.set()
        await slow
        assert state["bodies"] == [b"sos", b"part1part2"]
    asyncio.run(go())


def test_admission_slot_released_when_the_response_starts():
    from app.middleware import ConcurrencyLimitMiddleware

    async def go():
        state = {"bodies": []}
        gate = asyncio.Event()
        mw = ConcurrencyLimitMiddleware(_ok_app(state, gate), limit=1)

        async def receive():
            return {"type": "http.request", "body": b"x", "more_body": False}

        async def send(_m):
            pass
        scope = {"type": "http", "path": "/api/requests/1", "method": "GET", "headers": []}
        first = asyncio.create_task(mw(scope, receive, send))
        await asyncio.sleep(0.01)                     # first response started, its body is held back by a slow reader
        second = asyncio.create_task(mw(dict(scope), receive, send))
        await asyncio.sleep(0.05)
        assert len(state["bodies"]) == 2              # the second request ran without waiting for the first to finish
        gate.set()
        await asyncio.gather(first, second)
    asyncio.run(go())


def test_admission_queue_wait_is_bounded_with_503():
    from app.middleware import ConcurrencyLimitMiddleware

    async def go():
        hold = asyncio.Event()

        async def stuck(scope, receive, send):
            await hold.wait()

        mw = ConcurrencyLimitMiddleware(stuck, limit=1, wait_s=0.05)
        sent = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(m):
            sent.append(m)
        scope = {"type": "http", "path": "/api/requests", "method": "POST", "headers": []}
        first = asyncio.create_task(mw(scope, receive, send))
        await asyncio.sleep(0.01)
        await mw(dict(scope), receive, send)
        start = next(m for m in sent if m["type"] == "http.response.start")
        assert start["status"] == 503 and (b"retry-after", b"2") in start["headers"]
        hold.set()
        await first
    asyncio.run(go())


def _status(sent):
    return next(m for m in sent if m["type"] == "http.response.start")["status"]


def test_admission_rejects_oversized_bodies_by_route():
    """JSON API bodies are small; only the demographics upload may be large. Content-Length is checked before reading."""
    from app.middleware import ConcurrencyLimitMiddleware

    async def go():
        state = {"bodies": []}
        mw = ConcurrencyLimitMiddleware(_ok_app(state), limit=4)

        async def run(path, size, declared=None):
            sent, reads = [], []
            body = b"x" * size

            async def receive():
                reads.append(1)
                return {"type": "http.request", "body": body, "more_body": False}

            async def send(m):
                sent.append(m)
            headers = [(b"content-length", str(declared if declared is not None else size).encode())]
            await mw({"type": "http", "path": path, "method": "POST", "headers": headers}, receive, send)
            return _status(sent), len(reads)

        assert (await run("/api/requests", 300 * 1024))[0] == 413                 # JSON route: 256 KiB cap
        assert await run("/api/requests", 10, declared=50 * 1024 * 1024) == (413, 0)   # refused before reading
        assert (await run("/api/admin/demographics/import", 1024 * 1024))[0] == 200   # upload route: 6 MB cap
        assert (await run("/api/admin/demographics/import", 7 * 1024 * 1024))[0] == 413
    asyncio.run(go())


def test_admission_caps_total_buffered_bytes():
    """Many large bodies at once cannot exhaust memory: past the aggregate budget the caller gets 503 + Retry-After."""
    from app.middleware import ConcurrencyLimitMiddleware

    async def go():
        state = {"bodies": []}
        mw = ConcurrencyLimitMiddleware(_ok_app(state), limit=4, upload_budget=1024 * 1024)
        release = asyncio.Event()
        sent_a, sent_b = [], []

        async def slow_receive():
            if not hasattr(slow_receive, "n"):
                slow_receive.n = 1
                return {"type": "http.request", "body": b"a" * 900 * 1024, "more_body": True}
            await release.wait()
            return {"type": "http.request", "body": b"", "more_body": False}

        async def big_receive():
            return {"type": "http.request", "body": b"b" * 500 * 1024, "more_body": False}

        async def send_a(m):
            sent_a.append(m)

        async def send_b(m):
            sent_b.append(m)
        scope = {"type": "http", "path": "/api/admin/demographics/import", "method": "POST", "headers": []}
        a = asyncio.create_task(mw(scope, slow_receive, send_a))
        await asyncio.sleep(0.01)
        await mw(dict(scope), big_receive, send_b)                 # would take the total past 1 MiB
        assert _status(sent_b) == 503
        release.set()
        await a
        assert _status(sent_a) == 200
    asyncio.run(go())


def test_upload_route_cannot_use_up_the_json_budget():
    """Security review: unauthenticated callers could fill the shared buffer budget via the large-upload route and
    starve SOS calls. Uploads have their own budget; JSON requests still get through."""
    from app.middleware import ConcurrencyLimitMiddleware

    async def go():
        state = {"bodies": []}
        mw = ConcurrencyLimitMiddleware(_ok_app(state), limit=4, buffer_budget=1024 * 1024, upload_budget=1024 * 1024)
        hold = asyncio.Event()

        def slow_upload():
            first = []

            async def receive():
                if not first:
                    first.append(1)
                    return {"type": "http.request", "body": b"u" * 600 * 1024, "more_body": True}
                await hold.wait()
                return {"type": "http.request", "body": b"", "more_body": False}
            return receive

        async def send(_m):
            pass
        up = {"type": "http", "path": "/api/admin/demographics/import", "method": "POST", "headers": []}
        uploads = [asyncio.create_task(mw(dict(up), slow_upload(), send)) for _ in range(3)]   # 1.8 MiB > upload budget
        await asyncio.sleep(0.02)
        sent = []

        async def send_json(m):
            sent.append(m)

        async def json_receive():
            return {"type": "http.request", "body": b"j" * 200 * 1024, "more_body": False}
        await mw({"type": "http", "path": "/api/requests", "method": "POST", "headers": []}, json_receive, send_json)
        assert _status(sent) == 200                       # the SOS path is unaffected by the upload pressure
        hold.set()
        await asyncio.gather(*uploads)
    asyncio.run(go())
