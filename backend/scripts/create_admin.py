"""Create an administrator account interactively.

    docker compose exec backend python scripts/create_admin.py
"""
import getpass
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import models  # noqa: E402,F401  (register tables)
from app.bootstrap import create_admin  # noqa: E402
from app.db import SessionLocal  # noqa: E402


def main() -> int:
    name = input("Name: ").strip()
    email = input("Email: ").strip()
    pw = getpass.getpass("Password (min 12 chars): ")
    if pw != getpass.getpass("Repeat password: "):
        print("Passwords do not match", file=sys.stderr)
        return 1
    try:
        with SessionLocal() as db:
            u = create_admin(db, name, email, pw)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    print(f"Created admin #{u.id} <{u.email}>")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
