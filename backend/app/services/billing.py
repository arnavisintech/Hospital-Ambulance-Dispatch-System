"""FR10: fare computation, revenue split, payment and cashless-insurance claim workflow. All money in Decimal."""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..geo import haversine_km
from ..models import (Ambulance, BillingRecord, ClaimStatus, EmergencyRequest, Hospital, InsuranceClaim, PaymentStatus,
                      PlatformSetting, TripRecord, utcnow)

CENT = Decimal("0.01")

# key -> (default, min, max, type)
SETTING_DEFS: dict[str, tuple] = {
    "revenue_share_pct": (70.0, 0.0, 100.0, float),   # hospital share of each fare
    "base_fare": (500.0, 0.0, 100000.0, float),
    "per_km_rate": (25.0, 0.0, 10000.0, float),
    "als_surcharge": (400.0, 0.0, 100000.0, float),
    "crew_ack_timeout_s": (30, 5, 600, int),
    "dispatch_target_s": (8, 1, 120, int),
    "response_target_s": (900, 60, 7200, int),       # p90 call-to-scene target for the compliance report
    "capacity_stale_min": (15, 1, 1440, int),
    "rebalance_max_moves": (5, 1, 20, int),
    "analytics_retrain_interval_min": (60, 1, 10080, int),
}

# allowed claim transitions
CLAIM_TRANSITIONS: dict[ClaimStatus, set[ClaimStatus]] = {
    ClaimStatus.submitted: {ClaimStatus.under_review, ClaimStatus.rejected},
    ClaimStatus.under_review: {ClaimStatus.approved, ClaimStatus.rejected},
    ClaimStatus.approved: {ClaimStatus.settled},
    ClaimStatus.rejected: set(),
    ClaimStatus.settled: set(),
}
ACTIVE_CLAIM = {ClaimStatus.submitted, ClaimStatus.under_review, ClaimStatus.approved}


def money(x) -> Decimal:
    return Decimal(str(x if x is not None else 0)).quantize(CENT, rounding=ROUND_HALF_UP)


def get_platform_settings(db: Session) -> dict:
    """All platform parameters, defaults filled in for anything not stored."""
    out = {k: v[0] for k, v in SETTING_DEFS.items()}
    for row in db.execute(select(PlatformSetting)).scalars():
        if row.key in SETTING_DEFS and isinstance(row.value, dict) and "value" in row.value:
            out[row.key] = row.value["value"]
    return out


def compute_fare(db_settings: dict, distance_km: float, kind: str, share_pct: float | None) -> dict:
    base = money(db_settings["base_fare"])
    dist = money(Decimal(str(db_settings["per_km_rate"])) * Decimal(str(max(distance_km, 0.0))))
    sur = money(db_settings["als_surcharge"]) if (kind or "").upper() == "ALS" else Decimal("0.00")
    amount = base + dist + sur
    pct = Decimal(str(db_settings["revenue_share_pct"] if share_pct is None else share_pct))
    hosp = money(amount * pct / Decimal(100))
    return {"base_fare": base, "distance_charge": dist, "surcharge": sur, "amount": amount,
            "hospital_share": hosp, "platform_share": amount - hosp}


def _trip_distance(db: Session, trip: TripRecord, hospital: Hospital | None, req: EmergencyRequest | None) -> float:
    if trip.distance_km:
        return float(trip.distance_km)
    d = (trip.summary or {}).get("distance_km") if isinstance(trip.summary, dict) else None
    if d:
        return float(d)
    if req is not None and hospital is not None:
        return round(haversine_km(req.lat, req.lng, hospital.lat, hospital.lng) * 1.3, 2)
    return 0.0


def create_bill_for_trip(db: Session, trip):
    """FR10: create (idempotently) the BillingRecord for a closed trip; return it. Caller commits."""
    if trip is None:
        return None
    if trip.id is None:
        db.flush()
    existing = db.execute(select(BillingRecord).where(BillingRecord.trip_id == trip.id)).scalar_one_or_none()
    if existing:
        return existing
    req = db.get(EmergencyRequest, trip.request_id)
    amb = db.get(Ambulance, trip.ambulance_id) if trip.ambulance_id else None
    hid = trip.destination_hospital_id or (amb.station.hospital_id if amb and amb.station else None)
    hospital = db.get(Hospital, hid) if hid else None
    fare = compute_fare(get_platform_settings(db), _trip_distance(db, trip, hospital, req),
                        amb.kind if amb else "BLS", hospital.revenue_share_pct if hospital else None)
    bill = BillingRecord(trip_id=trip.id, payment_status=PaymentStatus.pending, **fare)
    db.add(bill)
    db.flush()
    return bill


# ------------------------------------------------------------------ payment / claims
def pay_bill(db: Session, bill: BillingRecord, method: str) -> BillingRecord:
    if bill.payment_status == PaymentStatus.paid:
        raise HTTPException(409, "Bill already paid")
    if bill.payment_status == PaymentStatus.waived:
        raise HTTPException(409, "Bill was waived")
    claim = get_claim(db, bill.id)
    if claim and claim.status in ACTIVE_CLAIM:
        raise HTTPException(409, f"Insurance claim is {claim.status.value}; payment is settled through the insurer")
    bill.payment_status = PaymentStatus.paid
    return bill


def get_claim(db: Session, bill_id: int) -> InsuranceClaim | None:
    return db.execute(select(InsuranceClaim).where(InsuranceClaim.bill_id == bill_id)).scalar_one_or_none()


def submit_claim(db: Session, bill: BillingRecord, insurer: str, policy_number: str) -> InsuranceClaim:
    if bill.payment_status == PaymentStatus.paid:
        raise HTTPException(409, "Bill already paid")
    if get_claim(db, bill.id):
        raise HTTPException(409, "A claim already exists for this bill")
    claim = InsuranceClaim(bill_id=bill.id, insurer=insurer.strip(), policy_number=policy_number.strip(),
                           amount_claimed=money(bill.amount), status=ClaimStatus.submitted)
    db.add(claim)
    bill.payment_status = PaymentStatus.insurance_pending
    bill.insurance_claim_status = ClaimStatus.submitted.value
    db.flush()
    return claim


def update_claim_status(db: Session, claim: InsuranceClaim, new: ClaimStatus, remarks: str | None) -> InsuranceClaim:
    if new not in CLAIM_TRANSITIONS[claim.status]:
        allowed = sorted(s.value for s in CLAIM_TRANSITIONS[claim.status]) or ["none (terminal)"]
        raise HTTPException(409, f"Invalid claim transition {claim.status.value} -> {new.value}; allowed: {allowed}")
    claim.status = new
    claim.updated_at = utcnow()
    if remarks:
        claim.remarks = remarks
    bill = db.get(BillingRecord, claim.bill_id)
    bill.insurance_claim_status = new.value
    if new == ClaimStatus.settled:
        bill.payment_status = PaymentStatus.paid
    elif new == ClaimStatus.rejected:
        bill.payment_status = PaymentStatus.pending  # falls back to the patient
    db.flush()
    return claim


def bill_out(db: Session, bill: BillingRecord, claim: InsuranceClaim | None = ..., trip: TripRecord | None = None) -> dict:
    trip = trip or db.get(TripRecord, bill.trip_id)
    if claim is ...:
        claim = get_claim(db, bill.id)
    return {
        "id": bill.id, "trip_id": bill.trip_id, "request_id": trip.request_id if trip else None,
        "hospital_id": trip.destination_hospital_id if trip else None,
        "amount": float(bill.amount), "base_fare": float(bill.base_fare), "distance_charge": float(bill.distance_charge),
        "surcharge": float(bill.surcharge), "hospital_share": float(bill.hospital_share),
        "platform_share": float(bill.platform_share),
        "payment_status": bill.payment_status.value, "insurance_claim_status": bill.insurance_claim_status,
        "created_at": bill.created_at.isoformat() if bill.created_at else None,
        "claim": None if claim is None else {
            "id": claim.id, "bill_id": claim.bill_id, "insurer": claim.insurer, "policy_number": claim.policy_number,
            "amount_claimed": float(claim.amount_claimed), "status": claim.status.value, "remarks": claim.remarks,
            "submitted_at": claim.submitted_at.isoformat() if claim.submitted_at else None,
            "updated_at": claim.updated_at.isoformat() if claim.updated_at else None},
    }
