from decimal import Decimal

import pytest
from sqlalchemy import select

from ops_helpers import Env
from app.models import (Ambulance, BillingRecord, ClaimStatus, EmergencyRequest, Hospital, IncidentType, PaymentStatus,
                        RequestStatus, TripRecord)
from app.services import billing


@pytest.fixture(scope="module")
def env():
    return Env()


def _pending_bill(env):
    with env.db() as db:
        return db.execute(select(BillingRecord).where(BillingRecord.payment_status == PaymentStatus.pending,
                                                      BillingRecord.insurance_claim_status.is_(None))).scalars().first().id


def _staff_of(env, bid) -> str:
    """Seed: staff{i}@hads.in works at hospital id i."""
    with env.db() as db:
        return f"staff{db.get(TripRecord, db.get(BillingRecord, bid).trip_id).destination_hospital_id}@hads.in"


def test_fare_formula_and_split_decimal():
    s = {"base_fare": 500, "per_km_rate": 25, "als_surcharge": 400, "revenue_share_pct": 70}
    f = billing.compute_fare(s, 10.3, "ALS", None)
    assert f["base_fare"] == Decimal("500.00") and f["distance_charge"] == Decimal("257.50")
    assert f["surcharge"] == Decimal("400.00") and f["amount"] == Decimal("1157.50")
    assert f["hospital_share"] == Decimal("810.25") and f["platform_share"] == Decimal("347.25")
    assert f["hospital_share"] + f["platform_share"] == f["amount"]
    b = billing.compute_fare(s, 3, "BLS", 60)
    assert b["surcharge"] == 0 and b["hospital_share"] == Decimal("345.00")


def test_create_bill_idempotent_and_uses_hospital_share(env):
    with env.db() as db:
        h = db.execute(select(Hospital)).scalars().first()
        h.revenue_share_pct = 50.0
        a = db.execute(select(Ambulance).where(Ambulance.kind == "ALS")).scalars().first()
        req = EmergencyRequest(lat=13.05, lng=80.25, incident_type=IncidentType.trauma, severity=3, status=RequestStatus.completed)
        db.add(req); db.flush()
        trip = TripRecord(request_id=req.id, ambulance_id=a.id, destination_hospital_id=h.id, distance_km=8.0)
        db.add(trip); db.flush()
        b1 = billing.create_bill_for_trip(db, trip)
        b2 = billing.create_bill_for_trip(db, trip)
        db.commit()
        assert b1.id == b2.id
        assert float(b1.amount) == 500 + 25 * 8 + 400
        assert float(b1.hospital_share) == float(b1.amount) / 2
        assert billing.create_bill_for_trip(db, None) is None


def test_settings_change_affects_new_bills(env):
    c = env.client
    adm = env.as_("admin@hads.in")
    assert c.put("/api/admin/settings", json={"base_fare": 1000, "per_km_rate": 10}, headers=adm).status_code == 200
    with env.db() as db:
        s = billing.get_platform_settings(db)
        assert s["base_fare"] == 1000 and s["per_km_rate"] == 10


def test_pay_flow_and_permissions(env):
    bid = _pending_bill(env)
    c = env.client
    assert c.get("/api/billing", headers=env.as_("controller@hads.in")).status_code == 403
    staff = env.as_(_staff_of(env, bid))
    other = next(f"staff{i}@hads.in" for i in range(1, 9) if f"staff{i}@hads.in" != _staff_of(env, bid))
    # payments are recorded by the hospital that collected them, never self-attested by the patient
    assert c.post(f"/api/billing/{bid}/pay", json={"method": "upi"}, headers=env.as_("user@hads.in")).status_code == 403
    assert c.post(f"/api/billing/{bid}/pay", json={"method": "upi"}, headers=env.as_(other)).status_code == 404
    r = c.post(f"/api/billing/{bid}/pay", json={"method": "upi", "reference": "UTR 4471 0021"}, headers=staff)
    assert r.status_code == 200 and r.json()["payment_status"] == "paid"
    assert c.post(f"/api/billing/{bid}/pay", json={"method": "upi"}, headers=staff).status_code == 409
    assert c.post(f"/api/billing/{bid}/pay", json={"method": "5"}, headers=staff).status_code == 422
    with env.db() as db:
        from app.models import AuditLog
        row = db.execute(select(AuditLog).where(AuditLog.action == "billing.pay", AuditLog.entity_id == str(bid))).scalars().one()
        assert row.details["reference"] == "UTR 4471 0021"
    assert c.get("/api/billing", headers=env.as_("staff1@hads.in")).status_code == 200


def test_claim_workflow_validated_transitions(env):
    bid = _pending_bill(env)
    c, adm, usr = env.client, env.as_("admin@hads.in"), env.as_("user@hads.in")
    r = c.post(f"/api/billing/{bid}/claim", json={"insurer": "Star Health", "policy_number": "POL123456"}, headers=usr)
    assert r.status_code == 201
    j = r.json()
    assert j["payment_status"] == "insurance_pending" and j["insurance_claim_status"] == "submitted"
    cid = j["claim"]["id"]
    assert c.post(f"/api/billing/{bid}/claim", json={"insurer": "X Ins", "policy_number": "P1234"}, headers=usr).status_code == 409
    assert c.post(f"/api/billing/{bid}/pay", json={"method": "upi"}, headers=env.as_(_staff_of(env, bid))).status_code == 409  # claim active
    assert c.post(f"/api/billing/claims/{cid}/status", json={"status": "settled"}, headers=usr).status_code == 403
    assert c.post(f"/api/billing/claims/{cid}/status", json={"status": "approved"}, headers=adm).status_code == 409  # skip
    for st in ("under_review", "approved", "settled"):
        r = c.post(f"/api/billing/claims/{cid}/status", json={"status": st, "remarks": "ok"}, headers=adm)
        assert r.status_code == 200 and r.json()["insurance_claim_status"] == st
    assert r.json()["payment_status"] == "paid"
    assert c.post(f"/api/billing/claims/{cid}/status", json={"status": "rejected"}, headers=adm).status_code == 409  # terminal
    assert c.post(f"/api/billing/claims/9999/status", json={"status": "settled"}, headers=adm).status_code == 404


def test_rejected_claim_returns_bill_to_patient(env):
    bid = _pending_bill(env)
    c, adm, usr = env.client, env.as_("admin@hads.in"), env.as_("user@hads.in")
    cid = c.post(f"/api/billing/{bid}/claim", json={"insurer": "Star Health", "policy_number": "POL123456"},
                 headers=usr).json()["claim"]["id"]
    c.post(f"/api/billing/claims/{cid}/status", json={"status": "rejected"}, headers=adm)
    b = c.get("/api/billing?limit=500", headers=adm).json()
    row = next(x for x in b if x["id"] == bid)
    assert row["payment_status"] == "pending" and row["insurance_claim_status"] == "rejected"
    assert c.post(f"/api/billing/{bid}/pay", json={"method": "card"}, headers=adm).status_code == 200


def test_access_scoping_and_trip_lookup(env):
    c = env.client
    with env.db() as db:
        bill = db.execute(select(BillingRecord)).scalars().first()
        trip = db.get(TripRecord, bill.trip_id)
        hid = trip.destination_hospital_id
    ok = c.get(f"/api/billing/trips/{bill.trip_id}", headers=env.as_("user@hads.in"))
    assert ok.status_code == 200 and ok.json()["trip_id"] == bill.trip_id
    for k in ("amount", "base_fare", "distance_charge", "surcharge", "hospital_share", "platform_share", "claim", "request_id"):
        assert k in ok.json()
    assert c.get(f"/api/billing/trips/{bill.trip_id}", headers=env.as_(f"staff{hid}@hads.in")).status_code == 200
    other = next(i for i in range(1, 9) if i != hid)
    assert c.get(f"/api/billing/trips/{bill.trip_id}", headers=env.as_(f"staff{other}@hads.in")).status_code == 404
    assert c.get(f"/api/billing/trips/{bill.trip_id}", headers=env.as_("authority@hads.in")).status_code == 200
    mine = c.get("/api/billing", headers=env.as_(f"staff{hid}@hads.in")).json()
    assert mine and all(b["hospital_id"] == hid for b in mine)
    assert c.get("/api/billing/trips/99999", headers=env.as_("admin@hads.in")).status_code == 404
