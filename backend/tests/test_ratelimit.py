"""Rate limits and login lockout (Task 4). Emergency intake must never be throttled for controllers or retries."""
import uuid

from app.models import Role
from app.ratelimit import RateLimiter
from conftest import PATIENT, sos


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def test_limiter_allows_up_to_limit_then_denies():
    clk = FakeClock()
    rl = RateLimiter(3, 60, clock=clk)
    assert [rl.hit("k")[0] for _ in range(3)] == [True, True, True]
    ok, retry = rl.hit("k")
    assert ok is False and 0 < retry <= 60


def test_limiter_window_expires_and_keys_are_independent():
    clk = FakeClock()
    rl = RateLimiter(1, 60, clock=clk)
    assert rl.hit("a")[0] and not rl.hit("a")[0]
    assert rl.hit("b")[0]
    clk.t += 61
    assert rl.hit("a")[0]
    rl.reset("a")
    assert rl.hit("a")[0]


def _login(client, ident, pw):
    return client.post("/api/auth/login", json={"identifier": ident, "password": pw})


def test_login_lockout_after_five_failures(client, world):
    u = world.user(Role.requester)
    for _ in range(5):
        assert _login(client, u["email"], "wrong-password").status_code == 401
    r = _login(client, u["email"], world.password)
    assert r.status_code == 429 and int(r.headers["Retry-After"]) > 0


def test_successful_login_resets_failure_counter(client, world):
    u = world.user(Role.requester)
    for _ in range(4):
        _login(client, u["email"], "wrong-password")
    assert _login(client, u["email"], world.password).status_code == 200
    for _ in range(4):
        assert _login(client, u["email"], "wrong-password").status_code == 401


def test_signup_limited_per_ip(client):
    """Account registration stays limited per IP; the guest SOS path has only a separate flood guard."""
    for i in range(10):
        r = client.post("/api/auth/register", json={"consent": True, "name": f"X{i}", "email": f"x{i}@hads.test",
                                                    "password": "password123"})
        assert r.status_code == 201
    r = client.post("/api/auth/register", json={"consent": True, "name": "Y", "email": "y@hads.test", "password": "password123"})
    assert r.status_code == 429
    assert client.post("/api/auth/guest", json={}).status_code == 201       # SOS is not charged against sign-ups


def test_guest_flood_guard_exists(client, monkeypatch):
    from app import ratelimit
    monkeypatch.setattr(ratelimit.limiter("guest", 600, 3600), "limit", 3)
    assert [client.post("/api/auth/guest", json={}).status_code for _ in range(4)] == [201, 201, 201, 429]


def test_controller_ivr_burst_never_limited(client, world):
    ctl = world.user(Role.controller)
    body = {"lat": PATIENT[0], "lng": PATIENT[1], "incident_type": "other", "severity": 3}
    codes = {client.post("/api/requests/ivr", json=body, headers=ctl["h"]).status_code for _ in range(30)}
    assert codes == {201}


def test_requester_sos_burst_and_retries_pass(client, world):
    u = world.user(Role.requester)
    assert {sos(client, u["h"]).status_code for _ in range(5)} == {201}
    cu = str(uuid.uuid4())
    codes = [sos(client, u["h"], client_uuid=cu).status_code for _ in range(10)]
    assert codes[0] == 201 and set(codes[1:]) == {200}


def test_requester_sos_flood_is_limited(client, world):
    u = world.user(Role.requester)
    codes = [sos(client, u["h"]).status_code for _ in range(21)]
    assert codes[:20] == [201] * 20 and codes[20] == 429


def test_guest_sos_is_not_capped_like_signups_behind_shared_ips(client):
    """Final review: mobile carriers put thousands of phones behind one IP (CGNAT). Thirty strangers raising a guest
    SOS from the same address in an hour must all get through (only a flood guard applies)."""
    import uuid
    codes = [client.post("/api/auth/guest", json={"device_id": str(uuid.uuid4())}).status_code for _ in range(30)]
    assert codes == [201] * 30


def test_guest_creation_is_idempotent_per_device(client):
    """A lost response retried from the same phone returns the same guest instead of creating (and counting) another."""
    import uuid

    from app.db import SessionLocal
    from app.models import User
    device = str(uuid.uuid4())
    a = client.post("/api/auth/guest", json={"device_id": device})
    b = client.post("/api/auth/guest", json={"device_id": device})
    assert a.status_code == 201 and b.status_code == 200
    assert a.json()["user"]["id"] == b.json()["user"]["id"]
    with SessionLocal() as db:
        u = db.get(User, a.json()["user"]["id"])
        assert u.is_guest and u.guest_device_hash and device not in u.guest_device_hash   # stored hashed
    assert client.post("/api/auth/guest", json={"device_id": "short"}).status_code == 422  # must be a real random id


def test_erased_or_deactivated_guest_never_comes_back_through_the_device(client, world):
    """Security review: the device hash must not hand an erased or deactivated account back."""
    import uuid
    device = str(uuid.uuid4())
    first = client.post("/api/auth/guest", json={"device_id": device}).json()
    h = {"Authorization": f"Bearer {first['token']}"}
    assert client.request("DELETE", "/api/auth/me", json={}, headers=h).status_code == 200   # guests erase without a password
    again = client.post("/api/auth/guest", json={"device_id": device})
    assert again.status_code == 201 and again.json()["user"]["id"] != first["user"]["id"]
    admin = world.user(Role.admin)
    client.patch(f"/api/admin/users/{again.json()['user']['id']}", json={"is_active": False}, headers=admin["h"])
    third = client.post("/api/auth/guest", json={"device_id": device})
    assert third.status_code == 201 and third.json()["user"]["id"] != again.json()["user"]["id"]


def test_guest_retries_are_free_but_new_guests_are_counted(client, monkeypatch):
    import uuid

    from app import ratelimit
    monkeypatch.setattr(ratelimit.limiter("guest_new", 120, 3600), "limit", 2)
    d1 = str(uuid.uuid4())
    assert [client.post("/api/auth/guest", json={"device_id": d1}).status_code for _ in range(5)] == [201, 200, 200, 200, 200]
    assert client.post("/api/auth/guest", json={"device_id": str(uuid.uuid4())}).status_code == 201
    assert client.post("/api/auth/guest", json={"device_id": str(uuid.uuid4())}).status_code == 429


def test_guest_sos_flood_from_one_ip_is_capped(client, world, monkeypatch):
    """Guest accounts are cheap, so their SOS also share a per-IP cap (well above real emergency volume per address);
    registered requesters and controllers are unaffected."""
    import uuid

    from app import ratelimit
    monkeypatch.setattr(ratelimit.limiter("guest_sos_ip", 60, 3600), "limit", 3)
    body = {"lat": PATIENT[0], "lng": PATIENT[1], "severity": 3}
    codes = []
    for _ in range(4):
        tok = client.post("/api/auth/guest", json={"device_id": str(uuid.uuid4())}).json()["token"]
        codes.append(client.post("/api/requests", json=body, headers={"Authorization": f"Bearer {tok}"}).status_code)
    assert codes == [201, 201, 201, 429]
    assert client.post("/api/requests", json=body, headers=world.user()["h"]).status_code == 201


def test_device_id_is_only_a_short_lived_retry_key(client):
    """Security review: on a shared phone the next person must not inherit an old guest's account. The device id is
    honoured only within 10 minutes of the guest's creation (the retry window)."""
    import uuid
    from datetime import timedelta

    from app.db import SessionLocal
    from app.models import User, utcnow
    device = str(uuid.uuid4())
    first = client.post("/api/auth/guest", json={"device_id": device}).json()["user"]["id"]
    with SessionLocal() as db:
        db.get(User, first).created_at = utcnow() - timedelta(minutes=11)
        db.commit()
    later = client.post("/api/auth/guest", json={"device_id": device})
    assert later.status_code == 201 and later.json()["user"]["id"] != first
