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


def test_demo_lists_a_login_for_every_hospital_and_ambulance(demo):
    """Demo walk-through: dispatch picks the best hospital and ambulance, but the Hospital and Crew demo cards were
    fixed to staff1 / crew1, so the presenter could not open the hospital (or crew) a trip was actually sent to and
    complete the handover. Demo mode now offers one login per hospital and per ambulance."""
    from app.db import SessionLocal
    from app.models import Ambulance, Hospital
    cfg = demo.get("/api/public/config").json()
    choices = cfg["demo_choices"]
    with SessionLocal() as db:
        n_hosp = db.query(Hospital).count()
        n_amb = db.query(Ambulance).count()
        hospital_names = {h.id: h.name for h in db.query(Hospital)}
        regs = {a.id: a.registration_number for a in db.query(Ambulance)}
    assert len(choices["hospital_staff"]) == n_hosp and len(choices["crew"]) == n_amb
    for role, key, names in (("hospital_staff", "hospital_id", hospital_names), ("crew", "ambulance_id", regs)):
        for c in choices[role][:3] + choices[role][-1:]:
            tok = demo.post("/api/auth/login", json={"identifier": c["email"], "password": cfg["demo_password"]}).json()["token"]
            me = demo.get("/api/auth/me", headers={"Authorization": "Bearer " + tok}).json()
            assert me["role"] == role and names[me[key]] in c["label"], c   # the label names what you sign in to


def test_demo_choices_never_list_accounts_an_admin_created(demo):
    from app.db import SessionLocal
    from app.models import Hospital, HospitalStaffProfile, Role, User
    from app.security import hash_password
    with SessionLocal() as db:
        h = db.query(Hospital).first()
        u = User(name="Real Person", email="real.person@hospital.example", role=Role.hospital_staff,
                 password_hash=hash_password("not-the-demo-password"), is_active=True)
        db.add(u)
        db.flush()
        db.add(HospitalStaffProfile(user_id=u.id, hospital_id=h.id))
        db.commit()
    emails = [c["email"] for c in demo.get("/api/public/config").json()["demo_choices"]["hospital_staff"]]
    assert "real.person@hospital.example" not in emails
