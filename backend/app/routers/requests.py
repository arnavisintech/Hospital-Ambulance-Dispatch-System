"""Emergency request intake and tracking (UC-1, FR1, FR6)."""
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import audit, events, ratelimit
from ..db import get_db
from ..deps import current_user, require_roles
from ..geo import in_city
from ..models import EmergencyRequest, IncidentType, RequestStatus, Role, TripRecord, User, utcnow
from ..services import dispatch, sharing, tracking as tracking_svc, trips

router = APIRouter(prefix="/api/requests", tags=["requests"])
SOS_LIMIT = ratelimit.limiter("sos", 20, 3600)  # new requests per requester per hour; controllers exempt
# Guest accounts are cheap to make, so their SOS also share a per-IP cap: far above real emergency volume behind one
# carrier address, but it stops a scripted flood of fake SOS from tying up the fleet.
GUEST_SOS_IP = ratelimit.limiter("guest_sos_ip", 60, 3600)


class RequestIn(BaseModel):
    client_uuid: str | None = Field(default=None, max_length=64)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    address: str | None = Field(default=None, max_length=255)
    incident_type: IncidentType = IncidentType.other
    severity: int = Field(default=3, ge=1, le=5)
    patient_age_group: Literal["child", "adult", "senior", "elderly", "unknown"] = "unknown"
    notes: str | None = Field(default=None, max_length=2000)
    caller_name: str | None = Field(default=None, max_length=120)
    caller_phone: str | None = Field(default=None, max_length=20)
    channel: str = Field(default="app", pattern="^(app|ivr)$")


class CancelIn(BaseModel):
    reason: str | None = Field(default=None, max_length=255)


class FeedbackIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    comment: str | None = Field(default=None, max_length=1000)


def _create(body: RequestIn, user: User, channel: str, db: Session, bg: BackgroundTasks, response: Response,
            client_ip: str | None = None) -> dict:
    if body.client_uuid:  # idempotent retry (UC-1 E1)
        existing = db.execute(select(EmergencyRequest).where(EmergencyRequest.client_uuid == body.client_uuid)).scalar_one_or_none()
        if existing is not None:
            if user.role != Role.controller and existing.requester_id != user.id:
                raise HTTPException(409, "client_uuid already used")
            response.status_code = 200
            return trips.request_out(db, existing)
    if not in_city(body.lat, body.lng):
        raise HTTPException(422, "This location is outside the HADS service area; call 108 for an ambulance")
    is_requester = user.role == Role.requester
    if is_requester:  # idempotent retries returned above and never count
        ok, retry = SOS_LIMIT.hit(f"sos:{user.id}")
        if not ok:
            raise ratelimit.too_many(retry, "Too many new requests from this account; call 108 if this is urgent")
        if user.is_guest and client_ip:
            ok, retry = GUEST_SOS_IP.hit(f"guest_sos:{client_ip}")
            if not ok:
                raise ratelimit.too_many(retry, "Too many requests from this network; call 108 if this is urgent")
    req = EmergencyRequest(
        client_uuid=body.client_uuid, requester_id=user.id if is_requester else None,
        caller_name=body.caller_name or (user.name if is_requester else None),
        caller_phone=body.caller_phone or (user.phone if is_requester else None),
        channel=channel, lat=body.lat, lng=body.lng, address=body.address, incident_type=body.incident_type,
        severity=body.severity, patient_age_group=body.patient_age_group, notes=body.notes,
        status=RequestStatus.received)
    db.add(req)
    try:
        db.flush()
    except IntegrityError:  # lost a race with a concurrent retry of the same client_uuid
        db.rollback()
        existing = db.execute(select(EmergencyRequest).where(EmergencyRequest.client_uuid == body.client_uuid)).scalar_one()
        response.status_code = 200
        return trips.request_out(db, existing)
    audit.log(db, "request.create", "request", req.id, user.id,
              {"channel": channel, "incident_type": req.incident_type.value, "severity": req.severity,
               "entered_by_role": user.role.value})
    db.commit()
    events.publish("controller", "request.created", {"request_id": req.id, "incident_type": req.incident_type.value,
                                                      "severity": req.severity, "lat": req.lat, "lng": req.lng,
                                                      "channel": channel})
    bg.add_task(dispatch.run_dispatch, req.id)  # own DB session; never reuses this request's
    response.status_code = 201
    return {**trips.request_out(db, req), "estimated_wait_seconds": _estimated_wait(db, req)}


def _estimated_wait(db: Session, req: EmergencyRequest) -> int | None:
    """UC-1 step 6: estimated ETA of the best ambulance free right now (None when none is). Advisory only, and
    computed offline so the receipt never waits on the router (dispatch makes the one routed ranking call)."""
    try:
        best = dispatch.rank_candidates(db, req, quick=True)[:1]
    except Exception:  # noqa: BLE001 - the receipt must never fail over an estimate
        return None
    return int(best[0]["eta_seconds"]) if best else None


@router.post("", status_code=201)
def create_request(body: RequestIn, response: Response, bg: BackgroundTasks, request: Request,
                   user: User = Depends(require_roles(Role.requester, Role.controller)), db: Session = Depends(get_db)):
    channel = body.channel if user.role == Role.controller else "app"
    return _create(body, user, channel, db, bg, response, ratelimit.client_ip(request))


@router.post("/ivr", status_code=201)
def create_ivr_request(body: RequestIn, response: Response, bg: BackgroundTasks,
                       user: User = Depends(require_roles(Role.controller)), db: Session = Depends(get_db)):
    return _create(body, user, "ivr", db, bg, response)


@router.get("/mine")
def my_requests(user: User = Depends(require_roles(Role.requester)), db: Session = Depends(get_db)):
    rows = db.execute(select(EmergencyRequest).where(EmergencyRequest.requester_id == user.id)
                      .order_by(EmergencyRequest.id.desc())).scalars().all()
    return [trips.request_out(db, r) for r in rows]


def _load(db: Session, user: User, request_id: int) -> EmergencyRequest:
    req = db.get(EmergencyRequest, request_id)
    if req is None:
        raise HTTPException(404, "Request not found")
    if not trips.can_view(db, user, req):
        raise HTTPException(403, "Not permitted to view this request")
    return req


@router.get("/{request_id}")
def get_request(request_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    req = _load(db, user, request_id)
    return trips.request_out(db, req, hide_phone=user.role == Role.crew and req.status == RequestStatus.offered)


@router.post("/{request_id}/cancel")
def cancel(request_id: int, body: CancelIn | None = None, user: User = Depends(require_roles(Role.requester, Role.controller)),
           db: Session = Depends(get_db)):
    req = dispatch.lock_request(db, request_id)
    if req is None:
        raise HTTPException(404, "Request not found")
    if user.role == Role.requester and req.requester_id != user.id:
        raise HTTPException(403, "Not your request")
    trips.cancel_request(db, req, user.id, body.reason if body else None)
    return trips.request_out(db, req)


@router.get("/{request_id}/tracking")
def tracking(request_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    req = _load(db, user, request_id)
    out = tracking_svc.private_payload(db, req, user)
    db.commit()  # persist an ETA refreshed by the leg snapshot
    return out


@router.post("/{request_id}/share")
def share(request_id: int, user: User = Depends(require_roles(Role.requester, Role.controller, Role.admin)),
          db: Session = Depends(get_db)):
    """Family share link (idempotent). Owner requester or controller."""
    req = db.get(EmergencyRequest, request_id)
    if req is None:
        raise HTTPException(404, "Request not found")
    if user.role == Role.requester and req.requester_id != user.id:
        raise HTTPException(403, "Not your request")
    if req.status in trips.TERMINAL:
        raise HTTPException(409, f"Request already {req.status.value}")
    link, created = sharing.get_or_create(db, req, user.id)
    if created:
        audit.log(db, "request.share", "request", req.id, user.id, {"share_id": link.id})
    db.commit()
    return sharing.link_out(link)


@router.post("/{request_id}/feedback")
def feedback(request_id: int, body: FeedbackIn, user: User = Depends(require_roles(Role.requester)),
             db: Session = Depends(get_db)):
    """Owner rates a completed trip (1..5). Re-submitting replaces the previous rating."""
    req = db.get(EmergencyRequest, request_id)
    if req is None:
        raise HTTPException(404, "Request not found")
    if req.requester_id != user.id:
        raise HTTPException(403, "Not your request")
    if req.status != RequestStatus.completed:
        raise HTTPException(409, "Feedback is accepted once the trip is completed")
    trip = db.execute(select(TripRecord).where(TripRecord.request_id == req.id)).scalar_one_or_none()
    if trip is None:
        raise HTTPException(409, "No trip record for this request")
    fb = {"rating": body.rating, "comment": (body.comment or "").strip() or None, "at": utcnow().isoformat()}
    trip.summary = {**(trip.summary or {}), "feedback": fb}
    audit.log(db, "request.feedback", "request", req.id, user.id, {"rating": body.rating})
    db.commit()
    return {"rating": fb["rating"], "comment": fb["comment"]}
