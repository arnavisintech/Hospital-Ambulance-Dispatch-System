"""Hospital capacity and handover (UC-3, UC-4). Staff may only act on their own hospital (STRQ2)."""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit, events
from ..db import get_db
from ..deps import current_user, require_roles
from ..models import Ambulance, AuditLog, EmergencyRequest, Hospital, RequestStatus, Role, TripRecord, User, utcnow
from ..services import capacity, dispatch, notify, trips

router = APIRouter(prefix="/api/hospitals", tags=["hospitals"])
RS = RequestStatus
INCOMING = [RS.offered, RS.accepted, RS.en_route, RS.on_scene, RS.transporting, RS.arrived]


class CapacityIn(BaseModel):
    available_beds: int = Field(ge=0)
    available_icu: int = Field(ge=0)
    specialists: dict[str, int] | None = None


class HandoverIn(BaseModel):
    notes: str | None = Field(default=None, max_length=500)


def _hospital(db: Session, hospital_id: int) -> Hospital:
    h = db.get(Hospital, hospital_id)
    if h is None:
        raise HTTPException(404, "Hospital not found")
    return h


def _own_staff(db: Session, user: User, hospital_id: int, allow_admin: bool = False) -> None:
    if allow_admin and user.role == Role.admin:
        return
    if user.role != Role.hospital_staff or trips.user_hospital_id(db, user) != hospital_id:
        raise HTTPException(403, "Not permitted for this hospital")


@router.get("")
def list_hospitals(user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = select(Hospital).order_by(Hospital.id)
    if user.role != Role.admin:
        q = q.where(Hospital.partner_verified.is_(True))  # pending / suspended partners are admin-only
    return [capacity.hospital_out(h) for h in db.execute(q).scalars()]


@router.get("/{hospital_id}")
def get_hospital(hospital_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    return capacity.hospital_out(_hospital(db, hospital_id))


@router.put("/{hospital_id}/capacity")
def update_capacity(hospital_id: int, body: CapacityIn, user: User = Depends(require_roles(Role.hospital_staff, Role.admin)),
                    db: Session = Depends(get_db)):
    _own_staff(db, user, hospital_id, allow_admin=True)
    h = _hospital(db, hospital_id)
    if not h.partner_verified and user.role != Role.admin:
        raise HTTPException(403, "This hospital is not a verified partner yet")
    if body.available_beds > h.total_beds or body.available_icu > h.total_icu:
        raise HTTPException(422, "Available counts cannot exceed total capacity")
    before = {"available_beds": h.available_beds, "available_icu": h.available_icu}
    h.available_beds, h.available_icu = body.available_beds, body.available_icu
    if body.specialists is not None:
        if any(v < 0 for v in body.specialists.values()):
            raise HTTPException(422, "Specialist counts must be >= 0")
        h.specialists = dict(body.specialists)
    h.capacity_updated_at = utcnow()
    audit.log(db, "capacity.update", "hospital", h.id, user.id,
              {"before": before, "after": {"available_beds": h.available_beds, "available_icu": h.available_icu},
               "specialists": h.specialists})
    db.commit()
    out = capacity.hospital_out(h)
    events.publish("controller", "capacity.updated", out)
    return out


def _incoming_out(db: Session, r: EmergencyRequest, acked: set[str]) -> dict:
    """v2 item {request, eta_seconds, ambulance, crew, reserved}; RequestOut fields stay at top level for v1."""
    req = trips.request_out(db, r)
    amb = db.get(Ambulance, r.ambulance_id) if r.ambulance_id else None
    return {**req, "acknowledged": str(r.id) in acked, "request": req, "eta_seconds": r.eta_seconds,
            "ambulance": {"id": amb.id, "registration_number": amb.registration_number, "kind": amb.kind} if amb else None,
            "crew": trips.crew_out(trips.crew_user(db, amb.id), with_phone=True) if amb else None,
            "reserved": capacity.reserved_kind(db, r.id)}


@router.get("/{hospital_id}/incoming")
def incoming(hospital_id: int, user: User = Depends(require_roles(Role.hospital_staff)), db: Session = Depends(get_db)):
    _own_staff(db, user, hospital_id)
    rows = db.execute(select(EmergencyRequest).where(EmergencyRequest.destination_hospital_id == hospital_id,
                                                     EmergencyRequest.status.in_(INCOMING))
                      .order_by(EmergencyRequest.severity.desc(), EmergencyRequest.id)).scalars().all()
    acked = set(db.execute(select(AuditLog.entity_id).where(AuditLog.action == "hospital.acknowledge",
                                                           AuditLog.entity == "request")).scalars())
    return [_incoming_out(db, r, acked) for r in rows]


@router.get("/{hospital_id}/handovers")
def handovers(hospital_id: int, limit: int = Query(20, ge=1, le=100),
              user: User = Depends(require_roles(Role.hospital_staff, Role.admin)), db: Session = Depends(get_db)):
    """Recent completed handovers at this hospital (newest first)."""
    _own_staff(db, user, hospital_id, allow_admin=True)
    _hospital(db, hospital_id)
    rows = db.execute(select(TripRecord, EmergencyRequest).join(EmergencyRequest, EmergencyRequest.id == TripRecord.request_id)
                      .where(TripRecord.destination_hospital_id == hospital_id, TripRecord.handover_time.is_not(None),
                             EmergencyRequest.status == RS.completed)
                      .order_by(TripRecord.handover_time.desc()).limit(limit)).all()
    out = []
    for trip, r in rows:
        amb = db.get(Ambulance, trip.ambulance_id) if trip.ambulance_id else None
        by = db.get(User, trip.handover_confirmed_by) if trip.handover_confirmed_by else None
        crew = trips.crew_user(db, trip.ambulance_id)
        arr, ho = trips.aware(trip.arrived_hospital_at), trips.aware(trip.handover_time)
        out.append({"request": trips.request_out(db, r), "trip_id": trip.id,
                    "handover_time": trips.iso(trip.handover_time), "arrived_hospital_at": trips.iso(trip.arrived_hospital_at),
                    "handover_duration_s": int((ho - arr).total_seconds()) if arr and ho else None,
                    "handover_confirmed_by": {"id": by.id, "name": by.name} if by else None,
                    "closed_manually": trip.closed_manually,
                    "closed_by": (trip.summary or {}).get("closed_by"),
                    "ambulance": {"registration_number": amb.registration_number, "kind": amb.kind} if amb else None,
                    "crew": {"name": crew.name} if crew else None,
                    "response_time_seconds": trip.response_time_seconds, "distance_km": trip.distance_km})
    return out


def _incoming_request(db: Session, hospital_id: int, request_id: int) -> EmergencyRequest:
    req = dispatch.lock_request(db, request_id)
    if req is None or req.destination_hospital_id != hospital_id:
        raise HTTPException(404, "No such incoming request for this hospital")
    return req


@router.post("/{hospital_id}/incoming/{request_id}/acknowledge")
def acknowledge(hospital_id: int, request_id: int, user: User = Depends(require_roles(Role.hospital_staff)),
                db: Session = Depends(get_db)):
    _own_staff(db, user, hospital_id)
    req = _incoming_request(db, hospital_id, request_id)
    if req.status not in INCOMING:
        raise HTTPException(409, f"Request is {req.status.value}")
    audit.log(db, "hospital.acknowledge", "request", req.id, user.id, {"hospital_id": hospital_id})
    notify.notify_requester(db, req, "hospital.acknowledged", "The hospital is ready for you",
                            "Staff have acknowledged the incoming patient.", {"hospital_id": hospital_id})
    db.commit()
    data = {"request_id": req.id, "hospital_id": hospital_id, "acknowledged": True}
    events.publish(f"request:{req.id}", "hospital.incoming", data)
    events.publish("controller", "hospital.incoming", data)
    if req.ambulance_id:
        events.publish(f"crew:{req.ambulance_id}", "hospital.incoming", data)
    return data


@router.post("/{hospital_id}/handover/{request_id}")
def handover(hospital_id: int, request_id: int, body: HandoverIn | None = None,
             user: User = Depends(require_roles(Role.hospital_staff)), db: Session = Depends(get_db)):
    _own_staff(db, user, hospital_id)
    req = _incoming_request(db, hospital_id, request_id)
    trips.close_trip(db, req, user.id, reason=body.notes if body else None)
    return trips.request_out(db, req)
