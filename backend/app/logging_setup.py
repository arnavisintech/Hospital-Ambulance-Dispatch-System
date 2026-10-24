"""Process-wide logging: human-readable by default, one JSON object per line when LOG_JSON=true.

Every record carries the current request id (set by middleware.RequestContextMiddleware) so a single
request can be followed across the access log, application logs and background work it triggers.
"""
from __future__ import annotations

import contextvars
import json
import logging
import sys
from datetime import datetime, timezone

request_id_var: contextvars.ContextVar[str | None] = contextvars.ContextVar("hads_request_id", default=None)

# Extra fields copied into JSON lines when a record carries them (logger.info(..., extra={...})).
_EXTRA = ("method", "path", "status", "ms", "client")


class _RequestIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if not getattr(record, "request_id", None):
            record.request_id = request_id_var.get() or "-"
        return True


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out = {"ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec="milliseconds"),
               "level": record.levelname, "logger": record.name, "msg": record.getMessage(),
               "request_id": getattr(record, "request_id", None) or request_id_var.get()}
        for k in _EXTRA:
            if hasattr(record, k):
                out[k] = getattr(record, k)
        if record.exc_info:
            out["exc"] = self.formatException(record.exc_info)
        return json.dumps(out, ensure_ascii=False, default=str)


def configure_logging(json_lines: bool = False, level: int = logging.INFO) -> None:
    """Idempotent: replaces the root handler installed by an earlier call."""
    root = logging.getLogger()
    for h in [h for h in root.handlers if getattr(h, "_hads", False)]:
        root.removeHandler(h)
    h = logging.StreamHandler(sys.stderr)
    h._hads = True  # type: ignore[attr-defined]
    h.addFilter(_RequestIdFilter())
    h.setFormatter(JsonFormatter() if json_lines else
                   logging.Formatter("%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s"))
    root.addHandler(h)
    root.setLevel(level)
