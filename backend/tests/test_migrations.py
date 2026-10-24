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


def test_0002_keeps_existing_trips_and_backfills_their_station(url):
    """Upgrading a database that already holds trips and bills must keep every row and fill trip_records.station_id."""
    cfg = _cfg(url)
    command.upgrade(cfg, "0001")
    eng = create_engine(url)
    try:
        with eng.begin() as conn:
            conn.execute(text("INSERT INTO hospitals (id, name, address, lat, lng, total_beds, available_beds, total_icu, available_icu, "
                              "specialists, revenue_share_pct, partner_verified) VALUES (1, 'H', '', 13.0, 80.2, 10, 5, 2, 1, '{}', 70, 1)"))
            conn.execute(text("INSERT INTO dark_stations (id, hospital_id, name, address, lat, lng, is_active) VALUES (7, 1, 'S', '', 13.0, 80.2, 1)"))
            conn.execute(text("INSERT INTO ambulances (id, station_id, registration_number, kind, status, staffed) "
                              "VALUES (3, 7, 'TN01AB0001', 'BLS', 'available', 1)"))
            conn.execute(text("INSERT INTO emergency_requests (id, channel, lat, lng, incident_type, severity, patient_age_group, "
                              "status, created_at) VALUES (11, 'app', 13.0, 80.2, 'other', 3, 'unknown', 'completed', '2026-10-01 10:00:00')"))
            conn.execute(text("INSERT INTO trip_records (id, request_id, ambulance_id, closed_manually, summary) "
                              "VALUES (5, 11, 3, 0, '{}')"))
            conn.execute(text("INSERT INTO billing_records (id, trip_id, base_fare, distance_charge, surcharge, amount, "
                              "hospital_share, platform_share, payment_status, created_at) "
                              "VALUES (9, 5, 500, 0, 0, 500, 350, 150, 'pending', '2026-10-01 11:00:00')"))
        command.upgrade(cfg, "head")
        with eng.connect() as conn:
            assert conn.execute(text("SELECT station_id FROM trip_records WHERE id = 5")).scalar() == 7
            assert conn.execute(text("SELECT count(*) FROM billing_records WHERE trip_id = 5")).scalar() == 1
        command.downgrade(cfg, "0001")
        with eng.connect() as conn:
            assert conn.execute(text("SELECT count(*) FROM billing_records")).scalar() == 1
    finally:
        eng.dispose()
