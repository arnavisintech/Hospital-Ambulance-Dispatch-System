"""Export the audit trail (NFR7) as JSON lines and verify its hash chain.

    python scripts/export_audit.py --out audit-20261024.jsonl

Prints a JSON summary (rows, id range, sha256 of the file, chain_ok). Exits 1 when the chain does not verify,
so a scheduled export also alerts on tampering.
"""
import argparse
import json
import pathlib
import sys
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))


def main(argv: list[str] | None = None) -> int:
    from app.audit_export import export_audit
    from app.db import SessionLocal

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--out", default=f"audit-{datetime.now(timezone.utc):%Y%m%d}.jsonl")
    args = p.parse_args(argv)
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with SessionLocal() as db, out.open("w", encoding="utf-8", newline="\n") as fp:
        summary = export_audit(db, fp)
    print(json.dumps({"file": str(out), **summary}, indent=2))
    if not summary["chain_ok"]:
        print(f"AUDIT CHAIN BROKEN at entry {summary['broken_at']}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
