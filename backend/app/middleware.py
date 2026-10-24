"""Request context: an `X-Request-ID` per HTTP request (accepted from the proxy when well-formed, else generated),
echoed on the response, bound to every log record and written to the access log."""
from __future__ import annotations

import logging
import re
import time
import uuid

from .logging_setup import request_id_var

access_log = logging.getLogger("hads.access")
_SAFE_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")


def _request_id(headers: list[tuple[bytes, bytes]]) -> str:
    for k, v in headers:
        if k == b"x-request-id":
            rid = v.decode("latin-1").strip()
            if _SAFE_ID.match(rid):
                return rid
            break
    return uuid.uuid4().hex


class RequestContextMiddleware:
    """Pure ASGI (no body buffering, websockets pass through with their request id bound)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        rid = _request_id(scope.get("headers") or [])
        token = request_id_var.set(rid)
        start = time.perf_counter()
        status = {"code": 500}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                message.setdefault("headers", [])
                message["headers"] = [*message["headers"], (b"x-request-id", rid.encode("latin-1"))]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            if scope["type"] == "http":
                ms = round((time.perf_counter() - start) * 1000, 1)
                access_log.info("%s %s %s %.1fms", scope["method"], scope["path"], status["code"], ms,
                                extra={"request_id": rid, "method": scope["method"], "path": scope["path"],
                                       "status": status["code"], "ms": ms})
            request_id_var.reset(token)
