"""Online backup of the SQLite database (safe while HADS is running) with rotation.

    python scripts/backup_sqlite.py --dest backups --keep 14
"""
import argparse
import pathlib
import sqlite3
import sys
from datetime import datetime, timezone

from sqlalchemy.engine import make_url


def backup(src_url: str, dest_dir: str, keep: int = 14) -> pathlib.Path:
    """Copy the live database with the SQLite online backup API; keep the newest `keep` copies."""
    src = make_url(src_url).database
    dest = pathlib.Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    out = dest / f"hads-{stamp}.db"
    s, d = sqlite3.connect(src), sqlite3.connect(out)
    try:  # sqlite3's context manager only commits; close explicitly so the files are released
        s.backup(d)
    finally:
        d.close()
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
        print("DATABASE_URL is not SQLite; use the PostgreSQL backup procedure (docs/OPERATIONS.md)", file=sys.stderr)
        return 2
    print(backup(url, a.dest, a.keep))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
