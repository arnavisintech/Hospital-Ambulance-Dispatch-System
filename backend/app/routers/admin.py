import secrets
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from .. import audit
from ..db import get_db
from ..deps import require_roles
from ..models import Ambulance, AmbulanceStatus, DarkStation, Hospital, Role, User
from ..security import hash_password
from ..services import onboarding as ob
from ..services.billing import get_platform_settings

router = APIRouter(prefix="/api/admin", tags=["admin"])
_admin = require_roles(Role.admin)


class HospitalIn(BaseModel):
    name: str = Field(min_length=2, max_length=160)
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
