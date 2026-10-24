"""Alembic environment: HADS models are the target metadata; the URL comes from the caller or DATABASE_URL."""
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from app import models  # noqa: F401  (registers every table on Base.metadata)
from app import db_sqlite
from app.config import get_settings
from app.db import Base

config = context.config
if config.config_file_name and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def _url() -> str:
    return config.get_main_option("sqlalchemy.url") or get_settings().database_url


def run_migrations_offline() -> None:
    url = _url()
    context.configure(url=url, target_metadata=target_metadata, literal_binds=True, compare_type=True,
                      render_as_batch=url.startswith("sqlite"), dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    url = _url()
    sqlite = url.startswith("sqlite")
    if sqlite:
        db_sqlite.ensure_parent_dir(url)
    # SQLite: batch migrations rebuild tables (copy, drop, rename); with foreign keys enforced, dropping a table that
    # other rows reference would fail or cascade. So migrations run with them off (SQLite's default; the app's own
    # engine turns them on) and the result is verified with PRAGMA foreign_key_check before it is accepted.
    engine = create_engine(url, poolclass=pool.NullPool, **({"connect_args": {"timeout": 30}} if sqlite else {}))
    try:
        with engine.connect() as connection:
            context.configure(connection=connection, target_metadata=target_metadata, compare_type=True,
                              render_as_batch=sqlite)
            with context.begin_transaction():
                context.run_migrations()
                if sqlite:
                    bad = connection.exec_driver_sql("PRAGMA foreign_key_check").fetchall()
                    if bad:
                        raise RuntimeError(f"migration left {len(bad)} foreign-key violation(s), first: {bad[0]}")
    finally:
        engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
