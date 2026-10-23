from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..db import get_db
from ..deps import current_user, require_roles
from ..models import (BillingRecord, ClaimStatus, EmergencyRequest, HospitalStaffProfile, InsuranceClaim, PaymentStatus,
                      Role, TripRecord, User)
from ..services import billing as svc

router = APIRouter(prefix="/api/billing", tags=["billing"])


class PayIn(BaseModel):
    method: str = Field(min_length=2, max_length=24, pattern=r"^[A-Za-z_ ]+$")  # e.g. card, upi, cash


class ClaimIn(BaseModel):
    insurer: str = Field(min_length=2, max_length=120)
    policy_number: str = Field(min_length=3, max_length=60)


class ClaimStatusIn(BaseModel):
    status: ClaimStatus
    remarks: str | None = Field(None, max_length=1000)


def _staff_hospital(db: Session, user: User) -> int | None:
    p = db.get(HospitalStaffProfile, user.id)
    return p.hospital_id if p else None


def _can_view(db: Session, user: User, trip: TripRecord) -> bool:
    if user.role in (Role.admin, Role.authority):
        return True
    if user.role == Role.requester:
        req = db.get(EmergencyRequest, trip.request_id)
        return bool(req and req.requester_id == user.id)
    if user.role == Role.hospital_staff:
        hid = _staff_hospital(db, user)
        return hid is not None and hid == trip.destination_hospital_id
    return False


def _bill_for_user(db: Session, user: User, bill_id: int, roles_ok=(Role.admin, Role.requester, Role.hospital_staff)):
    bill = db.get(BillingRecord, bill_id)
    trip = db.get(TripRecord, bill.trip_id) if bill else None
    if not bill or not _can_view(db, user, trip):
        raise HTTPException(404, "Bill not found")          # do not leak existence
    if user.role not in roles_ok:
        raise HTTPException(403, "Role not permitted")
    return bill, trip


@router.get("/trips/{trip_id}")
def bill_for_trip(trip_id: int, db: Session = Depends(get_db), user: User = Depends(current_user)):
    trip = db.get(TripRecord, trip_id)
    if not trip or not _can_view(db, user, trip):
        raise HTTPException(404, "Bill not found")
    bill = db.execute(select(BillingRecord).where(BillingRecord.trip_id == trip_id)).scalar_one_or_none()
    if not bill:
        raise HTTPException(404, "No bill for this trip yet")
    return svc.bill_out(db, bill, trip=trip)


@router.get("")
def list_bills(payment_status: PaymentStatus | None = None, limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
               db: Session = Depends(get_db),
               user: User = Depends(require_roles(Role.admin, Role.authority, Role.requester, Role.hospital_staff))):
    q = select(BillingRecord).join(TripRecord, TripRecord.id == BillingRecord.trip_id)
    if user.role == Role.requester:
        q = q.join(EmergencyRequest, EmergencyRequest.id == TripRecord.request_id).where(EmergencyRequest.requester_id == user.id)
    elif user.role == Role.hospital_staff:
        hid = _staff_hospital(db, user)
        q = q.where(TripRecord.destination_hospital_id == (hid if hid is not None else -1))
    if payment_status:
        q = q.where(BillingRecord.payment_status == payment_status)
    bills = db.execute(q.order_by(BillingRecord.id.desc()).limit(limit).offset(offset)).scalars().all()
    claims = {c.bill_id: c for c in db.execute(
        select(InsuranceClaim).where(InsuranceClaim.bill_id.in_([b.id for b in bills]))).scalars()} if bills else {}
    return [svc.bill_out(db, b, claims.get(b.id)) for b in bills]


@router.post("/{bill_id}/pay")
def pay(bill_id: int, body: PayIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    bill, trip = _bill_for_user(db, user, bill_id)
    svc.pay_bill(db, bill, body.method)
    audit.log(db, "billing.pay", "bill", bill.id, user.id, {"method": body.method.lower(), "amount": float(bill.amount)})
    db.commit()
    return svc.bill_out(db, bill, trip=trip)


@router.post("/{bill_id}/claim", status_code=201)
def claim(bill_id: int, body: ClaimIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    bill, trip = _bill_for_user(db, user, bill_id)
    c = svc.submit_claim(db, bill, body.insurer, body.policy_number)
    audit.log(db, "billing.claim.submit", "claim", c.id, user.id,
              {"bill_id": bill.id, "insurer": c.insurer, "amount": float(c.amount_claimed)})
    db.commit()
    return svc.bill_out(db, bill, c, trip)


@router.post("/claims/{claim_id}/status")
def claim_status(claim_id: int, body: ClaimStatusIn, db: Session = Depends(get_db),
                 user: User = Depends(require_roles(Role.admin))):
    c = db.get(InsuranceClaim, claim_id)
    if not c:
        raise HTTPException(404, "Claim not found")
    old = c.status.value
    svc.update_claim_status(db, c, body.status, body.remarks)
    audit.log(db, "billing.claim.status", "claim", c.id, user.id,
              {"from": old, "to": body.status.value, "remarks": body.remarks})
    db.commit()
    bill = db.get(BillingRecord, c.bill_id)
    return svc.bill_out(db, bill, c)
