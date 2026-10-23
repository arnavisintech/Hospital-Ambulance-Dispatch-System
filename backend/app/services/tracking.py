"""Tracking payloads (v2 sections 2 and 4): authenticated `/requests/{id}/tracking` and public share view."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import places
from ..models import (Ambulance, BillingRecord, EmergencyRequest, Hospital, RequestStatus, Role, TripRecord, User)
from . import capacity, sharing, trips

RS = RequestStatus


def _trip(db: Session, req: EmergencyRequest) -> TripRecord | None:
    return db.execute(select(TripRecord).where(TripRecord.request_id == req.id)).scalar_one_or_none()


def feedback_of(trip: TripRecord | None) -> dict | None:
    fb = (trip.summary or {}).get("feedback") if trip else None
    return {"rating": fb.get("rating"), "comment": fb.get("comment")} if isinstance(fb, dict) else None


def bill_of(db: Session, trip: TripRecord | None) -> dict | None:
    if trip is None:
        return None
    b = db.execute(select(BillingRecord).where(BillingRecord.trip_id == trip.id)).scalar_one_or_none()
    if b is None:
        return None
    return {"id": b.id, "amount": float(b.amount), "payment_status": b.payment_status.value,
            "insurance_claim_status": b.insurance_claim_status}


def ambulance_live(db: Session, amb: Ambulance | None) -> dict | None:
    if amb is None:
        return None
    return {"id": amb.id, "registration_number": amb.registration_number, "kind": amb.kind, "lat": amb.lat,
            "lng": amb.lng, "status": amb.status.value, "updated_at": trips.iso(amb.location_updated_at),
            "heading_deg": trips.heading_deg(db, amb.id)}


def hospital_detail(db: Session, req: EmergencyRequest, h: Hospital | None) -> dict | None:
    if h is None:
        return None
    return {"id": h.id, "name": h.name, "lat": h.lat, "lng": h.lng, "address": h.address,
            "available_beds": h.available_beds, "available_icu": h.available_icu,
            "reserved": capacity.reserved_kind(db, req.id), "phone": None}  # no phone column on Hospital yet


def live_route(db: Session, req: EmergencyRequest) -> dict | None:
    if req.status in trips.TERMINAL or req.status in (RS.received, RS.matching, RS.awaiting_manual):
        return None
    snap = trips.route_snapshot(db, req)
    if snap is None and req.status == RS.on_scene:  # parked at the patient: no leg until transport starts
        return {"phase": None, "polyline": [], "distance_km": 0.0, "eta_seconds": 0}
    return snap


def private_payload(db: Session, req: EmergencyRequest, viewer: User) -> dict:
    amb = db.get(Ambulance, req.ambulance_id) if req.ambulance_id else None
    hosp = db.get(Hospital, req.destination_hospital_id) if req.destination_hospital_id else None
    trip = _trip(db, req)
    is_owner = viewer.role == Role.requester and req.requester_id == viewer.id
    phone_ok = is_owner or viewer.role in (Role.controller, Role.admin, Role.hospital_staff)
    share_ok = is_owner or viewer.role in (Role.controller, Role.admin)
    hide_caller = viewer.role == Role.crew and req.status == RS.offered
    route = live_route(db, req)
    return {"request": trips.request_out(db, req, hide_phone=hide_caller),
            "ambulance": ambulance_live(db, amb),
            "hospital": hospital_detail(db, req, hosp),
            "eta_seconds": req.eta_seconds,
            "path": trips.latest_path(db, amb.id) if amb else [],
            "route": route,
            "crew": trips.crew_out(trips.crew_user(db, amb.id), with_phone=phone_ok) if amb else None,
            "timeline": trips.timeline(db, req.id),
            "share": sharing.link_out(sharing.get_link(db, req.id)) if share_ok else None,
            "bill": bill_of(db, trip) if req.status == RS.completed else None,
            "feedback": feedback_of(trip)}


def public_payload(db: Session, req: EmergencyRequest) -> dict:
    """No phones, no names, coarse patient location (3 decimals ~ 110 m) -- also for the ambulance position and
    route geometry whenever they fall within sharing.PRIVACY_RADIUS_M of the patient."""
    amb = db.get(Ambulance, req.ambulance_id) if req.ambulance_id else None
    hosp = db.get(Hospital, req.destination_hospital_id) if req.destination_hospital_id else None
    patient = (req.lat, req.lng)
    route = live_route(db, req)
    if route is not None:
        route = {**route, "polyline": sharing.coarsen_polyline(route.get("polyline"), patient)}
    amb_pos = sharing.coarsen_point(amb.lat, amb.lng, patient) if amb else (None, None)
    return {"status": req.status.value,
            "timeline": trips.timeline(db, req.id),
            "ambulance": {"registration_number": amb.registration_number, "lat": amb_pos[0], "lng": amb_pos[1],
                          "heading_deg": trips.heading_deg(db, amb.id)} if amb else None,
            "eta_seconds": req.eta_seconds,
            "route": route,
            "hospital": {"name": hosp.name, "lat": hosp.lat, "lng": hosp.lng} if hosp else None,
            "patient_area": {"label": places.zone_label(req.lat, req.lng), "lat": round(req.lat, 3),
                             "lng": round(req.lng, 3)},
            "created_at": trips.iso(req.created_at), "completed_at": trips.iso(req.completed_at)}
