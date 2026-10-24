"""Interop API for external dispatch centres (NFR8). Authenticated by `X-API-Key`; see services/interop.py."""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import audit, events, ratelimit
from ..db import get_db
from ..deps import require_api_client
from ..geo import in_city
from ..models import ApiClient, EmergencyRequest, IncidentType, RequestStatus, utcnow
from ..services import dispatch, interop

router = APIRouter(prefix="/api/interop", tags=["interop"])
INTEROP_LIMIT = ratelimit.limiter("interop", 120, 60)  # calls per API key per minute
_TOUCH_EVERY = timedelta(minutes=1)


def _client(client: ApiClient = Depends(require_api_client), db: Session = Depends(get_db)) -> ApiClient:
    ok, retry = INTEROP_LIMIT.hit(f"interop:{client.id}")
    if not ok:
        raise ratelimit.too_many(retry)
    now = utcnow()
    last = client.last_used_at
    if last is None or now - (last if last.tzinfo else last.replace(tzinfo=timezone.utc)) >= _TOUCH_EVERY:
        client.last_used_at = now
        db.commit()
    return client


class IncidentIn(BaseModel):
    external_id: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9._:/-]+$")
    caller_name: str | None = Field(default=None, max_length=120)
    caller_phone: str | None = Field(default=None, max_length=20)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    address: str | None = Field(default=None, max_length=255)
    nature: IncidentType = IncidentType.other
    priority: int = Field(default=3, ge=1, le=5)  # 1 (minor) .. 5 (critical), stored as severity
    notes: str | None = Field(default=None, max_length=2000)


def _ack(req: EmergencyRequest) -> dict:
    return {"request_id": req.id, "external_id": req.external_id, "status": req.status.value}


@router.post("/incidents", status_code=201)
def create_incident(body: IncidentIn, response: Response, bg: BackgroundTasks,
                    client: ApiClient = Depends(_client), db: Session = Depends(get_db)):
    """Idempotent on (centre, external_id): a repeat returns the existing request with 200."""
    existing = interop.find(db, client, body.external_id)
    if existing is not None:
        response.status_code = 200
        return _ack(existing)
    if not in_city(body.lat, body.lng):
        raise HTTPException(422, "Location is outside the service area")
    req = EmergencyRequest(
        api_client_id=client.id, external_id=body.external_id, channel="external",
        caller_name=body.caller_name, caller_phone=body.caller_phone, lat=body.lat, lng=body.lng,
        address=body.address, incident_type=body.nature, severity=body.priority, notes=body.notes,
        status=RequestStatus.received)
    db.add(req)
    try:
        db.flush()
    except IntegrityError:  # lost a race with a concurrent retry of the same incident
        db.rollback()
        response.status_code = 200
        return _ack(interop.find(db, client, body.external_id))
    audit.log(db, "interop.incident.create", "request", req.id, None,
              {"api_client_id": client.id, "external_id": body.external_id,
               "incident_type": req.incident_type.value, "severity": req.severity})
    db.commit()
    events.publish("controller", "request.created", {"request_id": req.id, "incident_type": req.incident_type.value,
                                                      "severity": req.severity, "lat": req.lat, "lng": req.lng,
                                                      "channel": "external"})
    bg.add_task(dispatch.run_dispatch, req.id)  # own DB session
    return _ack(req)


@router.get("/incidents/{external_id}")
def incident_status(external_id: str, client: ApiClient = Depends(_client), db: Session = Depends(get_db)):
    req = interop.find(db, client, external_id)
    if req is None:
        raise HTTPException(404, "Unknown incident")
    return interop.status_out(req)


@router.get("/export")
def export(since: datetime | None = Query(None, description="ISO-8601; defaults to all time"),
           limit: int = Query(1000, ge=1, le=5000),
           client: ApiClient = Depends(_client), db: Session = Depends(get_db)):
    """Completed incidents of the calling centre, without caller PII."""
    if since is None:
        since = datetime(1970, 1, 1, tzinfo=timezone.utc)
    elif since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    return interop.export_completed(db, client, since.astimezone(timezone.utc), limit)
