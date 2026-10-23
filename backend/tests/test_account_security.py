"""Token versioning, password change and admin reset (Task 5)."""
import pytest

from app import bootstrap
from app.config import get_settings
from app.db import SessionLocal
from app.models import Role


def _me(client, token):
    return client.get("/api/auth/me", headers={"Authorization": "Bearer " + token})


def test_password_change_revokes_old_token(client, world):
    u = world.user(Role.requester)
    r = client.post("/api/auth/password", json={"current_password": world.password, "new_password": "brand-new-pass"},
                    headers=u["h"])
    assert r.status_code == 200
    assert _me(client, u["token"]).status_code == 401
    assert _me(client, r.json()["token"]).status_code == 200
    assert client.post("/api/auth/login", json={"identifier": u["email"], "password": "brand-new-pass"}).status_code == 200


def test_password_change_rejects_wrong_current_and_short_new(client, world):
    u = world.user(Role.requester)
    assert client.post("/api/auth/password", json={"current_password": "nope-nope", "new_password": "brand-new-pass"},
                       headers=u["h"]).status_code == 400
    assert client.post("/api/auth/password", json={"current_password": world.password, "new_password": "short"},
                       headers=u["h"]).status_code == 422


def test_admin_reset_issues_temp_password_and_forces_change(client, world):
    admin, u = world.user(Role.admin), world.user(Role.crew)
    r = client.post(f"/api/admin/users/{u['id']}/reset-password", headers=admin["h"])
    assert r.status_code == 200
    temp = r.json()["temporary_password"]
    assert len(temp) >= 12
    assert _me(client, u["token"]).status_code == 401
    lg = client.post("/api/auth/login", json={"identifier": u["email"], "password": temp})
    assert lg.status_code == 200 and lg.json()["user"]["must_change_password"] is True
    ch = client.post("/api/auth/password", json={"current_password": temp, "new_password": "my-own-pass-1"},
                     headers={"Authorization": "Bearer " + lg.json()["token"]})
    assert ch.json()["user"]["must_change_password"] is False


def test_reset_requires_admin(client, world):
    ctl, u = world.user(Role.controller), world.user(Role.requester)
    assert client.post(f"/api/admin/users/{u['id']}/reset-password", headers=ctl["h"]).status_code == 403


def test_deactivation_revokes_token_even_after_reactivation(client, world):
    admin, u = world.user(Role.admin), world.user(Role.requester)
    assert client.patch(f"/api/admin/users/{u['id']}", json={"is_active": False}, headers=admin["h"]).status_code == 200
    assert client.patch(f"/api/admin/users/{u['id']}", json={"is_active": True}, headers=admin["h"]).status_code == 200
    assert _me(client, u["token"]).status_code == 401


def test_bootstrap_admin_must_change_password(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "bootstrap_admin_email", "root@hads.test")
    monkeypatch.setattr(s, "bootstrap_admin_password", "Very-Strong-Pass-123")
    with SessionLocal() as db:
        assert bootstrap.ensure_bootstrap_admin(db).must_change_password is True


@pytest.mark.parametrize("payload", [{"sub": "1", "role": "admin"}])
def test_legacy_token_without_version_still_valid(client, world, payload):
    import jwt
    u = world.user(Role.requester)
    tok = jwt.encode({**payload, "sub": str(u["id"]), "role": "requester", "exp": 9999999999},
                     get_settings().jwt_secret, algorithm="HS256")
    assert _me(client, tok).status_code == 200
