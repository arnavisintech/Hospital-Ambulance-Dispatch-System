"""Authentication (STRQ2). Passwords are hashed with bcrypt and never logged or audited."""
import hashlib
import re
import secrets
import threading
import time
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import audit, ratelimit
from ..db import get_db
from ..deps import current_user
from ..models import (BillingRecord, EmergencyRequest, RequestStatus, Role, TripRecord, User,
                      utcnow)
from ..security import create_token, hash_password, verify_password
from ..services import trips
from ..services.billing import bill_out
from ..services.trips import user_ambulance_id, user_hospital_id

router = APIRouter(prefix="/api/auth", tags=["auth"])
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE = re.compile(r"^\+?[0-9][0-9\- ]{6,18}$")
LOGIN_FAILURES = ratelimit.limiter("login_failures", 5, 900)  # 5 wrong passwords / 15 min per IP + identifier
_signup = ratelimit.limit("signup", 10, 3600)                # account registration: 10 / hour per IP
_guest_flood_guard = ratelimit.limit("guest", 600, 3600)     # guest SOS calls incl. retries: flood guard only
GUEST_NEW = ratelimit.limiter("guest_new", 120, 3600)        # new guest accounts per IP (retries are free; CGNAT)
GUEST_RETRY_WINDOW = timedelta(minutes=10)                   # device id = retry key, never a lasting credential


def user_out(db: Session, u: User) -> dict:
    return {"id": u.id, "name": u.name, "phone": u.phone, "email": u.email, "role": u.role.value,
            "hospital_id": user_hospital_id(db, u) if u.role == Role.hospital_staff else None,
            "ambulance_id": user_ambulance_id(db, u) if u.role == Role.crew else None,
            "must_change_password": bool(u.must_change_password)}


def _token_response(db: Session, u: User) -> dict:
    return {"token": create_token(u.id, u.role.value, u.token_version or 0), "user": user_out(db, u)}


def _check_phone(v):
    if v is None or v == "":
        return None
    v = v.strip()
    if not _PHONE.match(v):
        raise ValueError("invalid phone number")
    return v


class RegisterIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    phone: str | None = None
    email: str | None = None
    password: str = Field(min_length=8, max_length=72)
    role: str = "requester"
    consent: bool  # privacy notice accepted (DPDP Act); must be true

    @field_validator("consent")
    @classmethod
    def _consent(cls, v):
        if v is not True:
            raise ValueError("you must accept the privacy notice to create an account")
        return v

    @field_validator("email")
    @classmethod
    def _email(cls, v):
        if v is None or v == "":
            return None
        v = v.strip().lower()
        if not _EMAIL.match(v):
            raise ValueError("invalid email")
        return v

    @field_validator("phone")
    @classmethod
    def _phone(cls, v):
        return _check_phone(v)


class GuestIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    # Random id the app keeps on the phone (crypto UUID); makes guest creation idempotent across retries.
    device_id: str | None = Field(default=None, min_length=32, max_length=64, pattern=r"^[A-Za-z0-9-]+$")
    phone: str | None = None

    @field_validator("phone")
    @classmethod
    def _phone(cls, v):
        return _check_phone(v)


class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=72)


class LoginIn(BaseModel):
    identifier: str
    password: str


@router.post("/register", status_code=201, dependencies=[Depends(_signup)])
def register(body: RegisterIn, db: Session = Depends(get_db)):
    if body.role != Role.requester.value:
        raise HTTPException(403, "Only requesters can self-register; staff accounts are created by an administrator")
    if not body.email and not body.phone:
        raise HTTPException(422, "Provide an email or a phone number")
    clauses = [c for c in (User.email == body.email if body.email else None,
                           User.phone == body.phone if body.phone else None) if c is not None]
    if db.execute(select(User).where(or_(*clauses))).first():
        raise HTTPException(409, "An account with this email or phone already exists")
    u = User(name=body.name.strip(), phone=body.phone, email=body.email,
             password_hash=hash_password(body.password), role=Role.requester, consented_at=utcnow())
    db.add(u)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "An account with this email or phone already exists")
    audit.log(db, "auth.register", "user", u.id, u.id, {"role": u.role.value})
    db.commit()
    return _token_response(db, u)


def _retry_of(u: User) -> bool:
    """A device id brings back only a live guest session created within the retry window."""
    created = trips.aware(u.created_at) if u.created_at else None
    return (u.is_guest and u.is_active and u.erased_at is None and (u.token_version or 0) == 0
            and created is not None and utcnow() - created <= GUEST_RETRY_WINDOW)


@router.post("/guest", status_code=201, dependencies=[Depends(_guest_flood_guard)])
def guest(response: Response, request: Request, body: GuestIn | None = None, db: Session = Depends(get_db)):
    """NFR5: 2-tap SOS. Creates a throw-away requester with a random password, once per device: a retry with the
    same device id returns the same account (200). Only a flood guard limits it per IP, because mobile carriers put
    many phones behind one address and this is the emergency path."""
    body = body or GuestIn()
    device_hash = hashlib.sha256(body.device_id.encode()).hexdigest() if body.device_id else None
    if device_hash:
        known = db.execute(select(User).where(User.guest_device_hash == device_hash)).scalar_one_or_none()
        if known is not None and _retry_of(known):
            response.status_code = 200
            return _token_response(db, known)
        if known is not None:   # outside the retry window (or revoked): the key is spent; this is a new person
            known.guest_device_hash = None
            db.flush()
    ok, retry = GUEST_NEW.hit(f"guest_new:{ratelimit.client_ip(request)}")
    if not ok:
        raise ratelimit.too_many(retry, "Too many new guest sessions from this network; call 108 if this is urgent")
    phone = body.phone
    if phone and db.execute(select(User).where(User.phone == phone)).first():
        phone = None  # never attach to / take over an existing account; SOS must still succeed
    u = User(name=(body.name or "Guest").strip() or "Guest", phone=phone,
             email=None, password_hash=hash_password(secrets.token_urlsafe(24)), role=Role.requester,
             is_guest=True, guest_device_hash=device_hash)
    db.add(u)
    try:
        db.flush()
    except IntegrityError:   # a concurrent retry from the same device created it first: return that account
        db.rollback()
        known = db.execute(select(User).where(User.guest_device_hash == device_hash)).scalar_one_or_none()             if device_hash else None
        if known is None or not _retry_of(known):
            raise HTTPException(409, "Please try again")
        response.status_code = 200
        return _token_response(db, known)
    audit.log(db, "auth.guest", "user", u.id, u.id, {})
    db.commit()
    return _token_response(db, u)


@router.post("/login")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    ident = body.identifier.strip()
    key = f"{ratelimit.client_ip(request)}:{ident.lower()}"
    wait = LOGIN_FAILURES.blocked(key)
    if wait:
        raise ratelimit.too_many(wait, "Too many failed sign-in attempts")
    u = db.execute(select(User).where(or_(User.email == ident.lower(), User.phone == ident))).scalars().first()
    if u is None or not verify_password(body.password, u.password_hash):
        LOGIN_FAILURES.hit(key)
        audit.log(db, "auth.login_failed", "user", u.id if u else None, u.id if u else None, {})
        db.commit()
        raise HTTPException(401, "Invalid credentials")
    if not u.is_active:
        raise HTTPException(403, "Account deactivated")
    LOGIN_FAILURES.reset(key)
    audit.log(db, "auth.login", "user", u.id, u.id, {"role": u.role.value})
    db.commit()
    return _token_response(db, u)


@router.get("/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return user_out(db, user)


@router.post("/password")
def change_password(body: PasswordChangeIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Change own password. Every other session (old tokens, websocket tickets) is revoked."""
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    if body.new_password == body.current_password:
        raise HTTPException(422, "Choose a password different from the current one")
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    user.token_version = (user.token_version or 0) + 1
    audit.log(db, "auth.password_change", "user", user.id, user.id, {})
    db.commit()
    return _token_response(db, user)


# ---------------------------------------------------------------- websocket tickets
# Browsers cannot set headers on a WebSocket, so the socket authenticates with a 30 s single-use ticket instead of
# putting the long-lived JWT in the URL (where it would land in proxy logs and browser history).
TICKET_TTL_S = 30
_tickets: dict[str, tuple[int, int, float]] = {}  # ticket -> (user_id, token_version, expires_at)
_tickets_lock = threading.Lock()


def _now() -> float:
    return time.monotonic()


@router.post("/ws-ticket")
def ws_ticket(user: User = Depends(current_user)):
    t = secrets.token_urlsafe(24)
    now = _now()
    with _tickets_lock:
        for k in [k for k, v in _tickets.items() if v[2] <= now]:
            del _tickets[k]
        _tickets[t] = (user.id, user.token_version or 0, now + TICKET_TTL_S)
    return {"ticket": t, "expires_in": TICKET_TTL_S}


def consume_ticket(db: Session, ticket: str) -> User | None:
    """Single use: the ticket is removed whether or not it is still valid. None = reject."""
    with _tickets_lock:
        entry = _tickets.pop(ticket, None)
    if entry is None or entry[2] <= _now():
        return None
    u = db.get(User, entry[0])
    if u is None or not u.is_active or (u.token_version or 0) != entry[1]:
        return None
    return u


# ---------------------------------------------------------------- DPDP: export and erasure
class EraseIn(BaseModel):
    password: str | None = Field(default=None, max_length=200)   # not needed for guest accounts (they never see one)


@router.get("/me/export")
def export_my_data(user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Everything HADS holds that identifies the caller (right to access)."""
    reqs = db.execute(select(EmergencyRequest).where(EmergencyRequest.requester_id == user.id)
                      .order_by(EmergencyRequest.id)).scalars().all()
    ids = [r.id for r in reqs]
    trip_rows = db.execute(select(TripRecord).where(TripRecord.request_id.in_(ids))).scalars().all() if ids else []
    bills = db.execute(select(BillingRecord).where(BillingRecord.trip_id.in_([t.id for t in trip_rows]))).scalars().all()         if trip_rows else []
    audit.log(db, "auth.export", "user", user.id, user.id, {"requests": len(reqs)})
    db.commit()
    return {
        "exported_at": utcnow().isoformat(),
        "user": {**user_out(db, user), "created_at": user.created_at.isoformat() if user.created_at else None,
                 "consented_at": user.consented_at.isoformat() if user.consented_at else None},
        "requests": [trips.request_out(db, r) for r in reqs],
        "trips": [{"id": t.id, "request_id": t.request_id, "handover_time": trips.iso(t.handover_time),
                   "response_time_seconds": t.response_time_seconds, "distance_km": t.distance_km,
                   "feedback": (t.summary or {}).get("feedback")} for t in trip_rows],
        "bills": [bill_out(db, b) for b in bills],
    }


@router.delete("/me")
def erase_me(body: EraseIn, user: User = Depends(current_user), db: Session = Depends(get_db)):
    """Right to erasure: remove personal data, keep de-identified trip, billing and audit records (legal retention)."""
    if not user.is_guest and not (body.password and verify_password(body.password, user.password_hash)):
        raise HTTPException(403, "Password is incorrect")
    reqs = db.execute(select(EmergencyRequest).where(EmergencyRequest.requester_id == user.id)).scalars().all()
    if any(r.status not in trips.TERMINAL for r in reqs):
        raise HTTPException(409, "You have a request in progress; erase your account after it is completed")
    for r in reqs:
        r.caller_name = r.caller_phone = r.notes = r.address = None
    user.name, user.email, user.phone = "Erased user", None, None
    user.is_active = False
    user.erased_at = utcnow()
    user.guest_device_hash = None
    user.token_version = (user.token_version or 0) + 1
    user.password_hash = hash_password(secrets.token_urlsafe(24))
    audit.log(db, "auth.erase", "user", user.id, user.id, {"requests_anonymised": len(reqs)})
    db.commit()
    return {"erased": True}
