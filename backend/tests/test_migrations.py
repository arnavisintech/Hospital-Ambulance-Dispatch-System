"""Alembic migrations produce exactly the model schema, including the audit triggers (Task 22)."""
import pathlib

import pytest
from alembic import command
from alembic.autogenerate import compare_metadata
from alembic.config import Config
from alembic.migration import MigrationContext
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import DatabaseError

from app.db import Base

BACKEND = pathlib.Path(__file__).resolve().parents[1]


def _cfg(url: str) -> Config:
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url)
    cfg.attributes["configure_logger"] = False  # keep the test session's logging untouched
    return cfg


@pytest.fixture
def url(tmp_path):
    return f"sqlite:///{(tmp_path / 'm.db').as_posix()}"


def test_upgrade_matches_models(url):
    command.upgrade(_cfg(url), "head")
    eng = create_engine(url)
    try:
        with eng.connect() as conn:
            diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}), Base.metadata)
        assert diff == []
    finally:
        eng.dispose()


def test_upgrade_installs_audit_triggers(url):
    command.upgrade(_cfg(url), "head")
    eng = create_engine(url)
    try:
        with eng.begin() as conn:
            conn.execute(text("INSERT INTO audit_logs (ts, action, entity, details, prev_hash, hash) "
                              "VALUES ('2026-01-01 00:00:00', 'a', 'e', '{}', '', 'h')"))
        with eng.connect() as conn, pytest.raises(DatabaseError, match="append-only"):
            conn.execute(text("UPDATE audit_logs SET action = 'b'"))
    finally:
        eng.dispose()


def test_downgrade_base_leaves_no_tables(url):
    cfg = _cfg(url)
    command.upgrade(cfg, "head")
    command.downgrade(cfg, "base")
    eng = create_engine(url)
    try:
        assert [t for t in inspect(eng).get_table_names() if t != "alembic_version"] == []
    finally:
        eng.dispose()


def test_migrate_adopts_a_database_created_without_alembic(url):
    """Installs that ran before migrations existed (create_all) are stamped, not re-created."""
    from scripts.migrate import migrate
    eng = create_engine(url)
    try:
        Base.metadata.create_all(eng)
        assert migrate(url) == "stamped"
        assert migrate(url) == "upgraded"   # idempotent afterwards
        with eng.connect() as conn:
            assert conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
    finally:
        eng.dispose()


def test_migrate_upgrades_an_empty_database(url):
    from scripts.migrate import migrate
    assert migrate(url) == "upgraded"
    eng = create_engine(url)
    try:
        assert "emergency_requests" in inspect(eng).get_table_names()
    finally:
        eng.dispose()


def test_migrate_refuses_an_outdated_pre_migration_database(url):
    from scripts.migrate import SchemaMismatch, migrate
    eng = create_engine(url)
    try:
        Base.metadata.create_all(eng)
        with eng.begin() as conn:
            conn.execute(text("DROP TABLE share_links"))
        with pytest.raises(SchemaMismatch, match="differs"):
            migrate(url)
        assert "alembic_version" not in inspect(eng).get_table_names()   # nothing was stamped
    finally:
        eng.dispose()


def test_api_refuses_to_start_on_an_unmigrated_database(monkeypatch):
    from fastapi.testclient import TestClient

    from app import main
    from app.config import Settings
    monkeypatch.setattr(main, "get_settings", lambda: Settings(auto_create_schema=False))
    with pytest.raises(RuntimeError, match="migrate.py"):
        with TestClient(main.app):
            pass
