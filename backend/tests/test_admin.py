import pytest
from sqlalchemy import select

from ops_helpers import Env
from app.models import Ambulance, CrewProfile, HospitalStaffProfile, User
from app.security import verify_password


@pytest.fixture(scope="module")
def env():
    return Env()


def H(env):
    return env.as_("admin@hads.in")


def test_all_admin_routes_role_guarded(env):
    c = env.client
    calls = [("get", "/api/admin/hospitals"), ("get", "/api/admin/stations"), ("get", "/api/admin/users"),
             ("get", "/api/admin/settings"), ("put", "/api/admin/settings"), ("post", "/api/admin/users"),
             ("post", "/api/admin/hospitals"), ("patch", "/api/admin/users/1"), ("patch", "/api/admin/stations/1"),
             ("post", "/api/admin/stations/1/ambulances"), ("post", "/api/admin/stations/1/ambulances/bulk")]
    for who in ("controller@hads.in", "user@hads.in", "authority@hads.in", "crew1@hads.in"):
        for m, url in calls:
            assert c.request(m, url, headers=env.as_(who), json={}).status_code == 403, (who, m, url)
    for m, url in calls:
        assert c.request(m, url, json={}).status_code == 401


def test_hospital_station_fleet_onboarding(env):
    c, h = env.client, H(env)
    body = {"name": "Test Care Hospital", "address": "OMR", "lat": 12.95, "lng": 80.24, "total_beds": 50, "total_icu": 8,
            "specialists": {"cardiology": 1}, "revenue_share_pct": 65}
    r = c.post("/api/admin/hospitals", json=body, headers=h)
    assert r.status_code == 201
    hid = r.json()["id"]
    assert r.json()["available_beds"] == 50 and r.json()["revenue_share_pct"] == 65
    assert c.post("/api/admin/hospitals", json=body, headers=h).status_code == 409                  # unique name
    assert c.post("/api/admin/hospitals", json={**body, "name": "Bad", "lat": 99}, headers=h).status_code == 422
    assert c.post("/api/admin/hospitals", json={**body, "name": "Bad2", "revenue_share_pct": 120}, headers=h).status_code == 422
    assert any(x["id"] == hid for x in c.get("/api/admin/hospitals", headers=h).json())

    r = c.post(f"/api/admin/hospitals/{hid}/stations", json={"name": "OMR Dark Station", "lat": 12.95, "lng": 80.24}, headers=h)
    assert r.status_code == 201
    sid = r.json()["id"]
    assert c.post("/api/admin/hospitals/9999/stations", json={"name": "Nope", "lat": 1, "lng": 1}, headers=h).status_code == 404

    r = c.post(f"/api/admin/stations/{sid}/ambulances", json={"registration_number": "TN-1", "kind": "als"}, headers=h)
    assert r.status_code == 422                                   # too short
    r = c.post(f"/api/admin/stations/{sid}/ambulances", json={"registration_number": "tn-09-zz-1001", "kind": "als"}, headers=h)
    assert r.status_code == 201 and r.json()["registration_number"] == "TN-09-ZZ-1001" and r.json()["kind"] == "ALS"
    assert c.post(f"/api/admin/stations/{sid}/ambulances", json={"registration_number": "TN-09-ZZ-1001"}, headers=h).status_code == 409
    bulk = {"ambulances": [{"registration_number": f"TN-09-ZZ-20{i:02d}", "kind": "BLS"} for i in range(5)]}
    r = c.post(f"/api/admin/stations/{sid}/ambulances/bulk", json=bulk, headers=h)
    assert r.status_code == 201 and r.json()["created"] == 5
    # atomic: one clash => nothing created
    bad = {"ambulances": [{"registration_number": "TN-09-ZZ-3001"}, {"registration_number": "TN-09-ZZ-1001"}]}
    assert c.post(f"/api/admin/stations/{sid}/ambulances/bulk", json=bad, headers=h).status_code == 409
    dup = {"ambulances": [{"registration_number": "TN-09-ZZ-3002"}, {"registration_number": "tn-09-zz-3002"}]}
    assert c.post(f"/api/admin/stations/{sid}/ambulances/bulk", json=dup, headers=h).status_code == 409
    with env.db() as db:
        regs = set(db.execute(select(Ambulance.registration_number)).scalars())
        assert "TN-09-ZZ-3001" not in regs and "TN-09-ZZ-3002" not in regs
    # plain list form also accepted
    r = c.post(f"/api/admin/stations/{sid}/ambulances/bulk", json=[{"registration_number": "TN-09-ZZ-4001", "kind": "BLS"}], headers=h)
    assert r.status_code == 201

    st = [s for s in c.get("/api/admin/stations", headers=h).json() if s["id"] == sid][0]
    assert st["ambulances"] == 7 and st["available"] == 7 and st["is_active"]
    r = c.patch(f"/api/admin/stations/{sid}", json={"is_active": False}, headers=h)
    assert r.status_code == 200 and r.json()["is_active"] is False
    assert c.patch(f"/api/admin/stations/{sid}", json={}, headers=h).status_code == 422
    assert c.patch("/api/admin/stations/9999", json={"is_active": True}, headers=h).status_code == 404


def test_user_management_profiles(env):
    c, h = env.client, H(env)
    with env.db() as db:
        taken = select(CrewProfile.ambulance_id).where(CrewProfile.ambulance_id.is_not(None))
        free_amb = db.execute(select(Ambulance.id).where(Ambulance.id.not_in(taken))).scalars().first()
    base = {"name": "New Crew", "email": "newcrew@hads.in", "phone": "9876543210", "password": "Secret@123", "role": "crew",
            "ambulance_id": free_amb, "license_number": "TN-DL-9"}
    r = c.post("/api/admin/users", json=base, headers=h)
    assert r.status_code == 201 and r.json()["ambulance_id"] == free_amb and "password_hash" not in r.json()
    with env.db() as db:
        u = db.execute(select(User).where(User.email == "newcrew@hads.in")).scalar_one()
        assert verify_password("Secret@123", u.password_hash) and db.get(CrewProfile, u.id).license_number == "TN-DL-9"
    assert c.post("/api/admin/users", json=base, headers=h).status_code == 409                    # email
    assert c.post("/api/admin/users", json={**base, "email": "x2@hads.in", "phone": "9876543210"}, headers=h).status_code == 409
    assert c.post("/api/admin/users", json={**base, "email": "x3@hads.in", "phone": None}, headers=h).status_code == 409  # amb taken
    assert c.post("/api/admin/users", json={**base, "email": "x4@hads.in", "phone": None, "ambulance_id": None,
                                           "license_number": None}, headers=h).status_code == 422
    assert c.post("/api/admin/users", json={**base, "email": "x5@hads.in", "password": "short"}, headers=h).status_code == 422
    assert c.post("/api/admin/users", json={**base, "email": "notanemail"}, headers=h).status_code == 422
    assert c.post("/api/admin/users", json={"name": "Staff", "email": "st@hads.in", "password": "Secret@123",
                                           "role": "hospital_staff"}, headers=h).status_code == 422   # needs hospital
    r = c.post("/api/admin/users", json={"name": "Staff", "email": "st@hads.in", "password": "Secret@123",
                                        "role": "hospital_staff", "hospital_id": 2}, headers=h)
    assert r.status_code == 201 and r.json()["hospital_id"] == 2
    with env.db() as db:
        assert db.get(HospitalStaffProfile, r.json()["id"]).hospital_id == 2
    uid = r.json()["id"]
    assert c.get("/api/admin/users?role=hospital_staff&q=st@", headers=h).json()[0]["id"] == uid
    assert c.patch(f"/api/admin/users/{uid}", json={"is_active": False}, headers=h).json()["is_active"] is False
    me = c.get("/api/admin/users?q=admin@hads.in", headers=h).json()[0]["id"]
    assert c.patch(f"/api/admin/users/{me}", json={"is_active": False}, headers=h).status_code == 409
    assert c.patch("/api/admin/users/99999", json={"is_active": False}, headers=h).status_code == 404


def test_settings_get_put_validation(env):
    c, h = env.client, H(env)
    s = c.get("/api/admin/settings", headers=h).json()
    for k in ("revenue_share_pct", "base_fare", "per_km_rate", "als_surcharge", "crew_ack_timeout_s"):
        assert k in s
    assert s["revenue_share_pct"] == 70
    r = c.put("/api/admin/settings", json={"base_fare": 650.5, "crew_ack_timeout_s": 45}, headers=h)
    assert r.status_code == 200 and r.json()["base_fare"] == 650.5 and r.json()["crew_ack_timeout_s"] == 45
    assert c.get("/api/admin/settings", headers=h).json()["base_fare"] == 650.5
    assert c.put("/api/admin/settings", json={"settings": {"per_km_rate": 30}}, headers=h).json()["per_km_rate"] == 30
    for bad in ({"revenue_share_pct": 101}, {"base_fare": -1}, {"crew_ack_timeout_s": 1}, {"crew_ack_timeout_s": 10.5},
                {"bogus": 1}, {"base_fare": "high"}, {"base_fare": True}, {}):
        assert c.put("/api/admin/settings", json=bad, headers=h).status_code == 422, bad
    # failed PUT must not partially apply
    assert c.put("/api/admin/settings", json={"base_fare": 111, "revenue_share_pct": 500}, headers=h).status_code == 422
    assert c.get("/api/admin/settings", headers=h).json()["base_fare"] == 650.5


def test_admin_mutations_audited(env):
    c = env.client
    r = c.get("/api/audit?action=admin.&limit=500", headers=H(env)).json()
    actions = {i["action"] for i in r["items"]}
    assert {"admin.hospital.create", "admin.station.create", "admin.ambulance.register", "admin.ambulance.bulk_register",
            "admin.user.create", "admin.settings.update", "admin.station.update", "admin.user.update"} <= actions
