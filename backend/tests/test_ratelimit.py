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
    for i in range(10):
        assert client.post("/api/auth/guest", json={}).status_code == 201
    assert client.post("/api/auth/guest", json={}).status_code == 429
    r = client.post("/api/auth/register", json={"consent": True, "name": "X", "email": "x@hads.test", "password": "password123"})
    assert r.status_code == 429


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
