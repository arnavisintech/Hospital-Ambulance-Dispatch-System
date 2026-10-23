"""Capacity matching engine (FR5, UC-3).

Chooses the destination hospital for a request using ONLY clinical fit (ICU for severity>=4,
specialist availability for the incident type), capacity freshness and travel time. Requester
identity never enters the ranking (STRQ1).
"""
import logging
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session, object_session

from .. import audit, events
from ..config import get_settings
from ..geo import haversine_km
from ..models import EmergencyRequest, Hospital, IncidentType, PlatformSetting, utcnow
from . import routing
from .trips import aware

log = logging.getLogger("hads.capacity")

# Specialty that MUST be on duty for the incident type (hard filter).
REQUIRED_SPECIALTY = {
    IncidentType.cardiac: "cardiology",
    IncidentType.stroke: "neurology",
    IncidentType.trauma: "trauma",
    IncidentType.burns: "trauma",
    IncidentType.maternity: "obstetrics",
}
# Nice-to-have specialty: only improves rank.
PREFERRED_SPECIALTY = {IncidentType.respiratory: "pulmonology", IncidentType.poisoning: "toxicology"}
PREFERRED_BONUS_S = 300


def stale_minutes(db: Session | None) -> int:
    """capacity_stale_min from PlatformSetting (admin-editable), falling back to config."""
    default = get_settings().capacity_stale_min
    if db is None:
        return default
    from .trips import get_setting
    return get_setting(db, "capacity_stale_min", default)


def is_stale(h: Hospital, stale_min: int | None = None) -> bool:
    if h.capacity_updated_at is None:
        return True
    if stale_min is None:
        stale_min = stale_minutes(object_session(h))
    age = utcnow() - aware(h.capacity_updated_at)
    return age > timedelta(minutes=stale_min)


def capacity_age_min(h: Hospital) -> float | None:
    if h.capacity_updated_at is None:
        return None
    return round((utcnow() - aware(h.capacity_updated_at)).total_seconds() / 60, 1)


def hospital_out(h: Hospital) -> dict:
    return {"id": h.id, "name": h.name, "address": h.address, "lat": h.lat, "lng": h.lng,
            "available_beds": h.available_beds, "total_beds": h.total_beds,
            "available_icu": h.available_icu, "total_icu": h.total_icu, "specialists": h.specialists or {},
            "capacity_updated_at": h.capacity_updated_at.isoformat() if h.capacity_updated_at else None,
            "stale": is_stale(h)}


def _spec_count(h: Hospital, spec: str) -> int:
    try:
        return int((h.specialists or {}).get(spec, 0))
    except (TypeError, ValueError):
        return 0


def _eligible(h: Hospital, req: EmergencyRequest, stale_min: int | None = None) -> dict | None:
    """Clinical filter only (no routing). None when the hospital cannot take this patient."""
    spec = REQUIRED_SPECIALTY.get(req.incident_type)
    stale = is_stale(h, stale_min)
    needs_icu = req.severity >= 4
    if spec and _spec_count(h, spec) <= 0:
        return None
    if not stale:
        if needs_icu and h.available_icu <= 0:
            return None
        if not needs_icu and h.available_beds <= 0:
            return None
    return {"hospital": h, "stale": stale, "capacity": "unknown" if stale else "known", "icu": needs_icu}


def _score(rec: dict, req: EmergencyRequest, eta: int) -> dict:
    pref = PREFERRED_SPECIALTY.get(req.incident_type)
    bonus = PREFERRED_BONUS_S if pref and _spec_count(rec["hospital"], pref) > 0 else 0
    return {**rec, "eta_seconds": eta, "score": eta - bonus}


def evaluate(h: Hospital, req: EmergencyRequest, eta: int | None = None) -> dict | None:
    """Return a ranking record, or None when the hospital is clinically ineligible."""
    rec = _eligible(h, req)
    if rec is None:
        return None
    if eta is None:
        eta = routing.eta_seconds((req.lat, req.lng), (h.lat, h.lng))
    return _score(rec, req, eta)


def rank_hospitals(db: Session, req: EmergencyRequest, exclude: set[int] = frozenset()) -> tuple[list[dict], float]:
    """Ranked eligible hospitals; widens the search radius twice before giving up. Returns (ranking, radius_km).
    Travel times for every clinically eligible hospital inside the widest radius come from ONE routing call."""
    base = get_settings().hospital_search_radius_km
    stale_min = stale_minutes(db)
    hospitals = [h for h in db.execute(select(Hospital)).scalars() if h.partner_verified and h.id not in exclude]
    pool = []
    for h in hospitals:
        km = haversine_km(req.lat, req.lng, h.lat, h.lng)
        if km > base * 4:
            continue
        rec = _eligible(h, req, stale_min)
        if rec:
            pool.append((km, rec))
    etas = routing.eta_from((req.lat, req.lng), [(r["hospital"].lat, r["hospital"].lng) for _km, r in pool])
    scored = [(km, _score(rec, req, eta)) for (km, rec), eta in zip(pool, etas)]
    radius = base
    for _ in range(3):  # base, x2, x4
        ranked = [rec for km, rec in scored if km <= radius]
        if ranked:
            ranked.sort(key=lambda r: (r["stale"], r["score"], r["hospital"].id))  # fresh first, then time
            return ranked, radius
        radius *= 2
    return [], radius


# ---------------------------------------------------------------- redirect-avoided tracking (v2 section 10)
def _dest_key(request_id: int) -> str:
    return f"destination:{request_id}"


def note_destination(db: Session, req: EmergencyRequest, hospital_id: int, capacity_known: bool, manual: bool) -> None:
    """Remember the first confirmed destination and whether its capacity was known at confirmation."""
    row = db.get(PlatformSetting, _dest_key(req.id))
    if row is None:
        db.add(PlatformSetting(key=_dest_key(req.id), value={
            "first_hospital_id": hospital_id, "capacity_known": capacity_known, "changed": False}))
        return
    val = dict(row.value or {})
    if val.get("first_hospital_id") != hospital_id or manual:
        val["changed"] = val.get("changed") or val.get("first_hospital_id") != hospital_id
    row.value = val


def redirect_avoided(db: Session, req: EmergencyRequest) -> bool:
    """True when the destination had known capacity when confirmed and was never changed afterwards."""
    row = db.get(PlatformSetting, _dest_key(req.id))
    if row is None or not isinstance(row.value, dict):
        return False
    v = row.value
    return bool(v.get("capacity_known") and not v.get("changed")
                and v.get("first_hospital_id") == req.destination_hospital_id)


def reserved_kind(db: Session, request_id: int) -> str | None:
    """'bed' | 'icu' while a bed is held for (or was consumed by) this request, else None."""
    row = _get_reservation(db, request_id)
    if row is None or not isinstance(row.value, dict):
        return None
    return row.value.get("kind") if row.value.get("state") in ("held", "consumed") else None


def _res_key(request_id: int) -> str:
    return f"reservation:{request_id}"


def _get_reservation(db: Session, request_id: int) -> PlatformSetting | None:
    return db.get(PlatformSetting, _res_key(request_id))


def _publish_capacity(h: Hospital) -> None:
    events.publish("controller", "capacity.updated", hospital_out(h))


def release_reservation(db: Session, req: EmergencyRequest, reason: str = "released", consumed: bool = False) -> None:
    """End the soft hold. consumed=True (patient handed over) keeps the bed counted as occupied."""
    row = _get_reservation(db, req.id)
    if row is None or row.value.get("state") != "held":
        return
    val = dict(row.value)
    h = db.get(Hospital, val["hospital_id"])
    if val.get("counted") and h is not None and not consumed:
        if val["kind"] == "icu":
            h.available_icu = min(h.total_icu, h.available_icu + 1)
        else:
            h.available_beds = min(h.total_beds, h.available_beds + 1)
        _publish_capacity(h)
    val["state"] = "consumed" if consumed else "released"
    val["reason"] = reason
    row.value = val
    audit.log(db, "capacity.release", "hospital", val["hospital_id"], None,
              {"request_id": req.id, "kind": val["kind"], "state": val["state"], "reason": reason})


def reserve(db: Session, req: EmergencyRequest, h: Hospital, stale: bool) -> dict:
    """Soft-reserve one ICU/general bed (not when capacity is unknown/stale)."""
    kind = "icu" if req.severity >= 4 else "bed"
    counted = False
    if not stale:
        if kind == "icu" and h.available_icu > 0:
            h.available_icu -= 1
            counted = True
        elif kind == "bed" and h.available_beds > 0:
            h.available_beds -= 1
            counted = True
    val = {"hospital_id": h.id, "kind": kind, "state": "held", "counted": counted}
    row = _get_reservation(db, req.id)
    if row is None:
        db.add(PlatformSetting(key=_res_key(req.id), value=val))
    else:
        row.value = val
    if counted:
        _publish_capacity(h)
    return val


def announce_destination(db: Session, req: EmergencyRequest, h: Hospital, extra: dict | None = None) -> None:
    data = {"request_id": req.id, "hospital": {"id": h.id, "name": h.name, "lat": h.lat, "lng": h.lng},
            "eta_seconds": req.eta_seconds, **(extra or {})}
    events.publish(f"request:{req.id}", "destination.confirmed", data)
    events.publish("controller", "destination.confirmed", data)
    if req.ambulance_id:
        events.publish(f"crew:{req.ambulance_id}", "destination.confirmed", data)
    events.publish(f"hospital:{h.id}", "hospital.incoming",
                   {"request_id": req.id, "incident_type": req.incident_type.value, "severity": req.severity,
                    "eta_seconds": req.eta_seconds, "ambulance_id": req.ambulance_id})


def confirm_destination(db: Session, req: EmergencyRequest, exclude: set[int] | None = None,
                        user_id: int | None = None) -> Hospital | None:
    """Pick + soft-reserve the destination hospital. Caller commits. None => escalate to controller."""
    exclude = set(exclude or ())
    release_reservation(db, req, reason="re-selection")
    ranking, radius = rank_hospitals(db, req, exclude)
    audit.log(db, "capacity.query", "request", req.id, user_id, {
        "incident_type": req.incident_type.value, "severity": req.severity, "radius_km": radius,
        "required_specialty": REQUIRED_SPECIALTY.get(req.incident_type), "needs_icu": req.severity >= 4,
        "candidates": [{"hospital_id": r["hospital"].id, "eta_seconds": r["eta_seconds"], "capacity": r["capacity"]}
                       for r in ranking[:5]],
        "chosen": ranking[0]["hospital"].id if ranking else None})
    if not ranking:
        req.destination_hospital_id = None
        return None
    best = ranking[0]
    h = best["hospital"]
    req.destination_hospital_id = h.id
    res = reserve(db, req, h, best["stale"])
    note_destination(db, req, h.id, not best["stale"], manual=False)
    audit.log(db, "capacity.reserve", "hospital", h.id, user_id,
              {"request_id": req.id, "kind": res["kind"], "counted": res["counted"],
               "capacity": best["capacity"]})
    announce_destination(db, req, h, {"capacity": best["capacity"]})
    return h
