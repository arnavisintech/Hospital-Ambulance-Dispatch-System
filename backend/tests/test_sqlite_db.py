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
        assert c.execute(text("pragma busy_timeout")).scalar() == 5000


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
