"""SQLite tuning for production use on a single host: WAL (readers never block the writer), enforced foreign
keys, a busy timeout instead of immediate 'database is locked' errors, and NORMAL sync (durable with WAL)."""
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.engine import Engine, make_url

BUSY_TIMEOUT_MS = 5000


def configure(engine: Engine) -> None:
    @event.listens_for(engine, "connect")
    def _pragmas(dbapi_conn, _record):
        cur = dbapi_conn.cursor()
        cur.execute("pragma journal_mode=WAL")
        cur.execute("pragma foreign_keys=ON")
        cur.execute(f"pragma busy_timeout={BUSY_TIMEOUT_MS}")
        cur.execute("pragma synchronous=NORMAL")
        cur.close()


def ensure_parent_dir(url: str) -> None:
    """Create the directory holding a file-based SQLite database."""
    db = make_url(url).database
    if db and db != ":memory:":
        Path(db).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
