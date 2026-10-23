"""FR12: onboarding of hospitals, dark stations, fleet and users; platform settings."""
from __future__ import annotations

import re
from datetime import timezone

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import (Ambulance, AmbulanceStatus, CrewProfile, DarkStation, Hospital, HospitalStaffProfile, PlatformSetting,
                      Role, StationAssignment, User, utcnow)
from ..security import hash_password
from .billing import SETTING_DEFS, get_platform_settings

REG_RE = re.compile(r"^[A-Z0-9][A-Z0-9 \-]{3,30}[A-Z0-9]$")
KINDS = {"BLS", "ALS"}


# ----------------------------------------------------------------- hospitals / stations / fleet
def create_hospital(db: Session, data: dict) -> Hospital:
    name = data["name"].strip()
    if db.scalar(select(Hospital.id).where(func.lower(Hospital.name) == name.lower())):
        raise HTTPException(409, "A hospital with this name already exists")
    reg = data["registration_number"].strip().upper()
    if db.scalar(select(Hospital.id).where(Hospital.registration_number == reg)):
        raise HTTPException(409, "A hospital with this registration number already exists")
    pct = data.get("revenue_share_pct")
    if pct is None:
        pct = get_platform_settings(db)["revenue_share_pct"]
    h = Hospital(name=name, address=data.get("address", "") or "", lat=data["lat"], lng=data["lng"],
                 total_beds=data["total_beds"], available_beds=data["total_beds"], total_icu=data["total_icu"],
                 available_icu=data["total_icu"], specialists=data.get("specialists") or {},
                 capacity_updated_at=utcnow(), revenue_share_pct=float(pct), registration_number=reg,
                 partner_verified=False)  # STRQ2: routed to only after an admin verifies the partner
    db.add(h)
    db.flush()
    return h


def create_station(db: Session, hospital_id: int, data: dict) -> DarkStation:
    if not db.get(Hospital, hospital_id):
        raise HTTPException(404, "Hospital not found")
    s = DarkStation(hospital_id=hospital_id, name=data["name"].strip(), address=data.get("address", "") or "",
                    lat=data["lat"], lng=data["lng"], is_active=True)
    db.add(s)
    db.flush()
    return s


def normalise_reg(reg: str) -> str:
    reg = re.sub(r"\s+", " ", reg.strip().upper())
    if not REG_RE.match(reg):
        raise HTTPException(422, f"Invalid registration number '{reg}' (5-32 chars: letters, digits, space, hyphen)")
    return reg


def register_ambulances(db: Session, station_id: int, items: list[dict]) -> list[Ambulance]:
    """Atomic: either every ambulance is registered or none."""
    st = db.get(DarkStation, station_id)
    if not st:
        raise HTTPException(404, "Station not found")
    if not items:
        raise HTTPException(422, "No ambulances supplied")
    if len(items) > 200:
        raise HTTPException(422, "At most 200 ambulances per bulk request")
    regs, seen = [], set()
    for it in items:
        reg = normalise_reg(it["registration_number"])
        kind = (it.get("kind") or "BLS").upper()
        if kind not in KINDS:
            raise HTTPException(422, f"Invalid kind '{kind}' for {reg}; use BLS or ALS")
        if reg in seen:
            raise HTTPException(409, f"Duplicate registration number in request: {reg}")
        seen.add(reg)
        regs.append((reg, kind, bool(it.get("staffed", True))))
    clash = db.execute(select(Ambulance.registration_number).where(Ambulance.registration_number.in_(seen))).scalars().all()
    if clash:
        raise HTTPException(409, f"Registration number(s) already registered: {', '.join(sorted(clash))}")
    now = utcnow()
    out = []
    for reg, kind, staffed in regs:
        a = Ambulance(station_id=st.id, registration_number=reg, kind=kind, staffed=staffed,
                      status=AmbulanceStatus.available if staffed else AmbulanceStatus.offline,
                      lat=st.lat, lng=st.lng, location_updated_at=now)
        db.add(a)
        out.append(a)
    db.flush()
    return out


# ----------------------------------------------------------------- users
def create_user(db: Session, data: dict) -> User:
    role = Role(data["role"])
    email = data["email"].strip().lower()
    phone = (data.get("phone") or "").strip() or None
    if db.scalar(select(User.id).where(func.lower(User.email) == email)):
        raise HTTPException(409, "Email already registered")
    if phone and db.scalar(select(User.id).where(User.phone == phone)):
        raise HTTPException(409, "Phone already registered")
    if role == Role.hospital_staff:
        if not data.get("hospital_id") or not db.get(Hospital, data["hospital_id"]):
            raise HTTPException(422, "hospital_staff requires a valid hospital_id")
    if role == Role.crew:
        if not (data.get("license_number") or "").strip():
            raise HTTPException(422, "crew requires license_number")
        aid = data.get("ambulance_id")
        if aid is not None:
            if not db.get(Ambulance, aid):
                raise HTTPException(422, "ambulance_id does not exist")
            if db.scalar(select(CrewProfile.user_id).where(CrewProfile.ambulance_id == aid)):
                raise HTTPException(409, "That ambulance already has a crew member assigned")
    u = User(name=data["name"].strip(), email=email, phone=phone, password_hash=hash_password(data["password"]),
             role=role, is_active=True)
    db.add(u)
    db.flush()
    if role == Role.hospital_staff:
        db.add(HospitalStaffProfile(user_id=u.id, hospital_id=data["hospital_id"]))
    elif role == Role.crew:
        db.add(CrewProfile(user_id=u.id, license_number=data["license_number"].strip(), ambulance_id=data.get("ambulance_id")))
    db.flush()
    return u


def user_out(db: Session, u: User) -> dict:
    d = {"id": u.id, "name": u.name, "email": u.email, "phone": u.phone, "role": u.role.value, "is_active": u.is_active,
         "created_at": u.created_at.isoformat() if u.created_at else None, "hospital_id": None, "ambulance_id": None,
         "license_number": None}
    if u.role == Role.hospital_staff:
        p = db.get(HospitalStaffProfile, u.id)
        d["hospital_id"] = p.hospital_id if p else None
    elif u.role == Role.crew:
        p = db.get(CrewProfile, u.id)
        if p:
            d["ambulance_id"], d["license_number"] = p.ambulance_id, p.license_number
    return d


def hospital_out(h: Hospital, n_stations: int | None = None) -> dict:
    return {"id": h.id, "name": h.name, "address": h.address, "lat": h.lat, "lng": h.lng,
            "total_beds": h.total_beds, "available_beds": h.available_beds, "total_icu": h.total_icu,
            "available_icu": h.available_icu, "specialists": h.specialists or {},
            "revenue_share_pct": h.revenue_share_pct, "partner_verified": h.partner_verified,
            "registration_number": h.registration_number,
            "verified_at": h.verified_at.isoformat() if h.verified_at else None, "stations": n_stations}


def station_out(s: DarkStation, hospital_name: str | None = None, ambulances: int = 0, available: int = 0) -> dict:
    return {"id": s.id, "hospital_id": s.hospital_id, "hospital_name": hospital_name, "name": s.name,
            "address": s.address, "lat": s.lat, "lng": s.lng, "is_active": s.is_active,
            "ambulances": ambulances, "available": available}


def ambulance_out(a: Ambulance) -> dict:
    return {"id": a.id, "station_id": a.station_id, "registration_number": a.registration_number, "kind": a.kind,
            "status": a.status.value, "staffed": a.staffed, "lat": a.lat, "lng": a.lng}


# ----------------------------------------------------------------- settings
def update_settings(db: Session, changes: dict) -> dict:
    if not changes:
        raise HTTPException(422, "No settings supplied")
    unknown = [k for k in changes if k not in SETTING_DEFS]
    if unknown:
        raise HTTPException(422, f"Unknown setting(s): {', '.join(sorted(unknown))}")
    clean = {}
    for k, v in changes.items():
        default, lo, hi, typ = SETTING_DEFS[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise HTTPException(422, f"{k} must be a number")
        if typ is int and float(v) != int(v):
            raise HTTPException(422, f"{k} must be an integer")
        v = typ(v)
        if not (lo <= v <= hi):
            raise HTTPException(422, f"{k} must be between {lo} and {hi}")
        clean[k] = v
    for k, v in clean.items():
        row = db.get(PlatformSetting, k)
        if row:
            row.value = {"value": v}
        else:
            db.add(PlatformSetting(key=k, value={"value": v}))
    db.flush()
    return clean
