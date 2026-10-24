"""Controller console (UC-2 A1 overrides, UC-3 A1 manual destination, UC-4 E1 manual closure)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..db import get_db
from ..deps import require_roles
from ..models import (Ambulance, CrewProfile, DarkStation, EmergencyRequest, Hospital, RequestStatus, Role, User,
                      utcnow)
from ..services import capacity, dispatch, trips

router = APIRouter(prefix="/api/controller", tags=["controller"])
ctl = require_roles(Role.controller, Role.admin)
RS = RequestStatus


class AssignIn(BaseModel):
    ambulance_id: int
    reason: str | None = Field(default=None, max_length=255)


class DestinationIn(BaseModel):
    hospital_id: int


class CloseIn(BaseModel):
    reason: str = Field(min_length=1, max_length=255)


def _req(db: Session, request_id: int) -> EmergencyRequest:
    req = dispatch.lock_request(db, request_id)
    if req is None:
        raise HTTPException(404, "Request not found")
    return req


@router.get("/board")
def board(user: User = Depends(ctl), db: Session = Depends(get_db)):
    now = utcnow()
    active = db.execute(select(EmergencyRequest).where(EmergencyRequest.status.notin_(list(trips.TERMINAL)))
                        .order_by(EmergencyRequest.severity.desc(), EmergencyRequest.id)).scalars().all()
    stations = db.execute(select(DarkStation).order_by(DarkStation.id)).scalars().all()
    amb_rows = db.execute(select(Ambulance).order_by(Ambulance.id)).scalars().all()
    by_station: dict[int, list[Ambulance]] = {}
    for a in amb_rows:
        by_station.setdefault(a.station_id, []).append(a)
    sname = {s.id: s.name for s in stations}
    stale_min = capacity.stale_minutes(db)
    hospitals = []
    for h in db.execute(select(Hospital).order_by(Hospital.id)).scalars():
        hospitals.append({"id": h.id, "name": h.name, "lat": h.lat, "lng": h.lng, "available_beds": h.available_beds,
                          "available_icu": h.available_icu, "capacity_age_min": capacity.capacity_age_min(h),
                          "stale": capacity.is_stale(h, stale_min)})
    crew_names: dict[int, str] = {}
    for amb_id, name in db.execute(select(CrewProfile.ambulance_id, User.name).join(User, User.id == CrewProfile.user_id)
                                   .where(User.is_active.is_(True)).order_by(User.id)).all():
        if amb_id is not None:
            crew_names.setdefault(amb_id, name)
    req_for_amb = {r.ambulance_id: r.id for r in active if r.ambulance_id}
    return {
        "requests": [trips.request_out(db, r) for r in active],
        "ambulances": [{"id": a.id, "registration_number": a.registration_number, "kind": a.kind,
                        "status": a.status.value, "lat": a.lat, "lng": a.lng, "station_id": a.station_id,
                        "station_name": sname.get(a.station_id), "heading_deg": trips.heading_deg(db, a.id),
                        "crew_name": crew_names.get(a.id), "request_id": req_for_amb.get(a.id),
                        "location_age_s": int((now - trips.aware(a.location_updated_at)).total_seconds())
                        if a.location_updated_at else None} for a in amb_rows],
        "stations": [{"id": s.id, "name": s.name, "hospital_id": s.hospital_id, "lat": s.lat, "lng": s.lng,
                      "is_active": s.is_active, "ambulances": len(by_station.get(s.id, [])),
                      "available": sum(1 for a in by_station.get(s.id, []) if a.status.value == "available")}
                     for s in stations],
        "hospitals": hospitals,
        "escalations": [r.id for r in active if r.status == RS.awaiting_manual],
    }


@router.post("/requests/{request_id}/assign")
def assign(request_id: int, body: AssignIn, user: User = Depends(ctl), db: Session = Depends(get_db)):
    req = _req(db, request_id)
    dispatch.assign_manual(db, req, body.ambulance_id, user.id, body.reason)
    return trips.request_out(db, req)


@router.post("/requests/{request_id}/destination")
def set_destination(request_id: int, body: DestinationIn, user: User = Depends(ctl), db: Session = Depends(get_db)):
    req = _req(db, request_id)
    if req.status in trips.TERMINAL or req.status == RS.arrived:
        raise HTTPException(409, f"Cannot change destination while request is {req.status.value}")
    h = db.get(Hospital, body.hospital_id)
    if h is None or not h.partner_verified:
        raise HTTPException(404, "Hospital not found or not a verified partner")
    previous = req.destination_hospital_id
    capacity.release_reservation(db, req, reason="controller_override")
    req.destination_hospital_id = h.id
    stale = capacity.is_stale(h)
    res = capacity.reserve(db, req, h, stale)
    capacity.note_destination(db, req, h.id, not stale, manual=True)
    if req.status == RS.transporting:
        trips.recompute_eta(db, req)
    audit.log(db, "capacity.override", "request", req.id, user.id,
              {"hospital_id": h.id, "previous_hospital_id": previous, "capacity_unknown": stale,
               "reserved": res["counted"], "available_beds": h.available_beds, "available_icu": h.available_icu})
    trip = trips.get_or_create_trip(db, req) if req.ambulance_id else None
    if trip is not None:
        trip.destination_hospital_id = h.id
    capacity.notify_destination(db, req, h)
    db.commit()
    capacity.announce_destination(db, req, h, {"manual": True})
    return trips.request_out(db, req)


@router.post("/requests/{request_id}/close")
def close(request_id: int, body: CloseIn, user: User = Depends(ctl), db: Session = Depends(get_db)):
    req = _req(db, request_id)
    trips.close_trip(db, req, user.id, manual=True, reason=body.reason)
    return trips.request_out(db, req)


@router.get("/requests/{request_id}/candidates")
def candidates(request_id: int, user: User = Depends(ctl), db: Session = Depends(get_db)):
    req = db.get(EmergencyRequest, request_id)
    if req is None:
        raise HTTPException(404, "Request not found")
    ranked = dispatch.rank_candidates(db, req)
    return [dispatch.candidate_out(c) | {"zone_risk": c["zone_risk"]} for c in ranked]
