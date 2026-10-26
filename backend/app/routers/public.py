"""Unauthenticated endpoints: client configuration and family share-link tracking (v2 section 4)."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import get_settings
from ..db import get_db
import re

from ..models import Ambulance, CrewProfile, DarkStation, Hospital, HospitalStaffProfile, User
from ..services import sharing, tracking

router = APIRouter(prefix="/api/public", tags=["public"])


@router.get("/config")
def client_config(db: Session = Depends(get_db)):
    """What the login page may offer. Demo accounts and their password are exposed only in demo mode."""
    if not get_settings().is_demo:
        return {"demo_mode": False, "demo_password": None, "demo_accounts": []}
    from ..seed import DEMO_ACCOUNTS, DEMO_PASSWORD
    emails = [a[2] for a in DEMO_ACCOUNTS]
    active = set(db.execute(select(User.email).where(User.email.in_(emails), User.is_active.is_(True))).scalars())
    accounts = [{"role": r, "label": label, "email": e, "hint": hint}
                for r, label, e, hint in DEMO_ACCOUNTS if e in active]
    return {"demo_mode": True, "demo_password": DEMO_PASSWORD if accounts else None, "demo_accounts": accounts,
            "demo_choices": _demo_choices(db)}


# Seeded demo logins only (staff1@hads.in.., crew1@hads.in..): accounts an admin creates are never listed.
_SEEDED = {"hospital_staff": re.compile(r"^staff\d+@hads\.in$"), "crew": re.compile(r"^crew\d+@hads\.in$")}


def _demo_choices(db: Session) -> dict:
    """One demo login per hospital and per ambulance. Dispatch sends each call to whichever hospital and unit suit it
    best, so a presenter must be able to open that hospital's desk or that unit's crew app to finish the trip."""
    staff = db.execute(select(User.email, Hospital.name)
                       .join(HospitalStaffProfile, HospitalStaffProfile.user_id == User.id)
                       .join(Hospital, Hospital.id == HospitalStaffProfile.hospital_id)
                       .where(User.is_active.is_(True)).order_by(Hospital.name)).all()
    crew = db.execute(select(User.email, Ambulance.registration_number, Ambulance.kind, DarkStation.name)
                      .join(CrewProfile, CrewProfile.user_id == User.id)
                      .join(Ambulance, Ambulance.id == CrewProfile.ambulance_id)
                      .join(DarkStation, DarkStation.id == Ambulance.station_id)
                      .where(User.is_active.is_(True)).order_by(Ambulance.registration_number)).all()
    return {
        "hospital_staff": [{"email": e, "label": name} for e, name in staff if _SEEDED["hospital_staff"].match(e)],
        "crew": [{"email": e, "label": f"{reg} · {kind} · {station}"} for e, reg, kind, station in crew
                 if _SEEDED["crew"].match(e)],
    }


@router.get("/track/{token}")
def public_track(token: str, db: Session = Depends(get_db)):
    req = sharing.resolve(db, token)
    if req is None:
        raise HTTPException(404, "Link not found or expired")
    out = tracking.public_payload(db, req)
    db.commit()
    return out
