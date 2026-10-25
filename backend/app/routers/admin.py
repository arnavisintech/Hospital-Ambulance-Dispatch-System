import secrets
from datetime import timedelta
from typing import Literal

import numpy as np

from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import audit, demographics
from ..db import get_db
from ..deps import require_roles
from ..models import (Ambulance, AmbulanceLocation, AmbulanceStatus, ApiClient, DarkStation, EmergencyRequest, Hospital,
                      Role, User, utcnow)
from ..security import hash_password
from ..services import analytics, background, interop, onboarding as ob
from ..services.billing import get_platform_settings

router = APIRouter(prefix="/api/admin", tags=["admin"])
_admin = require_roles(Role.admin)


class HospitalIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    registration_number: str = Field(min_length=4, max_length=40)  # clinical establishment registration
    address: str = Field("", max_length=255)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    total_beds: int = Field(ge=0, le=100000)
    total_icu: int = Field(ge=0, le=100000)
    specialists: dict[str, int] | None = None
    revenue_share_pct: float | None = Field(None, ge=0, le=100)


class StationIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    address: str = Field("", max_length=255)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class AmbulanceIn(BaseModel):
    registration_number: str = Field(min_length=5, max_length=32)
    kind: Literal["BLS", "ALS", "bls", "als"] = "BLS"
    staffed: bool = True


class BulkAmbulancesIn(BaseModel):
    ambulances: list[AmbulanceIn] = Field(min_length=1, max_length=200)


class StationPatch(BaseModel):
    is_active: bool | None = None
    name: str | None = Field(None, min_length=2, max_length=160)


class UserIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    phone: str | None = Field(None, pattern=r"^\+?[0-9]{7,15}$")
    password: str = Field(min_length=8, max_length=72)
    role: Role
    hospital_id: int | None = None
    ambulance_id: int | None = None
    license_number: str | None = Field(None, max_length=40)


class UserPatch(BaseModel):
    is_active: bool | None = None
    name: str | None = Field(None, min_length=2, max_length=120)


# ------------------------------------------------------------------ hospitals
@router.post("/hospitals", status_code=201)
def create_hospital(body: HospitalIn, db: Session = Depends(get_db), user: User = Depends(_admin)):
    h = ob.create_hospital(db, body.model_dump())
    audit.log(db, "admin.hospital.create", "hospital", h.id, user.id, {"name": h.name})
    db.commit()
    return ob.hospital_out(h, 0)


def _set_verified(db: Session, hospital_id: int, user: User, verified: bool) -> dict:
    h = db.get(Hospital, hospital_id)
    if not h:
        raise HTTPException(404, "Hospital not found")
    h.partner_verified = verified
    h.verified_at = utcnow() if verified else None
    h.verified_by = user.id if verified else None
    audit.log(db, f"admin.hospital.{'verify' if verified else 'suspend'}", "hospital", h.id, user.id,
              {"registration_number": h.registration_number})
    db.commit()
    n = db.scalar(select(func.count(DarkStation.id)).where(DarkStation.hospital_id == h.id))
    return ob.hospital_out(h, n)


@router.post("/hospitals/{hospital_id}/verify")
def verify_hospital(hospital_id: int, db: Session = Depends(get_db), user: User = Depends(_admin)):
    """STRQ2: mark a partner as verified; only verified partners are routed to and may update capacity."""
    return _set_verified(db, hospital_id, user, True)


@router.post("/hospitals/{hospital_id}/suspend")
def suspend_hospital(hospital_id: int, db: Session = Depends(get_db), user: User = Depends(_admin)):
    return _set_verified(db, hospital_id, user, False)


@router.get("/hospitals")
def list_hospitals(db: Session = Depends(get_db), _: User = Depends(_admin)):
    counts = dict(db.execute(select(DarkStation.hospital_id, func.count()).group_by(DarkStation.hospital_id)).all())
    return [ob.hospital_out(h, counts.get(h.id, 0)) for h in db.execute(select(Hospital).order_by(Hospital.id)).scalars()]


@router.post("/hospitals/{hospital_id}/stations", status_code=201)
def create_station(hospital_id: int, body: StationIn, db: Session = Depends(get_db), user: User = Depends(_admin)):
    s = ob.create_station(db, hospital_id, body.model_dump())
    audit.log(db, "admin.station.create", "station", s.id, user.id, {"hospital_id": hospital_id, "name": s.name})
    db.commit()
    return ob.station_out(s, db.get(Hospital, hospital_id).name)


@router.get("/stations")
def list_stations(db: Session = Depends(get_db), _: User = Depends(_admin)):
    total = dict(db.execute(select(Ambulance.station_id, func.count()).group_by(Ambulance.station_id)).all())
    avail = dict(db.execute(select(Ambulance.station_id, func.count()).where(Ambulance.status == AmbulanceStatus.available)
                            .group_by(Ambulance.station_id)).all())
    rows = db.execute(select(DarkStation, Hospital.name).join(Hospital, Hospital.id == DarkStation.hospital_id)
                      .order_by(DarkStation.id)).all()
    return [ob.station_out(s, hn, total.get(s.id, 0), avail.get(s.id, 0)) for s, hn in rows]


@router.patch("/stations/{station_id}")
def patch_station(station_id: int, body: StationPatch, db: Session = Depends(get_db), user: User = Depends(_admin)):
    s = db.get(DarkStation, station_id)
    if not s:
        raise HTTPException(404, "Station not found")
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(422, "Nothing to update")
    for k, v in changes.items():
        setattr(s, k, v)
    audit.log(db, "admin.station.update", "station", s.id, user.id, changes)
    db.commit()
    return ob.station_out(s, db.get(Hospital, s.hospital_id).name)


# ------------------------------------------------------------------ fleet
@router.post("/stations/{station_id}/ambulances", status_code=201)
def register_ambulance(station_id: int, body: AmbulanceIn, db: Session = Depends(get_db), user: User = Depends(_admin)):
    (a,) = ob.register_ambulances(db, station_id, [body.model_dump()])
    audit.log(db, "admin.ambulance.register", "ambulance", a.id, user.id,
              {"registration_number": a.registration_number, "station_id": station_id, "kind": a.kind})
    db.commit()
    return ob.ambulance_out(a)


@router.post("/stations/{station_id}/ambulances/bulk", status_code=201)
def register_ambulances_bulk(station_id: int, body: BulkAmbulancesIn | list[AmbulanceIn] = Body(...),
                             db: Session = Depends(get_db), user: User = Depends(_admin)):
    items = body.ambulances if isinstance(body, BulkAmbulancesIn) else body
    ambs = ob.register_ambulances(db, station_id, [i.model_dump() for i in items])
    audit.log(db, "admin.ambulance.bulk_register", "station", station_id, user.id,
              {"count": len(ambs), "registration_numbers": [a.registration_number for a in ambs]})
    db.commit()
    return {"created": len(ambs), "ambulances": [ob.ambulance_out(a) for a in ambs]}


# ------------------------------------------------------------------ users
@router.post("/users", status_code=201)
def create_user(body: UserIn, db: Session = Depends(get_db), user: User = Depends(_admin)):
    u = ob.create_user(db, body.model_dump())
    audit.log(db, "admin.user.create", "user", u.id, user.id, {"role": u.role.value, "email": u.email})
    db.commit()
    return ob.user_out(db, u)


@router.get("/users")
def list_users(role: Role | None = None, q: str | None = None, limit: int = Query(100, ge=1, le=500),
               offset: int = Query(0, ge=0), db: Session = Depends(get_db), _: User = Depends(_admin)):
    stmt = select(User)
    if role:
        stmt = stmt.where(User.role == role)
    if q:
        like = f"%{q.lower()}%"
        stmt = stmt.where(or_(func.lower(User.name).like(like), func.lower(User.email).like(like), User.phone.like(like)))
    return [ob.user_out(db, u) for u in db.execute(stmt.order_by(User.id).limit(limit).offset(offset)).scalars()]


@router.patch("/users/{user_id}")
def patch_user(user_id: int, body: UserPatch, db: Session = Depends(get_db), admin: User = Depends(_admin)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found")
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(422, "Nothing to update")
    if changes.get("is_active") is False and u.id == admin.id:
        raise HTTPException(409, "You cannot deactivate your own account")
    for k, v in changes.items():
        setattr(u, k, v)
    if changes.get("is_active") is False:
        u.guest_device_hash = None   # a deactivated guest is never handed back through its device id
        u.token_version = (u.token_version or 0) + 1  # signed-in sessions end immediately
    audit.log(db, "admin.user.update", "user", u.id, admin.id, changes)
    db.commit()
    return ob.user_out(db, u)


@router.post("/users/{user_id}/reset-password")
def reset_password(user_id: int, db: Session = Depends(get_db), admin: User = Depends(_admin)):
    """Issue a one-time temporary password (shown once). The user must change it at next sign-in."""
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found")
    temp = secrets.token_urlsafe(12)
    u.password_hash = hash_password(temp)
    u.must_change_password = True
    u.token_version = (u.token_version or 0) + 1
    audit.log(db, "admin.user.reset_password", "user", u.id, admin.id, {})
    db.commit()
    return {"temporary_password": temp}


# ------------------------------------------------------------------ interop API clients (external dispatch centres)
class ApiClientIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)


def _api_client_out(c: ApiClient, key: str | None = None) -> dict:
    out = {"id": c.id, "name": c.name, "is_active": c.is_active,
           "created_at": c.created_at.isoformat() if c.created_at else None,
           "last_used_at": c.last_used_at.isoformat() if c.last_used_at else None}
    if key:
        out["api_key"] = key  # shown once; only its hash is stored
    return out


def _get_api_client(db: Session, client_id: int) -> ApiClient:
    c = db.get(ApiClient, client_id)
    if c is None:
        raise HTTPException(404, "API client not found")
    return c


@router.get("/api-clients")
def list_api_clients(db: Session = Depends(get_db), _: User = Depends(_admin)):
    return [_api_client_out(c) for c in db.execute(select(ApiClient).order_by(ApiClient.id)).scalars()]


@router.post("/api-clients", status_code=201)
def create_api_client(body: ApiClientIn, db: Session = Depends(get_db), user: User = Depends(_admin)):
    name = body.name.strip()
    if db.execute(select(ApiClient).where(func.lower(ApiClient.name) == name.lower())).scalar_one_or_none():
        raise HTTPException(409, "An API client with this name already exists")
    key = interop.new_key()
    c = ApiClient(name=name, key_hash=interop.hash_key(key))
    db.add(c)
    db.flush()
    audit.log(db, "admin.api_client.create", "api_client", c.id, user.id, {"name": name})
    db.commit()
    return _api_client_out(c, key)


@router.post("/api-clients/{client_id}/rotate")
def rotate_api_client(client_id: int, db: Session = Depends(get_db), user: User = Depends(_admin)):
    """Issue a new key; the old one stops working immediately."""
    c = _get_api_client(db, client_id)
    key = interop.new_key()
    c.key_hash = interop.hash_key(key)
    c.is_active = True
    audit.log(db, "admin.api_client.rotate", "api_client", c.id, user.id, {})
    db.commit()
    return _api_client_out(c, key)


@router.post("/api-clients/{client_id}/deactivate")
def deactivate_api_client(client_id: int, db: Session = Depends(get_db), user: User = Depends(_admin)):
    c = _get_api_client(db, client_id)
    c.is_active = False
    audit.log(db, "admin.api_client.deactivate", "api_client", c.id, user.id, {})
    db.commit()
    return _api_client_out(c)


# ------------------------------------------------------------------ demographics (demand model inputs)
MAX_CSV_BYTES = 5 * 1024 * 1024


@router.post("/demographics/import")
async def import_demographics(file: UploadFile = File(...), db: Session = Depends(get_db), user: User = Depends(_admin)):
    """Replace zone demographics from CSV (lat,lng,households,pop_0_14,pop_15_59,pop_60_74,pop_75_plus).
    All-or-nothing: any bad row rejects the file and the existing data stays."""
    raw = await file.read(MAX_CSV_BYTES + 1)
    if len(raw) > MAX_CSV_BYTES:
        raise HTTPException(413, "File too large (max 5 MB)")
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(422, {"errors": ["row 1: the file must be UTF-8 CSV"]})
    rows, errors = demographics.parse_demographics_csv(text)
    if errors:
        raise HTTPException(422, {"errors": errors[:200]})
    out = demographics.replace_demographics(db, rows, "import")
    audit.log(db, "admin.demographics.import", "demographics", None, user.id, out)
    db.commit()
    return out


@router.get("/demographics/summary")
def demographics_summary(db: Session = Depends(get_db), _: User = Depends(_admin)):
    return demographics.summary(db)


# ------------------------------------------------------------------ settings
@router.get("/settings")
def get_settings_(db: Session = Depends(get_db), _: User = Depends(_admin)):
    return get_platform_settings(db)


@router.put("/settings")
def put_settings(body: dict = Body(...), db: Session = Depends(get_db), user: User = Depends(_admin)):
    changes = body.get("settings") if isinstance(body.get("settings"), dict) else body
    old = get_platform_settings(db)
    applied = ob.update_settings(db, changes)
    audit.log(db, "admin.settings.update", "settings", None, user.id,
              {k: {"from": old[k], "to": v} for k, v in applied.items()})
    db.commit()
    return get_platform_settings(db)


# ------------------------------------------------------------------ system status (operations)
@router.get("/system")
def system_status(db: Session = Depends(get_db), _: User = Depends(_admin)):
    """Last-24 h dispatch latency (NFR1), audit chain, GPS history size, worker heartbeats, model quality."""
    target_ms = int(get_platform_settings(db)["dispatch_target_s"]) * 1000
    since = utcnow() - timedelta(hours=24)
    ms = np.array(db.execute(select(EmergencyRequest.match_duration_ms).where(
        EmergencyRequest.created_at >= since, EmergencyRequest.match_duration_ms.is_not(None))).scalars().all(),
        dtype=float)
    m = analytics.latest_metric(db)
    return {
        "dispatch_samples": int(ms.size),
        "dispatch_p50_ms": round(float(np.percentile(ms, 50)), 1) if ms.size else None,
        "dispatch_p95_ms": round(float(np.percentile(ms, 95)), 1) if ms.size else None,
        "dispatch_within_target_pct": round(100.0 * float((ms <= target_ms).mean()), 1) if ms.size else None,
        "audit_chain": audit.verify_chain(db),
        "gps_rows": db.scalar(select(func.count(AmbulanceLocation.id))) or 0,
        "workers": background.worker_ages(), "stale_workers": background.stale_workers(),
        "model": {"version": m.model_version if m else None, "mae": m.mae if m else None, "r2": m.r2 if m else None,
                  "senior_demand_ratio": analytics.senior_demand_ratio(db)},
        "db_dialect": db.get_bind().dialect.name,
    }
