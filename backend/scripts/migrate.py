"""Bring the database schema to the latest Alembic revision (run before the API starts).

    python scripts/migrate.py

A database created before migrations existed (by create_all) is adopted with `alembic stamp head` when its
schema already matches the models; if it differs, nothing is changed and the command fails with instructions,
because stamping an out-of-date schema would hide missing columns until they crash a request.
"""
import pathlib
import sys

BACKEND = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


class SchemaMismatch(RuntimeError):
    pass


def _config(url: str):
    from alembic.config import Config
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "migrations"))
    cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    cfg.attributes["configure_logger"] = False
    return cfg


def _summary(diff: list, limit: int = 5) -> str:
    """'add_table api_clients, add_column emergency_requests.external_id, ...' from compare_metadata output."""
    out = []
    for d in diff[:limit]:
        if isinstance(d, tuple) and d and isinstance(d[0], str):
            obj = d[-1] if d[0].endswith("_column") else d[1]
            name = getattr(obj, "name", None) or str(obj)
            table = d[2] if d[0].endswith("_column") else None
            out.append(f"{d[0]} {table + '.' if table else ''}{name}")
        else:
            out.append(str(d)[:80])
    return ", ".join(out) + (", ..." if len(diff) > limit else "")


def migrate(url: str | None = None) -> str:
    """Returns "upgraded" or "stamped"; raises SchemaMismatch for a pre-migration database that differs."""
    from alembic import command
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext
    from sqlalchemy import create_engine, inspect

    from app import models  # noqa: F401
    from app.config import get_settings
    from app.db import Base

    url = url or get_settings().database_url
    cfg = _config(url)
    if url.startswith("sqlite"):
        from app import db_sqlite
        db_sqlite.ensure_parent_dir(url)
    eng = create_engine(url)
    try:
        tables = set(inspect(eng).get_table_names())
        if "alembic_version" not in tables and "users" in tables:
            try:
                with eng.connect() as conn:
                    diff = compare_metadata(MigrationContext.configure(conn, opts={"compare_type": True}),
                                            Base.metadata)
            except Exception as e:  # noqa: BLE001 - e.g. a foreign key to a table this old schema lacks
                diff = [f"schema could not be compared: {e}"]
            if diff:
                raise SchemaMismatch(
                    "This database was created before migrations and its schema differs from the current models "
                    f"({len(diff)} difference(s): {_summary(diff)}). Back it up, then recreate it (demo data: "
                    "delete the database file and restart, or run-local.ps1 -Reset) or migrate it by hand.")
            command.stamp(cfg, "head")
            return "stamped"
    finally:
        eng.dispose()
    command.upgrade(cfg, "head")
    return "upgraded"


def main() -> int:
    try:
        print(f"database schema {migrate()}")
    except SchemaMismatch as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
