"""Ambulance crew workflow (UC-2 acceptance, UC-4 trip progress, FR6 navigation)."""
from datetime import timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit
from ..config import get_settings
from ..db import get_db
from ..deps import require_roles
from ..models import (Ambulance, AmbulanceStatus, AttemptStatus, DispatchAttempt, EmergencyRequest, Hospital,
                      RequestStatus, Role, User)
from ..services import crew_actions, dispatch, routing, trips

router = APIRouter(prefix="/api/crew", tags=["crew"])
RS = RequestStatus
crew_only = require_roles(Role.crew)

NEXT_STATUS = crew_actions.NEXT_STATUS
TRIP_STATES = crew_actions.TRIP_STATES


class DutyIn(BaseModel):
    on_duty: bool


class LocationIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class RejectIn(BaseModel):
    reason: str | None = Field(default=None, max_length=255)


class StatusIn(BaseModel):
    status: str = Field(pattern="^(en_route|on_scene|transporting|arrived)$")


def _my_ambulance(db: Session, user: User) -> Ambulance:
    amb_id = trips.user_ambulance_id(db, user)
    amb = db.get(Ambulance, amb_id) if amb_id else None
    if amb is None:
        raise HTTPException(409, "No ambulance is assigned to this crew account")
    return amb


def _my_request(db: Session, amb: Ambulance, request_id: int, lock: bool = False) -> EmergencyRequest:
    req = dispatch.lock_request(db, request_id) if lock else db.get(EmergencyRequest, request_id)
    if req is None:
        raise HTTPException(404, "Request not found")
    if req.ambulance_id != amb.id:
        raise HTTPException(403, "This request is not assigned to your ambulance")
    return req


def _ambulance_out(db: Session, a: Ambulance) -> dict:
    return {"id": a.id, "registration_number": a.registration_number, "kind": a.kind, "status": a.status.value,
            "lat": a.lat, "lng": a.lng, "staffed": a.staffed, "station_id": a.station_id,
            "location_updated_at": trips.iso(a.location_updated_at), "heading_deg": trips.heading_deg(db, a.id)}


def _offer_out(db: Session, amb: Ambulance, offer: EmergencyRequest) -> dict:
    """Pending offer: no requester phone until accepted; adds offer timing and road distance/ETA to the patient."""
    out = trips.request_out(db, offer, hide_phone=True)
    att = db.execute(select(DispatchAttempt).where(DispatchAttempt.request_id == offer.id,
                                                   DispatchAttempt.ambulance_id == amb.id,
                                                   DispatchAttempt.status == AttemptStatus.offered)
                     .order_by(DispatchAttempt.id.desc())).scalars().first()
    timeout = trips.get_setting(db, "crew_ack_timeout_s", get_settings().crew_ack_timeout_s)
    offered_at = trips.aware(att.offered_at) if att else trips.aware(offer.dispatched_at)
    snap = trips.route_snapshot(db, offer, publish=False)
    out.update(offered_at=trips.iso(offered_at),
               offer_expires_at=trips.iso(offered_at + timedelta(seconds=timeout)) if offered_at else None,
               distance_km=snap["distance_km"] if snap else round(routing.road_km(trips.ambulance_point(amb), (offer.lat, offer.lng)), 2),
               eta_seconds=snap["eta_seconds"] if snap else offer.eta_seconds)
    return out


@router.get("/me")
def me(user: User = Depends(crew_only), db: Session = Depends(get_db)):
    amb = _my_ambulance(db, user)
    st = amb.station
    offer = db.execute(select(EmergencyRequest).where(EmergencyRequest.ambulance_id == amb.id,
                                                      EmergencyRequest.status == RS.offered)).scalars().first()
    active = db.execute(select(EmergencyRequest).where(EmergencyRequest.ambulance_id == amb.id,
                                                       EmergencyRequest.status.in_(TRIP_STATES))).scalars().first()
    return {"ambulance": _ambulance_out(db, amb),
            "station": {"id": st.id, "name": st.name, "lat": st.lat, "lng": st.lng, "hospital_id": st.hospital_id},
            "pending_offer": _offer_out(db, amb, offer) if offer else None,
            "active_trip": trips.request_out(db, active) if active else None,
            "stats_today": trips.stats_today(db, amb.id),
            "crew": {"name": user.name, "initials": trips.initials(user.name)}}


@router.post("/duty")
def duty(body: DutyIn, user: User = Depends(crew_only), db: Session = Depends(get_db)):
    amb = _my_ambulance(db, user)
    if body.on_duty:
        if amb.status == AmbulanceStatus.maintenance:
            raise HTTPException(409, "Ambulance is in maintenance")
        if amb.status == AmbulanceStatus.offline:
            amb.status = AmbulanceStatus.available
        amb.staffed = True
    else:
        if amb.status not in (AmbulanceStatus.available, AmbulanceStatus.offline):
            raise HTTPException(409, "Cannot go off duty during an active assignment")
        amb.status = AmbulanceStatus.offline
    audit.log(db, "crew.duty", "ambulance", amb.id, user.id, {"on_duty": body.on_duty})
    db.commit()
    return _ambulance_out(db, amb)


@router.post("/location", status_code=204)
def location(body: LocationIn, user: User = Depends(crew_only), db: Session = Depends(get_db)):
    amb = _my_ambulance(db, user)
    crew_actions.note_device(amb.id)  # a real device is driving: the demo autopilot backs off
    crew_actions.record_location(db, amb, body.lat, body.lng)
    return Response(status_code=204)


@router.post("/offers/{request_id}/accept")
def accept(request_id: int, user: User = Depends(crew_only), db: Session = Depends(get_db)):
    amb = _my_ambulance(db, user)
    req = crew_actions.accept_offer(db, amb, request_id, user.id)
    return trips.request_out(db, req)


@router.post("/offers/{request_id}/reject")
def reject(request_id: int, bg: BackgroundTasks, body: RejectIn | None = None,
           user: User = Depends(crew_only), db: Session = Depends(get_db)):
    amb = _my_ambulance(db, user)
    with dispatch._LOCK:
        req = _my_request(db, amb, request_id, lock=True)
        if not dispatch.release_offer(db, req, AttemptStatus.rejected, user.id, body.reason if body else None):
            raise HTTPException(409, f"No pending offer for this request (status {req.status.value})")
    bg.add_task(dispatch.run_dispatch, req.id)  # next-ranked ambulance
    return {"request_id": req.id, "status": req.status.value}


@router.post("/trips/{request_id}/status")
def trip_status(request_id: int, body: StatusIn, user: User = Depends(crew_only), db: Session = Depends(get_db)):
    amb = _my_ambulance(db, user)
    req = crew_actions.advance_status(db, amb, request_id, body.status, user.id)
    return trips.request_out(db, req)


@router.get("/trips/{request_id}/route")
def trip_route(request_id: int, user: User = Depends(crew_only), db: Session = Depends(get_db)):
    amb = _my_ambulance(db, user)
    req = _my_request(db, amb, request_id)
    if req.status in trips.TERMINAL or req.status in (RS.received, RS.matching, RS.awaiting_manual):
        raise HTTPException(409, f"No route for a request in status {req.status.value}")
    here = trips.ambulance_point(amb)
    if req.status in (RS.transporting, RS.arrived):
        h = db.get(Hospital, req.destination_hospital_id) if req.destination_hospital_id else None
        if h is None:
            raise HTTPException(409, "No destination hospital confirmed")
        phase, dest = "to_hospital", (h.lat, h.lng)
    else:
        phase, dest = "to_patient", (req.lat, req.lng)
    r = routing.route(here, dest)
    return {"phase": phase, "steps": r["steps"], "polyline": r["polyline"], "distance_km": r["distance_km"],
            "eta_seconds": r["eta_seconds"], "bearing_deg": r.get("bearing_deg"), "provider": r.get("provider")}
