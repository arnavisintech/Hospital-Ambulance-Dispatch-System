"""Online backup of the SQLite database (safe while HADS is running) with rotation.

    python scripts/backup_sqlite.py --dest backups --keep 14
"""
import argparse
import pathlib
import sqlite3
import sys
from datetime import datetime, timezone

from sqlalchemy.engine import make_url


BACKEND = pathlib.Path(__file__).resolve().parents[1]


def resolve_sqlite_path(url: str) -> pathlib.Path:
    """The SQLite file a URL names; relative paths are relative to backend/ (where the app runs), not the cwd."""
    p = pathlib.Path(make_url(url).database or "")
    return p if p.is_absolute() else (BACKEND / p).resolve()


def backup(src_url: str, dest_dir: str, keep: int = 14) -> pathlib.Path:
    """Copy the live database with the SQLite online backup API; keep the newest `keep` copies. Refuses a missing or
    non-HADS source rather than copying an empty file (which rotation would then keep instead of real backups)."""
    src = resolve_sqlite_path(src_url)
    if not src.is_file():
        raise RuntimeError(f"database file not found: {src}")
    s = sqlite3.connect(f"file:{src.as_posix()}?mode=ro", uri=True)   # read-only: never creates a file
    try:
        if not s.execute("select 1 from sqlite_master where type = 'table' and name = 'users'").fetchone():
            raise RuntimeError(f"{src} is not a HADS database (no users table)")
        dest = pathlib.Path(dest_dir)
        dest.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        out = dest / f"hads-{stamp}.db"
        d = sqlite3.connect(out)
        try:  # sqlite3's context manager only commits; close explicitly so the files are released
            s.backup(d)
        finally:
            d.close()
    finally:
        s.close()
    for old in sorted(dest.glob("hads-*.db"))[:-keep] if keep > 0 else []:
        old.unlink()
    return out


def main() -> int:
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
    from app.config import get_settings

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dest", default="backups")
    ap.add_argument("--keep", type=int, default=14)
    a = ap.parse_args()
    url = get_settings().database_url
    if not url.startswith("sqlite"):
        print("DATABASE_URL is not SQLite; use the PostgreSQL backup procedure (scripts/restore-db.sh)", file=sys.stderr)
        return 2
    try:
        print(backup(url, a.dest, a.keep))
    except RuntimeError as e:
        print(f"BACKUP FAILED: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
