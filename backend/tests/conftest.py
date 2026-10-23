"""Test harness: fresh SQLite database per test, TestClient, and direct-model factories (no seed.py)."""
import os
import tempfile
from datetime import timedelta

_TMP = tempfile.mkdtemp(prefix="hads-test-")
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/test.db"
os.environ["SEED_ON_STARTUP"] = "false"
os.environ["ROUTING_PROVIDER"] = "haversine"
os.environ["DEMO_AUTOPILOT"] = "false"
os.environ["GEO_PROVIDER"] = "offline"  # tests never touch the network

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import events  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import (Ambulance, AmbulanceStatus, CrewProfile, DarkStation, Hospital, HospitalStaffProfile,  # noqa: E402
                        Role, User, utcnow)
from app.security import create_token, hash_password  # noqa: E402

PATIENT = (13.0827, 80.2707)  # Chennai centre


@pytest.fixture(autouse=True)
def fresh_db():
    from app.services import crew_actions, geocode, legs, routing, trips
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    routing.reset()
    geocode.reset()
    legs.clear()
    crew_actions.forget_devices()
    trips._headings.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def published(monkeypatch):
    """Capture events.publish calls as (topic, type, data)."""
    calls = []
    monkeypatch.setattr(events, "publish", lambda topic, type_, data: calls.append((topic, type_, data)))
    return calls


class World:
    """Creates fixtures directly through the models."""
    password = "Hads@1234"

    def __init__(self):
        self._n = 0

    def _id(self):
        self._n += 1
        return self._n

    def user(self, role=Role.requester, name=None, hospital_id=None, ambulance_id=None, **kw):
        n = self._id()
        with SessionLocal() as db:
            u = User(name=name or f"{role.value}{n}", email=kw.get("email", f"{role.value}{n}@hads.test"),
                     phone=kw.get("phone"), password_hash=hash_password(self.password), role=role)
            db.add(u)
            db.flush()
            if hospital_id:
                db.add(HospitalStaffProfile(user_id=u.id, hospital_id=hospital_id))
            if role == Role.crew:
                db.add(CrewProfile(user_id=u.id, license_number=f"L{n}", ambulance_id=ambulance_id))
            db.commit()
            return {"id": u.id, "email": u.email, "token": create_token(u.id, u.role.value),
                    "h": {"Authorization": "Bearer " + create_token(u.id, u.role.value)}}

    def hospital(self, name=None, lat=13.09, lng=80.28, beds=10, icu=5, specialists=None, fresh=True, **kw):
        n = self._id()
        with SessionLocal() as db:
            h = Hospital(name=name or f"Hospital {n}", lat=lat, lng=lng, total_beds=20, available_beds=beds,
                         total_icu=10, available_icu=icu,
                         specialists=specialists if specialists is not None else
                         {"cardiology": 1, "neurology": 1, "trauma": 1, "obstetrics": 1},
                         capacity_updated_at=utcnow() if fresh else utcnow() - timedelta(hours=3), **kw)
            db.add(h)
            db.commit()
            return h.id

    def station(self, hospital_id, lat=13.08, lng=80.27):
        with SessionLocal() as db:
            s = DarkStation(hospital_id=hospital_id, name=f"Station {self._id()}", lat=lat, lng=lng)
            db.add(s)
            db.commit()
            return s.id

    def ambulance(self, station_id, lat=13.085, lng=80.275, kind="BLS", status=AmbulanceStatus.available,
                  staffed=True, fresh=True, gps=True):
        n = self._id()
        with SessionLocal() as db:
            a = Ambulance(station_id=station_id, registration_number=f"TN01AB{n:04d}", kind=kind, status=status,
                          staffed=staffed, lat=lat if gps else None, lng=lng if gps else None,
                          location_updated_at=(utcnow() if fresh else utcnow() - timedelta(hours=1)) if gps else None)
            db.add(a)
            db.commit()
            return a.id

    def crew(self, ambulance_id):
        return self.user(Role.crew, ambulance_id=ambulance_id)

    def basic(self):
        """One hospital (full specialties), one station, returns ids."""
        h = self.hospital()
        return {"hospital": h, "station": self.station(h)}


@pytest.fixture
def world():
    return World()


def sos(client, headers, **over):
    body = {"lat": PATIENT[0], "lng": PATIENT[1], "incident_type": "other", "severity": 3, **over}
    return client.post("/api/requests", json=body, headers=headers)


def db_get(model, pk):
    with SessionLocal() as db:
        return db.get(model, pk)
