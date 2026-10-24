"""NFR7: export the audit trail as JSON lines for off-site retention, with a SHA-256 of the file and a chain check."""
from __future__ import annotations

import hashlib
import json
from datetime import timezone
from typing import TextIO

from sqlalchemy import select
from sqlalchemy.orm import Session

from .audit import verify_chain
from .models import AuditLog

BATCH = 1000


def _row(r: AuditLog) -> dict:
    ts = r.ts if r.ts.tzinfo else r.ts.replace(tzinfo=timezone.utc)  # SQLite drops tzinfo
    return {"id": r.id, "ts": ts.isoformat(), "user_id": r.user_id, "action": r.action, "entity": r.entity,
            "entity_id": r.entity_id, "details": r.details or {}, "prev_hash": r.prev_hash, "hash": r.hash}


def export_audit(db: Session, fp: TextIO) -> dict:
    """Write every audit row, oldest first, one JSON object per line. Returns a summary including whether the
    hash chain verifies and the SHA-256 of exactly the text written."""
    sha = hashlib.sha256()
    n, first, last = 0, None, None
    for r in db.execute(select(AuditLog).order_by(AuditLog.id).execution_options(yield_per=BATCH)).scalars():
        line = json.dumps(_row(r), sort_keys=True, ensure_ascii=False, default=str) + "\n"
        fp.write(line)
        sha.update(line.encode("utf-8"))
        n, first, last = n + 1, first if first is not None else r.id, r.id
    chain = verify_chain(db)
    return {"rows": n, "first_id": first, "last_id": last, "chain_ok": chain["ok"], "broken_at": chain["broken_at"],
            "sha256": sha.hexdigest()}
