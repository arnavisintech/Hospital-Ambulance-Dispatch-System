from app.models import AuditLog, Role
from app.db import SessionLocal
from sqlalchemy import select


def test_register_login_me(client):
    r = client.post("/api/auth/register", json={"consent": True, "name": "Asha", "email": "Asha@Example.com", "password": "Secret@123"})
    assert r.status_code == 201
    body = r.json()
    assert body["user"]["role"] == "requester" and body["user"]["email"] == "asha@example.com"
    me = client.get("/api/auth/me", headers={"Authorization": "Bearer " + body["token"]})
    assert me.status_code == 200 and me.json()["id"] == body["user"]["id"]
    ok = client.post("/api/auth/login", json={"identifier": "asha@example.com", "password": "Secret@123"})
    assert ok.status_code == 200 and ok.json()["token"]


def test_login_by_phone_and_bad_password(client):
    client.post("/api/auth/register", json={"consent": True, "name": "B", "phone": "+919876543210", "password": "Secret@123"})
    assert client.post("/api/auth/login", json={"identifier": "+919876543210", "password": "Secret@123"}).status_code == 200
    assert client.post("/api/auth/login", json={"identifier": "+919876543210", "password": "wrong-pass"}).status_code == 401
    assert client.post("/api/auth/login", json={"identifier": "nobody@x.com", "password": "whatever1"}).status_code == 401


def test_only_requester_self_registers(client):
    r = client.post("/api/auth/register", json={"consent": True, "name": "X", "email": "x@x.com", "password": "Secret@123", "role": "admin"})
    assert r.status_code == 403


def test_duplicate_and_validation(client):
    p = {"consent": True, "name": "A", "email": "a@x.com", "password": "Secret@123"}
    assert client.post("/api/auth/register", json=p).status_code == 201
    assert client.post("/api/auth/register", json=p).status_code == 409
    assert client.post("/api/auth/register", json={"consent": True, "name": "A", "password": "Secret@123"}).status_code == 422
    assert client.post("/api/auth/register", json={**p, "email": "b@x.com", "password": "short"}).status_code == 422


def test_guest_sos(client):
    r = client.post("/api/auth/guest", json={"name": "Passer-by", "phone": "9876500000"})
    assert r.status_code == 201 and r.json()["user"]["role"] == "requester"
    r2 = client.post("/api/auth/guest")  # no body at all
    assert r2.status_code == 201 and r2.json()["user"]["name"] == "Guest"
    # same phone again must not hijack/fail
    assert client.post("/api/auth/guest", json={"phone": "9876500000"}).status_code == 201


def test_me_requires_token_and_me_for_staff_ids(client, world):
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer junk"}).status_code == 401
    b = world.basic()
    staff = world.user(Role.hospital_staff, hospital_id=b["hospital"])
    amb = world.ambulance(b["station"])
    crew = world.crew(amb)
    assert client.get("/api/auth/me", headers=staff["h"]).json()["hospital_id"] == b["hospital"]
    assert client.get("/api/auth/me", headers=crew["h"]).json()["ambulance_id"] == amb


def test_password_never_audited(client):
    client.post("/api/auth/register", json={"consent": True, "name": "A", "email": "a@x.com", "password": "Sup3rSecret!"})
    client.post("/api/auth/login", json={"identifier": "a@x.com", "password": "Sup3rSecret!"})
    with SessionLocal() as db:
        rows = db.execute(select(AuditLog)).scalars().all()
    assert rows and all("Sup3rSecret" not in str(r.details) for r in rows)
