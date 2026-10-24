"""Trip / request lifecycle helpers shared by routers and dispatch (state machine, serialisers, closure)."""
import logging
import threading
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, inspect as sa_inspect, select
from sqlalchemy.orm import Session, object_session

from .. import audit, events, places
from ..geo import haversine_km
from ..models import (Ambulance, AmbulanceLocation, AmbulanceStatus, AttemptStatus, CrewProfile, DispatchAttempt,
                      EmergencyRequest, Hospital, HospitalStaffProfile, PlatformSetting, RequestEvent, RequestStatus,
                      Role, TripRecord, User, utcnow)
from . import analytics, billing, legs, routing

log = logging.getLogger("hads.trips")
RS = RequestStatus

# Forward-only request state machine. Anything not listed is a 409.
TRANSITIONS: dict[RequestStatus, set[RequestStatus]] = {
    RS.received: {RS.matching, RS.awaiting_manual, RS.cancelled, RS.failed},
    RS.matching: {RS.offered, RS.awaiting_manual, RS.cancelled, RS.failed},
    RS.awaiting_manual: {RS.matching, RS.offered, RS.cancelled, RS.failed},
    RS.offered: {RS.accepted, RS.matching, RS.awaiting_manual, RS.cancelled},
    RS.accepted: {RS.en_route, RS.cancelled},
    RS.en_route: {RS.on_scene, RS.cancelled},
    RS.on_scene: {RS.transporting, RS.cancelled},
    RS.transporting: {RS.arrived},
    RS.arrived: {RS.completed},
    RS.completed: set(), RS.cancelled: set(), RS.failed: set(),
}
TERMINAL = {RS.completed, RS.cancelled, RS.failed}
AMB_FOR_STATUS = {RS.accepted: AmbulanceStatus.assigned, RS.en_route: AmbulanceStatus.en_route,
                  RS.on_scene: AmbulanceStatus.on_scene, RS.transporting: AmbulanceStatus.transporting}


def aware(dt: datetime | None) -> datetime | None:
    """SQLite hands back naive datetimes; treat them as UTC."""
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def iso(dt: datetime | None) -> str | None:
    dt = aware(dt)
    return dt.isoformat() if dt else None


def set_status(req: EmergencyRequest, new: RequestStatus, actor: int | None = None, note: str | None = None) -> None:
    """Assign a status WITHOUT state-machine validation (audited overrides only). Every change -- including two
    changes inside one transaction -- lands in the request_events timeline (see models._capture_status_events)."""
    sess = object_session(req)
    if sess is not None and req.id is not None and sa_inspect(req).attrs.status.history.has_changes():
        sess.flush()  # persist the previous, still-unflushed transition as its own timeline row
    req.status = new
    if actor is not None or note is not None:
        req._hads_actor = (actor, note)


def transition(req: EmergencyRequest, new: RequestStatus, actor: int | None = None, note: str | None = None) -> None:
    if new not in TRANSITIONS[req.status]:
        raise HTTPException(409, f"Illegal status transition {req.status.value} -> {new.value}")
    set_status(req, new, actor, note)


def get_setting(db: Session, key: str, default):
    """Platform parameter (admin-editable) with fallback to config. Accepts {'value': x} or raw x."""
    try:
        row = db.get(PlatformSetting, key)
        if row is not None and row.value is not None:
            v = row.value.get("value", default) if isinstance(row.value, dict) else row.value
            return type(default)(v)
    except Exception:  # noqa: BLE001
        pass
    return default


# ---------------------------------------------------------------- serialisers
def hospital_brief(h: Hospital | None) -> dict | None:
    return {"id": h.id, "name": h.name, "lat": h.lat, "lng": h.lng} if h else None


def timeline(db: Session, request_id: int) -> list[dict]:
    rows = db.execute(select(RequestEvent.status, RequestEvent.at).where(RequestEvent.request_id == request_id)
                      .order_by(RequestEvent.at, RequestEvent.id)).all()
    return [{"status": st, "at": iso(at)} for st, at in rows]


def request_out(db: Session, req: EmergencyRequest, hide_phone: bool = False) -> dict:
    """RequestOut (v1) + v2 `timeline` and `zone_label`. hide_phone: crew sees no caller phone before accepting."""
    amb = db.get(Ambulance, req.ambulance_id) if req.ambulance_id else None
    hosp = db.get(Hospital, req.destination_hospital_id) if req.destination_hospital_id else None
    attempts = []
    for a in db.execute(select(DispatchAttempt).where(DispatchAttempt.request_id == req.id)
                        .order_by(DispatchAttempt.id)).scalars():
        ab = db.get(Ambulance, a.ambulance_id)
        attempts.append({"ambulance_id": a.ambulance_id, "registration_number": ab.registration_number if ab else None,
                         "rank": a.rank, "status": a.status.value, "eta_seconds": a.eta_seconds})
    return {"id": req.id, "status": req.status.value, "incident_type": req.incident_type.value,
            "severity": req.severity, "patient_age_group": req.patient_age_group or "unknown", "lat": req.lat, "lng": req.lng, "address": req.address, "notes": req.notes,
            "channel": req.channel, "requester_id": req.requester_id, "caller_name": req.caller_name,
            "caller_phone": None if hide_phone else req.caller_phone,
            "ambulance": {"id": amb.id, "registration_number": amb.registration_number, "kind": amb.kind} if amb else None,
            "destination_hospital": hospital_brief(hosp), "eta_seconds": req.eta_seconds,
            "created_at": iso(req.created_at), "dispatched_at": iso(req.dispatched_at),
            "accepted_at": iso(req.accepted_at), "completed_at": iso(req.completed_at),
            "match_duration_ms": req.match_duration_ms, "attempts": attempts,
            "zone_label": places.zone_label(req.lat, req.lng), "timeline": timeline(db, req.id)}


def user_ambulance_id(db: Session, user: User) -> int | None:
    p = db.get(CrewProfile, user.id)
    return p.ambulance_id if p else None


def user_hospital_id(db: Session, user: User) -> int | None:
    p = db.get(HospitalStaffProfile, user.id)
    return p.hospital_id if p else None


def can_view(db: Session, user: User, req: EmergencyRequest) -> bool:
    if user.role in (Role.controller, Role.admin, Role.authority):
        return True
    if user.role == Role.requester:
        return req.requester_id == user.id
    if user.role == Role.crew:
        amb = user_ambulance_id(db, user)
        return amb is not None and req.ambulance_id == amb
    if user.role == Role.hospital_staff:
        h = user_hospital_id(db, user)
        return h is not None and req.destination_hospital_id == h
    return False


def crew_user(db: Session, amb_id: int | None) -> User | None:
    """The (first active) crew member assigned to an ambulance."""
    if not amb_id:
        return None
    return db.execute(select(User).join(CrewProfile, CrewProfile.user_id == User.id)
                      .where(CrewProfile.ambulance_id == amb_id, User.is_active.is_(True))
                      .order_by(User.id).limit(1)).scalar_one_or_none()


def initials(name: str | None) -> str:
    parts = [p for p in (name or "").replace(".", " ").split() if p[:1].isalpha()]
    if not parts:
        return ""
    return (parts[0][0] + (parts[-1][0] if len(parts) > 1 else "")).upper()


def crew_out(user: User | None, with_phone: bool) -> dict | None:
    if user is None:
        return None
    return {"name": user.name, "phone": user.phone if with_phone else None, "initials": initials(user.name)}


def publish_status(req: EmergencyRequest, extra: dict | None = None) -> None:
    data = {"request_id": req.id, "status": req.status.value, "ambulance_id": req.ambulance_id,
            "destination_hospital_id": req.destination_hospital_id, "eta_seconds": req.eta_seconds}
    data.update(extra or {})
    events.publish(f"request:{req.id}", "request.status", data)
    events.publish("controller", "request.status", data)
    if req.ambulance_id:
        events.publish(f"crew:{req.ambulance_id}", "request.status", data)


# ---------------------------------------------------------------- ambulance helpers
def ambulance_point(amb: Ambulance) -> tuple[float, float]:
    if amb.lat is not None and amb.lng is not None:
        return (amb.lat, amb.lng)
    return (amb.station.lat, amb.station.lng)


def release_ambulance(db: Session, amb_id: int | None) -> None:
    amb = db.get(Ambulance, amb_id) if amb_id else None
    if amb and amb.status in (AmbulanceStatus.assigned, AmbulanceStatus.en_route, AmbulanceStatus.on_scene,
                              AmbulanceStatus.transporting):
        amb.status = AmbulanceStatus.available


_headings: dict[int, float] = {}
_heading_lock = threading.Lock()


def note_heading(amb_id: int, prev: tuple[float, float] | None, new: tuple[float, float]) -> float | None:
    """Update the in-memory heading from a movement (>= 3 m); returns the current heading."""
    with _heading_lock:
        if prev is not None and prev[0] is not None and prev[1] is not None \
                and haversine_km(prev[0], prev[1], new[0], new[1]) >= 0.003:
            _headings[amb_id] = round(routing.bearing(prev, new), 1)
        return _headings.get(amb_id)


def heading_deg(db: Session, amb_id: int) -> float | None:
    """Heading from the last two distinct GPS points (memory first, then the location history)."""
    with _heading_lock:
        if amb_id in _headings:
            return _headings[amb_id]
    rows = db.execute(select(AmbulanceLocation.lat, AmbulanceLocation.lng).where(AmbulanceLocation.ambulance_id == amb_id)
                      .order_by(AmbulanceLocation.id.desc()).limit(10)).all()
    for i in range(1, len(rows)):
        if haversine_km(rows[i][0], rows[i][1], rows[0][0], rows[0][1]) >= 0.003:
            h = round(routing.bearing((rows[i][0], rows[i][1]), (rows[0][0], rows[0][1])), 1)
            with _heading_lock:
                _headings[amb_id] = h
            return h
    return None


def route_snapshot(db: Session, req: EmergencyRequest, publish: bool = True) -> dict | None:
    """Remaining leg {phase, polyline, distance_km, eta_seconds} from the ambulance's current position, or None."""
    if not req.ambulance_id or req.status in TERMINAL:
        legs.drop(req.id)
        return None
    amb = db.get(Ambulance, req.ambulance_id)
    if amb is None:
        return None
    return legs.snapshot(db, req, ambulance_point(amb), publish=publish)


def recompute_eta(db: Session, req: EmergencyRequest) -> int | None:
    """Phase-aware ETA along the active road leg: to patient before pickup, to hospital while transporting."""
    if not req.ambulance_id:
        return req.eta_seconds
    if req.status in (RS.on_scene, RS.arrived):
        req.eta_seconds = 0
        if req.status == RS.on_scene:
            legs.drop(req.id)
        return 0
    if req.status in (RS.offered, RS.accepted, RS.en_route, RS.transporting):
        snap = route_snapshot(db, req)
        if snap is not None:
            req.eta_seconds = snap["eta_seconds"]
    return req.eta_seconds


def latest_path(db: Session, amb_id: int, limit: int = 50) -> list[list[float]]:
    rows = db.execute(select(AmbulanceLocation).where(AmbulanceLocation.ambulance_id == amb_id)
                      .order_by(AmbulanceLocation.id.desc()).limit(limit)).scalars().all()
    return [[r.lat, r.lng] for r in reversed(rows)]


def get_or_create_trip(db: Session, req: EmergencyRequest) -> TripRecord:
    trip = db.execute(select(TripRecord).where(TripRecord.request_id == req.id)).scalar_one_or_none()
    if trip is None:
        trip = TripRecord(request_id=req.id, ambulance_id=req.ambulance_id,
                          destination_hospital_id=req.destination_hospital_id,
                          dispatched_at=req.dispatched_at, summary={})
        db.add(trip)
        db.flush()
    return trip


# ---------------------------------------------------------------- closure (UC-4)
def close_trip(db: Session, req: EmergencyRequest, user_id: int | None, *, manual: bool = False,
               reason: str | None = None, actor_note: str | None = None) -> TripRecord:
    """Complete the trip: handover timestamp, free ambulance, release bed hold, bill + analytics hooks."""
    from . import capacity  # local import: capacity imports trips
    if manual:
        if req.status in TERMINAL or not req.ambulance_id or req.status in (RS.received, RS.matching, RS.awaiting_manual):
            raise HTTPException(409, "No active trip to close for this request")
    elif req.status != RS.arrived:
        raise HTTPException(409, f"Handover requires status 'arrived' (is '{req.status.value}')")
    now = utcnow()
    trip = get_or_create_trip(db, req)
    # state machine already validated above (manual close = UC-4 E1 override)
    set_status(req, RS.completed, user_id, actor_note or ("manual_close" if manual else "handover"))
    req.completed_at = now
    trip.handover_time = now
    trip.handover_confirmed_by = user_id
    trip.closed_manually = manual
    trip.ambulance_id = req.ambulance_id
    trip.destination_hospital_id = req.destination_hospital_id
    trip.dispatched_at = trip.dispatched_at or req.dispatched_at
    if trip.arrived_scene_at and not trip.response_time_seconds:
        trip.response_time_seconds = int((aware(trip.arrived_scene_at) - aware(req.created_at)).total_seconds())
    summ = dict(trip.summary or {})
    km = float(summ.get("to_patient_km", 0.0))
    if summ.get("to_hospital_km") is not None:
        km += float(summ["to_hospital_km"])
    elif req.destination_hospital_id:
        h = db.get(Hospital, req.destination_hospital_id)
        km += routing.road_km((req.lat, req.lng), (h.lat, h.lng))
    trip.distance_km = round(km, 2)
    trip.summary = {**summ, "severity": req.severity, "incident_type": req.incident_type.value,
                    "redirect_avoided": bool(not manual and capacity.redirect_avoided(db, req)),
                    **({"manual_close_reason": reason} if manual else {}),
                    **({"closed_by": actor_note} if actor_note else {})}
    release_ambulance(db, req.ambulance_id)
    capacity.release_reservation(db, req, reason="manual_close" if manual else "handover", consumed=not manual)
    audit.log(db, "trip.close_manual" if manual else "trip.handover", "request", req.id, user_id,
              {"trip_id": trip.id, "hospital_id": req.destination_hospital_id,
               "ambulance_id": req.ambulance_id, "reason": reason, **({"actor": actor_note} if actor_note else {})})
    db.flush()
    for hook, label in ((lambda: analytics.record_outcome(db, req, trip), "analytics.record_outcome"),
                        (lambda: billing.create_bill_for_trip(db, trip), "billing.create_bill_for_trip")):
        try:  # downstream integrations must never block closing a trip
            with db.begin_nested():
                hook()
        except Exception:  # noqa: BLE001
            log.exception("%s failed for trip %s", label, trip.id)
    from . import notify
    notify.notify_requester(db, req, "request.completed", "Trip completed",
                            "Handover is done. Your bill and trip summary are ready.", {"trip_id": trip.id})
    db.commit()
    legs.drop(req.id)
    data = {"request_id": req.id, "trip_id": trip.id, "closed_manually": manual}
    events.publish(f"request:{req.id}", "trip.closed", data)
    events.publish("controller", "trip.closed", data)
    if req.destination_hospital_id:
        events.publish(f"hospital:{req.destination_hospital_id}", "trip.closed", data)
    publish_status(req)
    return trip


def cancel_request(db: Session, req: EmergencyRequest, user_id: int | None, reason: str | None = None) -> None:
    from . import capacity
    if req.status in TERMINAL:
        raise HTTPException(409, f"Request already {req.status.value}")
    if req.status in (RS.transporting, RS.arrived):
        raise HTTPException(409, "Cannot cancel once the patient is on board")
    transition(req, RS.cancelled, user_id, (reason or "")[:120] or None)
    for a in db.execute(select(DispatchAttempt).where(
            DispatchAttempt.request_id == req.id,
            DispatchAttempt.status.in_([AttemptStatus.offered, AttemptStatus.accepted]))).scalars():
        a.status = AttemptStatus.cancelled
        a.responded_at = utcnow()
    release_ambulance(db, req.ambulance_id)
    capacity.release_reservation(db, req, reason="cancelled")
    audit.log(db, "request.cancel", "request", req.id, user_id, {"reason": reason, "ambulance_id": req.ambulance_id})
    db.commit()
    legs.drop(req.id)
    publish_status(req)


# ---------------------------------------------------------------- timeline backfill (v2 section 3)
def _synth_events(req: EmergencyRequest, trip: TripRecord | None) -> list[tuple[str, datetime]]:
    """Plausible timeline for a request created without one (seed data / rows from before v2)."""
    c = aware(req.created_at) or utcnow()
    ev = [("received", c)]
    if req.status == RS.cancelled:
        return ev + [("cancelled", c + timedelta(minutes=2))]
    if req.status == RS.failed:
        return ev + [("failed", c + timedelta(minutes=1))]
    if req.status == RS.received:
        return ev
    ev.append(("matching", c + timedelta(milliseconds=20)))
    if req.status == RS.awaiting_manual:
        return ev + [("awaiting_manual", c + timedelta(seconds=1))]
    d = aware(req.dispatched_at)
    if d:
        ev.append(("offered", d))
    a = aware(req.accepted_at)
    if a:
        ev += [("accepted", a), ("en_route", a + timedelta(seconds=5))]
    if trip is not None:
        scene, hosp = aware(trip.arrived_scene_at), aware(trip.arrived_hospital_at)
        if scene:
            ev.append(("on_scene", scene))
            if hosp:
                ev.append(("transporting", scene + min(timedelta(seconds=300), (hosp - scene) / 3)))
        if hosp:
            ev.append(("arrived", hosp))
    done = aware(req.completed_at) or (aware(trip.handover_time) if trip else None)
    if req.status == RS.completed and done:
        ev.append(("completed", done))
    return sorted(ev, key=lambda e: e[1])


def backfill_events(db: Session) -> int:
    """Synthesize timelines for requests that have none (seeded / pre-v2 rows). Idempotent. Caller commits."""
    have = select(RequestEvent.request_id).distinct()
    rows = db.execute(select(EmergencyRequest).where(EmergencyRequest.id.notin_(have))).scalars().all()
    if not rows:
        return 0
    tmap = {t.request_id: t for t in db.execute(select(TripRecord).where(
        TripRecord.request_id.in_([r.id for r in rows]))).scalars()}
    n = 0
    for r in rows:
        for st, at in _synth_events(r, tmap.get(r.id)):
            db.add(RequestEvent(request_id=r.id, status=st, at=at, note="backfill"))
            n += 1
    db.flush()
    return n


def stats_today(db: Session, amb_id: int) -> dict:
    """Crew KPIs for the current IST day: trips closed, km driven on them, minutes online (first GPS ping -> now)."""
    ist = timezone(timedelta(hours=5, minutes=30))
    start = datetime.now(ist).replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)
    trips_n, km = db.execute(select(func.count(TripRecord.id), func.coalesce(func.sum(TripRecord.distance_km), 0.0))
                             .where(TripRecord.ambulance_id == amb_id, TripRecord.handover_time >= start)).one()
    first = db.scalar(select(func.min(AmbulanceLocation.recorded_at)).where(
        AmbulanceLocation.ambulance_id == amb_id, AmbulanceLocation.recorded_at >= start))
    online = int((utcnow() - aware(first)).total_seconds() // 60) if first else 0
    return {"trips": int(trips_n or 0), "distance_km": round(float(km or 0.0), 2), "online_minutes": max(0, online)}
