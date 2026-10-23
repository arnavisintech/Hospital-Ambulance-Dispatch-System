"""Crew-side trip actions shared by the crew API (real devices) and the demo autopilot (simulated crews).

Both paths call exactly these functions, so WebSocket events, audit rows, ETA updates and the request timeline
are identical whether a human or the autopilot drives the ambulance. `actor` labels non-human actions in the
audit trail (e.g. "autopilot"); user_id is the acting user (None for the autopilot).
"""
from __future__ import annotations

import threading
import time

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit, events
from ..models import (Ambulance, AmbulanceLocation, AmbulanceStatus, AttemptStatus, DispatchAttempt, EmergencyRequest,
                      RequestStatus, utcnow)
from . import capacity, dispatch, trips

RS = RequestStatus
NEXT_STATUS = {"en_route": (RS.accepted, RS.en_route), "on_scene": (RS.en_route, RS.on_scene),
               "transporting": (RS.on_scene, RS.transporting), "arrived": (RS.transporting, RS.arrived)}
TRIP_STATES = [RS.accepted, RS.en_route, RS.on_scene, RS.transporting, RS.arrived]

# ---------------------------------------------------------------- real-device presence (autopilot precedence)
_device_pings: dict[int, float] = {}
_dev_lock = threading.Lock()


def note_device(amb_id: int, now: float | None = None) -> None:
    with _dev_lock:
        _device_pings[amb_id] = time.monotonic() if now is None else now


def device_active(amb_id: int, grace_s: float, now: float | None = None) -> bool:
    """True when a real crew device sent /crew/location for this ambulance within grace_s seconds."""
    with _dev_lock:
        t = _device_pings.get(amb_id)
    return t is not None and ((time.monotonic() if now is None else now) - t) <= grace_s


def forget_devices() -> None:
    with _dev_lock:
        _device_pings.clear()


def _details(extra: dict, actor: str | None) -> dict:
    return {**extra, **({"actor": actor} if actor else {})}


def active_request(db: Session, amb_id: int, include_offer: bool = True) -> EmergencyRequest | None:
    states = ([RS.offered] if include_offer else []) + TRIP_STATES
    return db.execute(select(EmergencyRequest).where(EmergencyRequest.ambulance_id == amb_id,
                                                     EmergencyRequest.status.in_(states))
                      .order_by(EmergencyRequest.id.desc())
                      .execution_options(populate_existing=True)).scalars().first()


# ---------------------------------------------------------------- location (FR6)
def record_location(db: Session, amb: Ambulance, lat: float, lng: float, *, now=None) -> dict:
    """Store a GPS fix, mirror it on the ambulance, recompute the active leg / ETA and publish
    `ambulance.location` (+ `request.route` when the leg changed). Commits. Returns the event payload."""
    now = now or utcnow()
    prev = (amb.lat, amb.lng) if amb.lat is not None else None
    db.add(AmbulanceLocation(ambulance_id=amb.id, lat=lat, lng=lng, recorded_at=now))
    amb.lat, amb.lng, amb.location_updated_at = lat, lng, now
    heading = trips.note_heading(amb.id, prev, (lat, lng))
    req = active_request(db, amb.id)
    data = {"ambulance_id": amb.id, "lat": lat, "lng": lng, "heading_deg": heading, "status": amb.status.value,
            "ts": now.isoformat()}
    if req is not None:
        eta = trips.recompute_eta(db, req)
        leg = trips.legs.get(req.id)
        data.update(request_id=req.id, eta_seconds=eta, phase=leg.phase if leg else None)
    db.commit()
    events.publish("controller", "ambulance.location", data)
    if req is not None:
        events.publish(f"request:{req.id}", "ambulance.location", data)
        if req.destination_hospital_id and req.status in (RS.transporting, RS.arrived):
            events.publish(f"hospital:{req.destination_hospital_id}", "ambulance.location", data)
    return data


def heartbeat(db: Session, amb: Ambulance, now=None) -> None:
    """Keep an idle, simulated ambulance 'genuinely available' (fresh GPS timestamp) without a history row."""
    amb.location_updated_at = now or utcnow()
    db.commit()


# ---------------------------------------------------------------- UC-2 acceptance
def accept_offer(db: Session, amb: Ambulance, request_id: int, user_id: int | None, actor: str | None = None) -> EmergencyRequest:
    with dispatch._LOCK:
        req = dispatch.lock_request(db, request_id)
        if req is None:
            raise HTTPException(404, "Request not found")
        if req.ambulance_id != amb.id:
            raise HTTPException(403, "This request is not assigned to your ambulance")
        attempt = db.execute(select(DispatchAttempt).where(
            DispatchAttempt.request_id == req.id, DispatchAttempt.ambulance_id == amb.id,
            DispatchAttempt.status == AttemptStatus.offered).order_by(DispatchAttempt.id.desc())).scalars().first()
        if req.status != RS.offered or attempt is None:
            raise HTTPException(409, f"No pending offer for this request (status {req.status.value})")
        now = utcnow()
        attempt.status, attempt.responded_at = AttemptStatus.accepted, now
        trips.transition(req, RS.accepted, user_id, actor)
        req.accepted_at = now
        amb.status = AmbulanceStatus.assigned
        trip = trips.get_or_create_trip(db, req)
        trip.ambulance_id, trip.destination_hospital_id, trip.dispatched_at = amb.id, req.destination_hospital_id, req.dispatched_at
        trips.recompute_eta(db, req)
        snap_leg = trips.legs.get(req.id)
        km = snap_leg.distance_km if snap_leg else trips.routing.road_km(trips.ambulance_point(amb), (req.lat, req.lng))
        trip.summary = {**(trip.summary or {}), "to_patient_km": round(km, 2)}
        audit.log(db, "dispatch.accept", "request", req.id, user_id,
                  _details({"ambulance_id": amb.id, "eta_seconds": req.eta_seconds}, actor))
        db.commit()
    trips.publish_status(req)
    return req


# ---------------------------------------------------------------- UC-4 trip progress
def advance_status(db: Session, amb: Ambulance, request_id: int, status: str, user_id: int | None,
                   actor: str | None = None) -> EmergencyRequest:
    req = dispatch.lock_request(db, request_id)
    if req is None:
        raise HTTPException(404, "Request not found")
    if req.ambulance_id != amb.id:
        raise HTTPException(403, "This request is not assigned to your ambulance")
    expected, target = NEXT_STATUS[status]
    if req.status != expected:
        raise HTTPException(409, f"Illegal status transition {req.status.value} -> {target.value}")
    if target == RS.transporting and req.destination_hospital_id is None:
        if capacity.confirm_destination(db, req, user_id=user_id) is None:
            db.commit()  # keep the capacity.query audit row
            raise HTTPException(409, "No destination hospital confirmed; controller must select one")
    now = utcnow()
    trips.transition(req, target, user_id, actor)
    trip = trips.get_or_create_trip(db, req)
    if target == RS.on_scene:
        trip.arrived_scene_at = now
        trip.response_time_seconds = int((trips.aware(now) - trips.aware(req.created_at)).total_seconds())
    elif target == RS.arrived:
        trip.arrived_hospital_at = now
    elif target == RS.transporting:
        trip.destination_hospital_id = req.destination_hospital_id
    amb.status = trips.AMB_FOR_STATUS.get(target, amb.status)
    trips.recompute_eta(db, req)
    if target == RS.transporting:
        leg = trips.legs.get(req.id)
        if leg is not None and leg.phase == "to_hospital":
            trip.summary = {**(trip.summary or {}), "to_hospital_km": round(leg.distance_km, 2)}
    audit.log(db, "trip.status", "request", req.id, user_id,
              _details({"status": target.value, "ambulance_id": amb.id}, actor))
    db.commit()
    trips.publish_status(req)
    if target == RS.transporting and req.destination_hospital_id:
        events.publish(f"hospital:{req.destination_hospital_id}", "hospital.incoming",
                       {"request_id": req.id, "incident_type": req.incident_type.value, "severity": req.severity,
                        "eta_seconds": req.eta_seconds, "ambulance_id": amb.id, "transporting": True})
    return req
