"""Demo mode (Task 31): one working demo login per role, advertised only when demo mode is on."""
import pytest
from fastapi.testclient import TestClient

from app.config import Settings, get_settings
from app.main import app

ROLES = {"requester", "crew", "hospital_staff", "controller", "admin", "authority"}


@pytest.fixture
def demo(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "demo_mode", True)
    with TestClient(app) as c:  # lifespan seeds the empty DB
        yield c


def test_every_demo_account_logs_in_with_its_role(demo):
    cfg = demo.get("/api/public/config").json()
    assert cfg["demo_mode"] is True and cfg["demo_password"]
    accounts = cfg["demo_accounts"]
    assert {a["role"] for a in accounts} == ROLES and len(accounts) == len(ROLES)
    for a in accounts:
        r = demo.post("/api/auth/login", json={"identifier": a["email"], "password": cfg["demo_password"]})
        assert r.status_code == 200, a
        me = demo.get("/api/auth/me", headers={"Authorization": "Bearer " + r.json()["token"]}).json()
        assert me["role"] == a["role"]
        if a["role"] == "crew":
            assert me["ambulance_id"]
        if a["role"] == "hospital_staff":
            assert me["hospital_id"]
        assert a["label"] and a["hint"]


def test_config_hides_demo_data_outside_demo_mode(client):
    cfg = client.get("/api/public/config").json()
    assert cfg == {"demo_mode": False, "demo_password": None, "demo_accounts": []}


def test_app_env_demo_enables_demo_mode():
    assert Settings(_env_file=None, app_env="demo").is_demo
    assert not Settings(_env_file=None, app_env="development").is_demo


def test_demo_mode_is_a_production_problem():
    s = Settings(_env_file=None, app_env="production", jwt_secret="x" * 48, cors_origins="https://a.b",
                 data_encryption_key="k", demo_mode=True)
    assert any("DEMO_MODE" in p for p in s.production_problems())
