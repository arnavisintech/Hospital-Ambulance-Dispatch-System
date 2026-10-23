"""Authentication (STRQ2). Passwords are hashed with bcrypt and never logged or audited."""
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .. import audit, ratelimit
from ..db import get_db
from ..deps import current_user
from ..models import Role, User
from ..security import create_token, hash_password, verify_password
from ..services.trips import user_ambulance_id, user_hospital_id

router = APIRouter(prefix="/api/auth", tags=["auth"])
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_PHONE = re.compile(r"^\+?[0-9][0-9\- ]{6,18}$")
LOGIN_FAILURES = ratelimit.limiter("login_failures", 5, 900)  # 5 wrong passwords / 15 min per IP + identifier
_signup = ratelimit.limit("signup", 10, 3600)                # register + guest: 10 / hour per IP


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
             password_hash=hash_password(body.password), role=Role.requester)
    db.add(u)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "An account with this email or phone already exists")
    audit.log(db, "auth.register", "user", u.id, u.id, {"role": u.role.value})
    db.commit()
    return _token_response(db, u)


@router.post("/guest", status_code=201, dependencies=[Depends(_signup)])
def guest(body: GuestIn | None = None, db: Session = Depends(get_db)):
    """NFR5: 2-tap SOS. Creates a throw-away requester with a random password."""
    body = body or GuestIn()
    phone = body.phone
    if phone and db.execute(select(User).where(User.phone == phone)).first():
        phone = None  # never attach to / take over an existing account; SOS must still succeed
    u = User(name=(body.name or "Guest").strip() or "Guest", phone=phone,
             email=None, password_hash=hash_password(secrets.token_urlsafe(24)), role=Role.requester)
    db.add(u)
    db.flush()
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
