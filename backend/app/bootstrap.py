"""First administrator for a fresh production database (no seeded known-password accounts).

Either set BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD for the first boot, or run
`python scripts/create_admin.py` inside the backend container.
"""
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import audit
from .config import get_settings
from .models import Role, User
from .security import hash_password

MIN_ADMIN_PASSWORD = 12


def create_admin(db: Session, name: str, email: str, password: str, must_change: bool = False) -> User:
    """Create an active admin and commit. Raises ValueError on a weak password or a taken email."""
    email = email.strip().lower()
    if len(password) < MIN_ADMIN_PASSWORD:
        raise ValueError(f"admin password must be at least {MIN_ADMIN_PASSWORD} characters")
    if "@" not in email:
        raise ValueError("invalid email")
    if db.scalar(select(User.id).where(User.email == email)):
        raise ValueError("a user with this email already exists")
    u = User(name=name.strip() or "Administrator", email=email, password_hash=hash_password(password),
             role=Role.admin, is_active=True, must_change_password=must_change)
    db.add(u)
    db.flush()
    audit.log(db, "auth.bootstrap", "user", u.id, None, {"role": "admin"})
    db.commit()
    return u


def ensure_bootstrap_admin(db: Session) -> User | None:
    """Create the configured first admin, only when the users table is empty. Returns it, or None."""
    s = get_settings()
    if not (s.bootstrap_admin_email and s.bootstrap_admin_password):
        return None
    if db.scalar(select(func.count(User.id))):
        return None
    return create_admin(db, "Administrator", s.bootstrap_admin_email, s.bootstrap_admin_password, must_change=True)
