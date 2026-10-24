"""docs/openapi.json is the API's source of truth; it must match the running code (regenerate with
`python scripts/export_openapi.py`)."""
import json
import pathlib

from app.main import app

DOC = pathlib.Path(__file__).resolve().parents[2] / "docs" / "openapi.json"


def test_committed_openapi_matches_the_app():
    assert DOC.exists(), "docs/openapi.json missing: run python scripts/export_openapi.py"
    committed = json.loads(DOC.read_text(encoding="utf-8"))
    assert committed == json.loads(json.dumps(app.openapi())), \
        "docs/openapi.json is out of date: run python scripts/export_openapi.py"
