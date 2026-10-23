"""STRQ1: ambulance and hospital ranking never depend on non-medical attributes (identity, channel, address) or on
the patient's age group. Same place, incident type and severity => identical ranking."""
import pytest

from app.db import SessionLocal
from app.models import EmergencyRequest, IncidentType
from app.services import capacity, dispatch
from conftest import PATIENT

BASE = dict(lat=PATIENT[0], lng=PATIENT[1], incident_type=IncidentType.cardiac, severity=4)
VARIANTS = [
    dict(caller_name="Priya Raman", caller_phone="9840012345", address="Poes Garden", channel="app",
         patient_age_group="adult"),
    dict(caller_name="Muthu", caller_phone="9000000000", address="Kannagi Nagar", channel="ivr",
         patient_age_group="elderly"),
    dict(caller_name=None, caller_phone=None, address=None, channel="external", patient_age_group="child"),
    dict(caller_name="X", caller_phone="1", address="", channel="app", patient_age_group="senior"),
    dict(patient_age_group="unknown"),
]


@pytest.fixture
def city(world):
    h1 = world.hospital(lat=13.09, lng=80.28)
    h2 = world.hospital(lat=13.06, lng=80.25, icu=3)
    world.hospital(lat=13.11, lng=80.29, specialists={"trauma": 2})  # no cardiology: filtered for cardiac
    st = world.station(h1)
    for i, (lat, lng, kind) in enumerate([(13.085, 80.275, "BLS"), (13.07, 80.26, "ALS"), (13.10, 80.29, "ALS"),
                                          (13.06, 80.24, "BLS")]):
        world.ambulance(st, lat=lat, lng=lng, kind=kind)
    return {"hospitals": (h1, h2)}


def _rankings(**attrs):
    with SessionLocal() as db:
        req = EmergencyRequest(**BASE, **attrs)
        amb = [(c["ambulance_id"], c["eta_seconds"], c["effective_eta"]) for c in dispatch.rank_candidates(db, req)]
        hosp, radius = capacity.rank_hospitals(db, req)
        return amb, [(r["hospital"].id, r["score"]) for r in hosp], radius


def test_ranking_ignores_identity_channel_address_and_age(city):
    reference = _rankings(**VARIANTS[0])
    assert reference[0] and reference[1]
    for v in VARIANTS[1:]:
        assert _rankings(**v) == reference, v


@pytest.mark.parametrize("age", ["child", "adult", "senior", "elderly", "unknown"])
def test_age_group_alone_never_changes_order(city, age):
    assert _rankings(patient_age_group=age) == _rankings(patient_age_group="unknown")


def test_severity_does_change_order_control(city):
    """Control: a medical factor (severity) is allowed to matter, proving the test can see differences."""
    hi = _rankings(patient_age_group="unknown")
    with SessionLocal() as db:
        req = EmergencyRequest(**{**BASE, "severity": 1})
        lo = [(c["ambulance_id"], c["eta_seconds"], c["effective_eta"]) for c in dispatch.rank_candidates(db, req)]
    assert lo != hi[0]
