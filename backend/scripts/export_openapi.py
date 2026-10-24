"""Write the API's OpenAPI document to docs/openapi.json (the API contract; tests/test_openapi_current.py fails when it
is stale).

    python scripts/export_openapi.py
"""
import json
import os
import pathlib
import sys

BACKEND = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("AUTO_CREATE_SCHEMA", "true")   # importing the app must not require a migrated database


def main() -> int:
    from app.main import app
    out = BACKEND.parent / "docs" / "openapi.json"
    out.write_text(json.dumps(app.openapi(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {out} ({len(app.openapi()['paths'])} paths)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
