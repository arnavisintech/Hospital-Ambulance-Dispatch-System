"""Replace zone demographics from a CSV file (see app/demographics.py for the format).

    python scripts/import_demographics.py chennai_wards.csv
"""
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from app import demographics  # noqa: E402
from app.db import SessionLocal  # noqa: E402


def main(path: str) -> int:
    rows, errors = demographics.parse_demographics_csv(pathlib.Path(path).read_text(encoding="utf-8-sig"))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    with SessionLocal() as db:
        out = demographics.replace_demographics(db, rows, "import")
        db.commit()
    print(out)
    print("Retrain the demand model from Admin > Settings (or POST /api/analytics/retrain) to use the new data.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
