"""First-admin bootstrap (Task 3): replaces seeded known-password accounts in production."""
import pytest
from sqlalchemy import func, select

from app import bootstrap
from app.config import get_settings
from app.db import SessionLocal
from app.models import AuditLog, Role, User
from app.security import verify_password

PW = "Very-Strong-Pass-123"


@pytest.fixture
def admin_env(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "bootstrap_admin_email", "root@hads.test")
    monkeypatch.setattr(s, "bootstrap_admin_password", PW)
    return s


def test_creates_one_admin_on_empty_db(admin_env):
    with SessionLocal() as db:
        u = bootstrap.ensure_bootstrap_admin(db)
        assert u is not None and u.role == Role.admin and u.is_active
        assert verify_password(PW, u.password_hash)
        assert db.scalar(select(func.count()).select_from(AuditLog).where(AuditLog.action == "auth.bootstrap")) == 1
        assert bootstrap.ensure_bootstrap_admin(db) is None
        assert db.scalar(select(func.count(User.id))) == 1


def test_skips_when_users_exist(admin_env, world):
    world.user(Role.requester)
    with SessionLocal() as db:
        assert bootstrap.ensure_bootstrap_admin(db) is None
        assert db.scalar(select(func.count(User.id)).where(User.role == Role.admin)) == 0


def test_skips_when_not_configured():
    with SessionLocal() as db:
        assert bootstrap.ensure_bootstrap_admin(db) is None


def test_short_password_rejected():
    with SessionLocal() as db, pytest.raises(ValueError):
        bootstrap.create_admin(db, "Root", "root@hads.test", "short-pw")
