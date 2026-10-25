"""SQLite as a first-class database (Task 30): WAL, foreign keys, busy timeout, online backup."""
import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app import db_sqlite
from app.config import Settings
from app.db import Base
from app.models import Ambulance


def _engine(path: Path):
    eng = create_engine(f"sqlite:///{path}", connect_args={"check_same_thread": False})
    db_sqlite.configure(eng)
    return eng


def test_pragmas_applied(tmp_path):
    eng = _engine(tmp_path / "a.db")
    with eng.connect() as c:
        assert c.execute(text("pragma journal_mode")).scalar() == "wal"
        assert c.execute(text("pragma foreign_keys")).scalar() == 1
        assert c.execute(text("pragma busy_timeout")).scalar() == 15000   # an SOS burst must wait, not fail


def test_foreign_keys_enforced(tmp_path):
    eng = _engine(tmp_path / "b.db")
    Base.metadata.create_all(eng)
    with sessionmaker(bind=eng)() as s:
        s.add(Ambulance(station_id=999, registration_number="TN01ZZ0001"))
        with pytest.raises(IntegrityError):
            s.commit()


def test_default_url_is_persistent_data_dir(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert Settings(_env_file=None).database_url == "sqlite:///./data/hads.db"


def test_ensure_parent_dir(tmp_path):
    target = tmp_path / "nested" / "dir" / "hads.db"
    db_sqlite.ensure_parent_dir(f"sqlite:///{target}")
    assert target.parent.is_dir()


def test_online_backup_and_prune(tmp_path):
    from scripts.backup_sqlite import backup
    src = tmp_path / "src.db"
    eng = _engine(src)
    Base.metadata.create_all(eng)
    with eng.begin() as c:
        c.execute(text("insert into platform_settings(key, value) values ('k', '{}')"))
    dest = tmp_path / "backups"
    outs = [backup(f"sqlite:///{src}", str(dest), keep=2) for _ in range(3)]
    left = sorted(dest.glob("hads-*.db"))
    assert len(left) == 2 and outs[-1] in left
    with sqlite3.connect(outs[-1]) as c:
        assert c.execute("select count(*) from platform_settings").fetchone()[0] == 1


def test_connection_pool_is_sized_from_settings():
    """SQLAlchemy's default pool (5 + 10 overflow) starved an SOS burst; the size is a setting with a larger default."""
    from app.config import Settings
    from app.db import engine
    s = Settings(_env_file=None)
    assert (s.db_pool_size, s.db_max_overflow) == (20, 40)
    assert engine.pool.size() == s.db_pool_size and engine.pool._max_overflow == s.db_max_overflow


def test_connection_pool_outnumbers_request_threads():
    """Each in-flight request holds a connection while waiting for its next worker thread; if threads outnumber
    connections a burst deadlocks (all threads waiting for a connection, all connections waiting for a thread)."""
    from app.config import Settings
    s = Settings(_env_file=None)
    assert s.db_pool_size + s.db_max_overflow >= s.api_threads + 10
    bad = Settings(_env_file=None, app_env="production", jwt_secret="x" * 40, cors_origins="https://a.example",
                   data_encryption_key="k", db_pool_size=5, db_max_overflow=10, api_threads=40)
    assert any("DB_POOL_SIZE" in p for p in bad.production_problems())


def test_lifespan_sizes_the_request_thread_pool(monkeypatch):
    import anyio.to_thread
    from fastapi.testclient import TestClient

    from app import main
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "api_threads", 33)
    async def tokens():
        return anyio.to_thread.current_default_thread_limiter().total_tokens
    with TestClient(main.app) as c:
        assert c.portal.call(tokens) == 33   # read inside the app's own event loop


def test_backup_refuses_a_missing_or_empty_source(tmp_path, monkeypatch):
    """Final review: run from the repo root, the relative default URL pointed at a non-existent file, sqlite created an
    empty one, and the 'backup' silently copied nothing (rotation would then delete the real backups)."""
    import pytest

    from scripts.backup_sqlite import backup
    dest = tmp_path / "b"
    with pytest.raises(RuntimeError, match="not found"):
        backup(f"sqlite:///{tmp_path / 'missing.db'}", str(dest))
    assert not (tmp_path / "missing.db").exists()                 # nothing was created in its place
    empty = tmp_path / "empty.db"
    sqlite3.connect(empty).close()
    with pytest.raises(RuntimeError, match="not a HADS database"):
        backup(f"sqlite:///{empty}", str(dest))


def test_backup_resolves_relative_urls_against_the_backend_folder(monkeypatch):
    """`sqlite:///./data/hads.db` means backend/data/hads.db wherever the script is started from."""
    import pathlib

    from scripts.backup_sqlite import resolve_sqlite_path
    backend = pathlib.Path(__file__).resolve().parents[1]
    monkeypatch.chdir(backend.parent)                       # the repository root, as OPERATIONS.md documents
    assert resolve_sqlite_path("sqlite:///./data/hads.db") == backend / "data" / "hads.db"
