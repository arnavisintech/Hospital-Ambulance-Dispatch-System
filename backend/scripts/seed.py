"""Seed the configured database with the Chennai demo dataset.

    python scripts/seed.py            # idempotent: does nothing if data exists
    python scripts/seed.py --reset    # DROP ALL TABLES first (development only!)
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import models  # noqa: E402,F401
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.seed import seed_if_empty  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="drop all tables first (destroys data)")
    args = ap.parse_args()
    if args.reset:
        Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    t0 = time.time()
    with SessionLocal() as db:
        done = seed_if_empty(db)
    print(("seeded" if done else "database already populated; nothing to do") + f" in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
