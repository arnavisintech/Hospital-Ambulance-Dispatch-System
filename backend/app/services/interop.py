"""Provider-neutral interop with external dispatch centres (NFR8: 108/102-compatible exchange).

A centre authenticates with an API key (only its SHA-256 is stored), pushes incidents keyed by its own incident id,
polls their status and pulls completed-incident records. Nothing returned here carries caller PII.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import ApiClient, EmergencyRequest, RequestStatus, TripRecord

KEY_PREFIX = "hads_"


def new_key() -> str:
    return KEY_PREFIX + secrets.token_urlsafe(32)


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def client_for_key(db: Session, key: str | None) -> ApiClient | None:
    if not key:
        return None
    c = db.execute(select(ApiClient).where(ApiClient.key_hash == hash_key(key))).scalar_one_or_none()
    return c if c is not None and c.is_active else None


def find(db: Session, client: ApiClient, external_id: str) -> EmergencyRequest | None:
    return db.execute(select(EmergencyRequest).where(EmergencyRequest.api_client_id == client.id,
                                                     EmergencyRequest.external_id == external_id)).scalar_one_or_none()


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def status_out(req: EmergencyRequest) -> dict:
    return {"external_id": req.external_id, "request_id": req.id, "status": req.status.value,
            "ambulance_registration": req.ambulance.registration_number if req.ambulance else None,
            "eta_seconds": req.eta_seconds,
            "destination_hospital": req.destination_hospital.name if req.destination_hospital else None}


def export_completed(db: Session, client: ApiClient, since: datetime, limit: int = 1000) -> list[dict]:
    """Completed incidents of this centre, oldest first, completed (or, if unrecorded, created) at/after `since`."""
    done_at = func.coalesce(EmergencyRequest.completed_at, EmergencyRequest.created_at)
    rows = db.execute(
        select(EmergencyRequest, TripRecord).outerjoin(TripRecord, TripRecord.request_id == EmergencyRequest.id)
        .where(EmergencyRequest.api_client_id == client.id, EmergencyRequest.status == RequestStatus.completed,
               done_at >= since)
        .order_by(done_at, EmergencyRequest.id).limit(limit)).all()
    return [{"external_id": r.external_id, "request_id": r.id, "created_at": _iso(r.created_at),
             "dispatched_at": _iso(r.dispatched_at), "completed_at": _iso(r.completed_at),
             "handover_time": _iso(t.handover_time) if t else None,
             "response_time_seconds": t.response_time_seconds if t else None,
             "destination_hospital": r.destination_hospital.name if r.destination_hospital else None}
            for r, t in rows]
