"""Single-use websocket tickets (Task 6): no long-lived JWT in websocket URLs."""
import pytest
from starlette.websockets import WebSocketDisconnect

from app.db import SessionLocal
from app.models import Role, User
from app.routers import auth as auth_router


def _ticket(client, user):
    r = client.post("/api/auth/ws-ticket", headers=user["h"])
    assert r.status_code == 200 and r.json()["expires_in"] == 30
    return r.json()["ticket"]


def _closed_with(client, url) -> int:
    with pytest.raises(WebSocketDisconnect) as e:
        with client.websocket_connect(url) as ws:
            ws.receive_json()
    return e.value.code


def test_ticket_connects_once(client, world):
    ctl = world.user(Role.controller)
    t = _ticket(client, ctl)
    with client.websocket_connect(f"/api/ws?ticket={t}&topics=controller") as ws:
        assert ws.receive_json()["type"] == "subscribed"
    assert _closed_with(client, f"/api/ws?ticket={t}&topics=controller") == 4401


def test_expired_ticket_rejected(client, world, monkeypatch):
    ctl = world.user(Role.controller)
    t = _ticket(client, ctl)
    real = auth_router._now
    monkeypatch.setattr(auth_router, "_now", lambda: real() + 31)
    assert _closed_with(client, f"/api/ws?ticket={t}&topics=controller") == 4401


def test_ticket_dies_when_sessions_are_revoked(client, world):
    ctl = world.user(Role.controller)
    t = _ticket(client, ctl)
    with SessionLocal() as db:
        db.get(User, ctl["id"]).token_version += 1
        db.commit()
    assert _closed_with(client, f"/api/ws?ticket={t}&topics=controller") == 4401


def test_jwt_in_url_no_longer_authenticates(client, world):
    ctl = world.user(Role.controller)
    assert _closed_with(client, f"/api/ws?token={ctl['token']}&topics=controller") == 4401


def test_ticket_requires_authentication(client):
    assert client.post("/api/auth/ws-ticket").status_code == 401


@pytest.mark.parametrize("how", ["deactivate", "reset", "password", "erase"])
def test_revoking_sessions_closes_open_websockets(client, world, how):
    """Final review: deactivation, password reset/change and erasure revoke tokens; an already-open socket (live
    controller feed, a requester's trip) must be closed too, not keep streaming."""
    import time
    admin = world.user(Role.admin)
    victim = world.user(Role.controller if how in ("deactivate", "reset") else Role.requester)
    topic = "controller" if how in ("deactivate", "reset") else f"user:{victim['id']}"
    with client.websocket_connect(f"/api/ws?ticket={_ticket(client, victim)}&topics={topic}") as ws:
        assert ws.receive_json()["type"] == "subscribed"
        if how == "deactivate":
            client.patch(f"/api/admin/users/{victim['id']}", json={"is_active": False}, headers=admin["h"])
        elif how == "reset":
            client.post(f"/api/admin/users/{victim['id']}/reset-password", headers=admin["h"])
        elif how == "password":
            client.post("/api/auth/password", json={"current_password": world.password, "new_password": "brand-new-pass-1"},
                        headers=victim["h"])
        else:
            client.request("DELETE", "/api/auth/me", json={"password": world.password}, headers=victim["h"])
        with pytest.raises(WebSocketDisconnect) as e:
            deadline = time.time() + 5
            while time.time() < deadline:
                ws.receive_json()
        assert e.value.code == 4401
