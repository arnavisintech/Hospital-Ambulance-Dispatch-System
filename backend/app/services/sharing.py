"""Family share links (v2 section 4).

Token format: ``<random id>.<hmac>`` where the HMAC (SHA-256, keyed with the JWT secret) signs the random id, so
forged or mangled tokens are rejected before touching the database. A link works while the trip is active and
for ``share_ttl_after_end_h`` hours after it ends (completed / cancelled / failed), then returns 404.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import EmergencyRequest, RequestEvent, ShareLink, utcnow
from .trips import TERMINAL, aware


def _sig(rid: str) -> str:
    key = get_settings().jwt_secret.encode()
    return hmac.new(key, f"share:{rid}".encode(), hashlib.sha256).hexdigest()[:20]


def new_token() -> str:
    rid = secrets.token_urlsafe(12)
    return f"{rid}.{_sig(rid)}"


def signature_ok(token: str) -> bool:
    rid, _, sig = (token or "").partition(".")
    return bool(rid and sig) and len(token) <= 80 and hmac.compare_digest(sig, _sig(rid))


def url_for(token: str) -> str:
    return f"/t/{token}"


def link_out(link: ShareLink | None) -> dict | None:
    return {"token": link.token, "url": url_for(link.token)} if link else None


def get_link(db: Session, request_id: int) -> ShareLink | None:
    return db.execute(select(ShareLink).where(ShareLink.request_id == request_id)).scalar_one_or_none()


def get_or_create(db: Session, req: EmergencyRequest, user_id: int | None) -> tuple[ShareLink, bool]:
    """Idempotent: one link per request. Returns (link, created). Caller commits."""
    link = get_link(db, req.id)
    if link is not None:
        return link, False
    link = ShareLink(request_id=req.id, token=new_token(), created_by=user_id)
    db.add(link)
    db.flush()
    return link, True


def ended_at(db: Session, req: EmergencyRequest):
    """When the request reached a terminal state (None while active)."""
    if req.status not in TERMINAL:
        return None
    if req.completed_at:
        return aware(req.completed_at)
    at = db.scalar(select(RequestEvent.at).where(RequestEvent.request_id == req.id,
                                                 RequestEvent.status == req.status.value)
                   .order_by(RequestEvent.at.desc()).limit(1))
    return aware(at) or aware(req.created_at)


def resolve(db: Session, token: str) -> EmergencyRequest | None:
    """Request for a valid, unexpired share token; None otherwise (callers answer 404)."""
    if not signature_ok(token):
        return None
    link = db.execute(select(ShareLink).where(ShareLink.token == token)).scalar_one_or_none()
    if link is None:
        return None
    req = db.get(EmergencyRequest, link.request_id)
    if req is None:
        return None
    end = ended_at(db, req)
    if end is not None and utcnow() - end > timedelta(hours=get_settings().share_ttl_after_end_h):
        return None
    return req


# ---------------------------------------------------------------- privacy for anonymous share viewers
# Whitelist (fail closed): only these event types and fields ever reach a share subscriber. Names and phones are
# never whitelisted; any coordinate within PRIVACY_RADIUS_M of the patient is coarsened to a ~110 m grid
# (3 decimals), because a route ending at -- or an ambulance parked at -- the patient reveals the exact address.
PRIVACY_RADIUS_M = 250.0
SHARE_FIELDS: dict[str, tuple[str, ...]] = {
    "subscribed": ("topics",),
    "request.status": ("request_id", "status", "eta_seconds", "ambulance_id", "destination_hospital_id"),
    "ambulance.location": ("request_id", "ambulance_id", "lat", "lng", "heading_deg", "eta_seconds", "phase", "status", "ts"),
    "request.route": ("request_id", "phase", "polyline", "eta_seconds", "distance_km"),
    "destination.confirmed": ("request_id", "hospital", "eta_seconds"),
    "dispatch.escalated": ("request_id",),
    "trip.closed": ("request_id",),
}
HOSPITAL_FIELDS = ("id", "name", "lat", "lng")


def _near(lat, lng, patient: tuple[float, float]) -> bool:
    from ..geo import haversine_km
    return lat is not None and lng is not None and haversine_km(lat, lng, patient[0], patient[1]) * 1000 <= PRIVACY_RADIUS_M


def coarse(lat: float, lng: float) -> list[float]:
    return [round(lat, 3), round(lng, 3)]


def coarsen_point(lat, lng, patient: tuple[float, float]):
    """(lat, lng) unchanged when far from the patient, else snapped to the 3-decimal grid."""
    if _near(lat, lng, patient):
        c = coarse(lat, lng)
        return c[0], c[1]
    return lat, lng


def coarsen_polyline(poly: list, patient: tuple[float, float]) -> list:
    """Replace every vertex inside the privacy radius by a single coarse patient-area point (kept in order)."""
    out, marked = [], False
    for p in poly or []:
        if _near(p[0], p[1], patient):
            if not marked:
                out.append(coarse(*patient))
                marked = True
        else:
            out.append([p[0], p[1]])
            marked = False
    return out


def sanitize_event(type_: str, data: dict, patient: tuple[float, float]) -> dict | None:
    fields = SHARE_FIELDS.get(type_)
    if fields is None or not isinstance(data, dict):
        return None
    out = {k: data[k] for k in fields if k in data}
    if "lat" in out and "lng" in out:
        out["lat"], out["lng"] = coarsen_point(out["lat"], out["lng"], patient)
    if "polyline" in out:
        out["polyline"] = coarsen_polyline(out["polyline"], patient)
    if isinstance(out.get("hospital"), dict):
        out["hospital"] = {k: out["hospital"][k] for k in HOSPITAL_FIELDS if k in out["hospital"]}
    return out


def share_filter(patient: tuple[float, float]):
    """Per-socket hub filter for an anonymous share subscription."""
    return lambda type_, data: sanitize_event(type_, data, patient)
