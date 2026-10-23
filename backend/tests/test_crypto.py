"""Field-level encryption of patient PII at rest (Task 9, NFR3)."""
import pytest
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import text

from app import crypto
from app.config import get_settings
from app.db import SessionLocal
from app.models import EmergencyRequest, IncidentType

KEY_A, KEY_B, KEY_C = Fernet.generate_key().decode(), Fernet.generate_key().decode(), Fernet.generate_key().decode()


@pytest.fixture
def keys(monkeypatch):
    def use(value: str):
        monkeypatch.setattr(get_settings(), "data_encryption_key", value)
        crypto.reset_cache()
    yield use
    crypto.reset_cache()


def _add(**kw) -> int:
    with SessionLocal() as db:
        r = EmergencyRequest(lat=13.08, lng=80.27, incident_type=IncidentType.other, severity=3, **kw)
        db.add(r)
        db.commit()
        return r.id


def _raw(rid: int, col: str):
    with SessionLocal() as db:
        return db.execute(text(f"select {col} from emergency_requests where id = :i"), {"i": rid}).scalar()


def _read(rid: int) -> EmergencyRequest:
    with SessionLocal() as db:
        return db.get(EmergencyRequest, rid)


def test_round_trip_and_ciphertext_on_disk(keys):
    keys(KEY_A)
    rid = _add(caller_name="Priya Raman", caller_phone="9840012345", notes="Gate 2, chest pain", address="T Nagar")
    r = _read(rid)
    assert (r.caller_name, r.caller_phone, r.notes, r.address) == ("Priya Raman", "9840012345", "Gate 2, chest pain", "T Nagar")
    raw = _raw(rid, "caller_phone")
    assert raw.startswith("enc:v1:") and "9840012345" not in raw


def test_legacy_plaintext_still_reads(keys):
    keys(KEY_A)
    rid = _add()
    with SessionLocal() as db:
        db.execute(text("update emergency_requests set caller_name = 'Old Plain Name' where id = :i"), {"i": rid})
        db.commit()
    assert _read(rid).caller_name == "Old Plain Name"


def test_key_rotation(keys):
    keys(KEY_A)
    rid = _add(caller_name="Rotated")
    keys(f"{KEY_B},{KEY_A}")
    assert _read(rid).caller_name == "Rotated"
    rid2 = _add(caller_name="New key")
    keys(KEY_B)
    assert _read(rid2).caller_name == "New key"


def test_wrong_key_fails_loudly(keys):
    keys(KEY_A)
    rid = _add(caller_name="Secret")
    keys(KEY_C)
    with pytest.raises(InvalidToken):
        _read(rid)


def test_no_key_in_development_is_passthrough(keys):
    keys("")
    rid = _add(caller_name="Plain")
    assert _raw(rid, "caller_name") == "Plain" and _read(rid).caller_name == "Plain"


def test_none_and_long_address(keys):
    keys(KEY_A)
    rid = _add(caller_name=None, address="x" * 400)
    r = _read(rid)
    assert r.caller_name is None and r.address == "x" * 400
