"""Dispatch engine (FR4, UC-2).

Ranking uses ONLY routed ETA, ambulance type vs severity and (as tie-break only) predicted zone risk.
Nothing about the requester (identity, phone, name, address) is read here -- STRQ1.

Concurrency: a process-wide lock serialises the select-and-assign critical section; on PostgreSQL the
chosen ambulance row is additionally locked with FOR UPDATE SKIP LOCKED and its status re-checked, so
two workers can never offer the same ambulance. Every decision is written to the audit chain (NFR7).
"""
import logging
import threading
import time
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit, db as dbmod, events
from ..config import get_settings
from ..geo import haversine_km, zone_of
from ..models import (Ambulance, AmbulanceStatus, AttemptStatus, DarkStation, DispatchAttempt, EmergencyRequest, Hospital,
                      RequestStatus, Role, utcnow)
from . import analytics, capacity, notify, routing, trips
from .trips import aware

log = logging.getLogger("hads.dispatch")
RS = RequestStatus

_LOCK = threading.RLock()
ALS_BONUS_S = 240      # severity >= 4: an ALS unit is worth up to 4 extra minutes of travel
ALS_PENALTY_S = 120    # severity <= 2: keep ALS units free for critical calls


def _pg(db: Session) -> bool:
    return db.get_bind().dialect.name == "postgresql"


def lock_request(db: Session, request_id: int) -> EmergencyRequest | None:
    q = select(EmergencyRequest).where(EmergencyRequest.id == request_id).execution_options(populate_existing=True)
    if _pg(db):
        q = q.with_for_update()
    return db.execute(q).scalar_one_or_none()


def _lock_ambulance(db: Session, amb_id: int) -> Ambulance | None:
    q = select(Ambulance).where(Ambulance.id == amb_id).execution_options(populate_existing=True)
    if _pg(db):
        q = q.with_for_update(skip_locked=True)
    return db.execute(q).scalar_one_or_none()


def _attempted_ids(db: Session, request_id: int) -> set[int]:
    return set(db.execute(select(DispatchAttempt.ambulance_id).where(DispatchAttempt.request_id == request_id)).scalars())


def rank_candidates(db: Session, req: EmergencyRequest, exclude: set[int] | None = None,
                    now: datetime | None = None, quick: bool = False) -> list[dict]:
    """Eligible ambulances ranked by effective road-time ETA (FR4). Pure read; no side effects.
    quick=True uses the offline road-distance estimate instead of the router (advisory figures only)."""
    s = get_settings()
    now = now or utcnow()
    exclude = exclude or set()
    try:
        risk = analytics.get_zone_risk(db) or {}
    except Exception:  # noqa: BLE001 - prediction is advisory only
        risk = {}
    rows = db.execute(select(Ambulance)
                      .join(DarkStation, DarkStation.id == Ambulance.station_id)
                      .join(Hospital, Hospital.id == DarkStation.hospital_id)
                      .where(Ambulance.status == AmbulanceStatus.available, Ambulance.staffed.is_(True),
                             Hospital.partner_verified.is_(True))   # STRQ2: pending/suspended partners never dispatch
                      .execution_options(populate_existing=True)).scalars().all()
    eligible = []
    for a in rows:
        if a.id in exclude or a.lat is None or a.lng is None or a.location_updated_at is None:
            continue
        if (now - aware(a.location_updated_at)).total_seconds() > s.location_stale_s:
            continue  # stale GPS: not "genuinely available"
        km = haversine_km(a.lat, a.lng, req.lat, req.lng)
        if km > s.max_search_radius_km:
            continue
        eligible.append((a, km))
    # ONE routing call for all candidates (OSRM /table: sources = ambulances, destination = patient) -- NFR1
    if quick:
        etas = [routing.quick_eta((a.lat, a.lng), (req.lat, req.lng)) for a, _km in eligible]
    else:
        etas = routing.eta_many([(a.lat, a.lng) for a, _km in eligible], (req.lat, req.lng))
    out = []
    for (a, km), eta in zip(eligible, etas):
        eff = eta
        if req.severity >= 4 and a.kind == "ALS":
            eff -= ALS_BONUS_S
        elif req.severity <= 2 and a.kind == "ALS":
            eff += ALS_PENALTY_S
        out.append({"ambulance": a, "ambulance_id": a.id, "registration_number": a.registration_number,
                    "kind": a.kind, "station_id": a.station_id, "station_name": a.station.name if a.station else None,
                    "eta_seconds": eta, "effective_eta": eff,
                    "distance_km": round(km, 2), "zone_risk": float(risk.get(zone_of(a.lat, a.lng), 0.0))})
    out.sort(key=lambda r: (r["effective_eta"], r["zone_risk"], r["ambulance_id"]))  # risk: tie-break only
    for i, r in enumerate(out, 1):
        r["rank"] = i
    return out


def candidate_out(rec: dict) -> dict:
    return {k: rec.get(k) for k in ("ambulance_id", "registration_number", "kind", "station_id", "station_name",
                                    "eta_seconds", "effective_eta", "distance_km", "rank")}


def _escalate(db: Session, req: EmergencyRequest, reason: str, silent: bool = False) -> None:
    if req.status != RS.awaiting_manual:
        trips.transition(req, RS.awaiting_manual)
    if silent:
        db.commit()
        return
    audit.log(db, "dispatch.escalate", "request", req.id, None,
              {"reason": reason, "severity": req.severity, "incident_type": req.incident_type.value})
    notify.notify_role(db, Role.controller, "dispatch.escalated", f"Request #{req.id} needs a manual decision",
                       f"{reason.replace('_', ' ')} · severity {req.severity}", {"request_id": req.id})
    db.commit()
    data = {"request_id": req.id, "reason": reason, "severity": req.severity, "lat": req.lat, "lng": req.lng}
    events.publish("controller", "dispatch.escalated", data)
    events.publish(f"request:{req.id}", "dispatch.escalated", {"request_id": req.id, "reason": reason})
    trips.publish_status(req)


def _dispatch_one(db: Session, req: EmergencyRequest, started: float, silent_if_none: bool = False) -> bool:
    """Offer `req` to the best available ambulance. Caller holds _LOCK. Returns True when offered."""
    req = lock_request(db, req.id)   # fresh state: it may have been cancelled while it waited in the drain
    if req is None or req.status not in (RS.received, RS.matching):
        return False
    if req.status == RS.received:
        trips.transition(req, RS.matching)
        db.commit()
    prior = _attempted_ids(db, req.id)
    cands = rank_candidates(db, req, prior)
    chosen = None
    for c in cands:
        amb = _lock_ambulance(db, c["ambulance_id"])
        if amb is not None and amb.status == AmbulanceStatus.available and amb.staffed:
            chosen = c
            break
    # Re-check after the (slow) routing call: a cancel that landed meanwhile wins; never offer a cancelled call.
    db.refresh(req, attribute_names=["status"])
    if req.status not in (RS.received, RS.matching):
        return False
    if chosen is None:
        _escalate(db, req, "no_available_ambulance", silent=silent_if_none)
        return False
    amb = chosen["ambulance"]
    amb.status = AmbulanceStatus.assigned
    trips.transition(req, RS.offered)
    req.ambulance_id = amb.id
    req.eta_seconds = chosen["eta_seconds"]
    req.dispatched_at = utcnow()
    if req.match_duration_ms is None:
        req.match_duration_ms = int((time.perf_counter() - started) * 1000)
    db.add(DispatchAttempt(request_id=req.id, ambulance_id=amb.id, rank=len(prior) + 1,
                           eta_seconds=chosen["eta_seconds"], status=AttemptStatus.offered))
    audit.log(db, "dispatch.assign", "request", req.id, None, {
        "ambulance_id": amb.id, "eta_seconds": chosen["eta_seconds"], "severity": req.severity,
        "match_duration_ms": req.match_duration_ms, "attempt": len(prior) + 1,
        "ranking": [candidate_out(c) for c in cands[:5]]})
    no_hospital = False
    if req.destination_hospital_id is None:
        no_hospital = capacity.confirm_destination(db, req) is None
    notify.notify_crew(db, amb.id, "dispatch.offer", "New emergency request",
                       f"{req.incident_type.value.title()} · severity {req.severity}", {"request_id": req.id})
    db.commit()
    timeout = trips.get_setting(db, "crew_ack_timeout_s", get_settings().crew_ack_timeout_s)
    events.publish(f"crew:{amb.id}", "dispatch.offer", {
        "request_id": req.id, "incident_type": req.incident_type.value, "severity": req.severity,
        "patient_age_group": req.patient_age_group or "unknown",
        "lat": req.lat, "lng": req.lng, "address": req.address, "eta_seconds": req.eta_seconds,
        "ack_timeout_s": timeout, "destination_hospital_id": req.destination_hospital_id})
    trips.publish_status(req)
    if no_hospital:
        audit.log(db, "dispatch.escalate", "request", req.id, None, {"reason": "no_eligible_hospital"})
        db.commit()
        events.publish("controller", "dispatch.escalated",
                       {"request_id": req.id, "reason": "no_eligible_hospital", "severity": req.severity})
    return True


_kick = threading.Event()   # "there may be requests waiting for a dispatch decision"


def run_dispatch(request_id: int | None = None) -> None:
    """Dispatch every waiting request (received / matching), highest severity first. Never parks the caller: if another
    thread is already dispatching, this one just flags new work and returns, and that thread drains it before letting go
    of the lock (an SOS burst would otherwise tie up every server thread waiting on _LOCK). The background watcher calls
    this every tick as a sweep, so a request whose own dispatch task never ran is still handled. `request_id` is the
    request that triggered the call (kept for callers and logs; every waiting request is handled)."""
    _kick.set()
    while _kick.is_set():
        if not _LOCK.acquire(blocking=False):
            return   # the current holder re-checks _kick after releasing and drains our request too
        try:
            _kick.clear()
            _drain()
        finally:
            _LOCK.release()


def _drain() -> None:
    started = time.perf_counter()
    with dbmod.SessionLocal() as db:
        pending = db.execute(select(EmergencyRequest).where(EmergencyRequest.status.in_([RS.received, RS.matching]))
                             .order_by(EmergencyRequest.severity.desc(), EmergencyRequest.created_at, EmergencyRequest.id)
                             .execution_options(populate_existing=True)).scalars().all()
        for r in pending:
            try:
                _dispatch_one(db, r, started)
            except Exception:  # noqa: BLE001 - one bad request must not block the others
                db.rollback()
                log.exception("dispatch failed for request %s", r.id)


def retry_escalated() -> list[int]:
    """Silently re-try awaiting_manual requests (severity first) once capacity frees up."""
    done = []
    started = time.perf_counter()
    with dbmod.SessionLocal() as db, _LOCK:
        rows = db.execute(select(EmergencyRequest).where(EmergencyRequest.status == RS.awaiting_manual)
                          .order_by(EmergencyRequest.severity.desc(), EmergencyRequest.created_at)
                          .execution_options(populate_existing=True)).scalars().all()
        for r in rows:
            if not rank_candidates(db, r, _attempted_ids(db, r.id)):
                continue
            trips.transition(r, RS.matching)
            db.flush()   # _dispatch_one re-reads the request; it must see this transition
            if _dispatch_one(db, r, started, silent_if_none=True):
                done.append(r.id)
    return done


def release_offer(db: Session, req: EmergencyRequest, status: AttemptStatus, user_id: int | None,
                  reason: str | None) -> bool:
    """Crew reject / ack timeout: free the ambulance and put the request back to matching. Caller then re-dispatches."""
    attempt = db.execute(select(DispatchAttempt).where(DispatchAttempt.request_id == req.id,
                                                       DispatchAttempt.status == AttemptStatus.offered)
                         .order_by(DispatchAttempt.id.desc())).scalars().first()
    if req.status != RS.offered or attempt is None:
        return False
    attempt.status = status
    attempt.responded_at = utcnow()
    trips.release_ambulance(db, attempt.ambulance_id)
    req.ambulance_id = None
    trips.legs.drop(req.id)
    trips.transition(req, RS.matching, user_id, status.value)
    audit.log(db, f"dispatch.{status.value}", "request", req.id, user_id,
              {"ambulance_id": attempt.ambulance_id, "reason": reason, "attempt_rank": attempt.rank})
    if status == AttemptStatus.timeout:  # UC-2 E1: flag the non-response for controller review
        amb = db.get(Ambulance, attempt.ambulance_id)
        notify.notify_role(db, Role.controller, "dispatch.no_response", f"No response to request #{req.id}",
                           f"Crew of {amb.registration_number if amb else f'ambulance #{attempt.ambulance_id}'} "
                           "did not acknowledge in time · reassigned",
                           {"request_id": req.id, "ambulance_id": attempt.ambulance_id})
    db.commit()
    trips.publish_status(req, {"reassigning": True})
    return True


def expire_stale_offers(now: datetime | None = None) -> list[int]:
    """UC-2 E1: offers not acknowledged within crew_ack_timeout_s are reassigned to the next-ranked unit."""
    now = now or utcnow()
    expired: list[int] = []
    with dbmod.SessionLocal() as db:
        timeout = trips.get_setting(db, "crew_ack_timeout_s", get_settings().crew_ack_timeout_s)
        ids = db.execute(select(EmergencyRequest.id).where(EmergencyRequest.status == RS.offered)).scalars().all()
        for rid in ids:
            with _LOCK:
                req = lock_request(db, rid)
                att = db.execute(select(DispatchAttempt).where(DispatchAttempt.request_id == rid,
                                                               DispatchAttempt.status == AttemptStatus.offered)
                                 .order_by(DispatchAttempt.id.desc())).scalars().first()
                if req is None or att is None or req.status != RS.offered:
                    continue
                if (now - aware(att.offered_at)).total_seconds() < timeout:
                    continue
                if release_offer(db, req, AttemptStatus.timeout, None, "crew acknowledgement timeout"):
                    expired.append(rid)
    for rid in expired:
        run_dispatch(rid)
    return expired


def assign_manual(db: Session, req: EmergencyRequest, amb_id: int, user_id: int, reason: str | None = None) -> EmergencyRequest:
    """Controller override / cross-station reassignment (UC-2 A1). Audited. Caller has authorised the user."""
    with _LOCK:
        req = lock_request(db, req.id)
        if req.status not in (RS.received, RS.matching, RS.awaiting_manual, RS.offered, RS.accepted, RS.en_route):
            raise trips.HTTPException(409, f"Cannot assign an ambulance while request is {req.status.value}")
        amb = _lock_ambulance(db, amb_id)
        if amb is None:
            raise trips.HTTPException(404, "Ambulance not found")
        if amb.id == req.ambulance_id:
            raise trips.HTTPException(409, "Ambulance already assigned to this request")
        if amb.status != AmbulanceStatus.available or not amb.staffed:
            raise trips.HTTPException(409, f"Ambulance not available (status {amb.status.value}, staffed={amb.staffed})")
        st = db.get(DarkStation, amb.station_id)
        if st is None or not db.get(Hospital, st.hospital_id).partner_verified:
            raise trips.HTTPException(409, "This ambulance belongs to a hospital that is not a verified partner")
        previous = req.ambulance_id
        if previous:
            for a in db.execute(select(DispatchAttempt).where(
                    DispatchAttempt.request_id == req.id,
                    DispatchAttempt.status.in_([AttemptStatus.offered, AttemptStatus.accepted]))).scalars():
                a.status = AttemptStatus.cancelled
                a.responded_at = utcnow()
            trips.release_ambulance(db, previous)
            trips.legs.drop(req.id)
        prior = _attempted_ids(db, req.id)
        eta = routing.eta_seconds(trips.ambulance_point(amb), (req.lat, req.lng))
        amb.status = AmbulanceStatus.assigned
        trips.set_status(req, RS.offered, user_id, "controller_override")  # deliberately bypasses the sequence (audited)
        req.ambulance_id = amb.id
        req.eta_seconds = eta
        req.dispatched_at = utcnow()
        req.accepted_at = None
        db.add(DispatchAttempt(request_id=req.id, ambulance_id=amb.id, rank=len(prior) + 1, eta_seconds=eta,
                               status=AttemptStatus.offered))
        audit.log(db, "dispatch.override", "request", req.id, user_id,
                  {"ambulance_id": amb.id, "previous_ambulance_id": previous, "eta_seconds": eta, "reason": reason})
        no_hospital = req.destination_hospital_id is None and capacity.confirm_destination(db, req, user_id=user_id) is None
        notify.notify_crew(db, amb.id, "dispatch.offer", "New emergency request (assigned by control)",
                           f"{req.incident_type.value.title()} · severity {req.severity}", {"request_id": req.id})
        db.commit()
        events.publish(f"crew:{amb.id}", "dispatch.offer", {
            "request_id": req.id, "incident_type": req.incident_type.value, "severity": req.severity,
            "lat": req.lat, "lng": req.lng, "address": req.address, "eta_seconds": eta, "manual": True})
        if previous:
            events.publish(f"crew:{previous}", "request.status",
                           {"request_id": req.id, "status": "reassigned", "ambulance_id": amb.id})
        trips.publish_status(req)
        if no_hospital:
            events.publish("controller", "dispatch.escalated", {"request_id": req.id, "reason": "no_eligible_hospital"})
        return req
