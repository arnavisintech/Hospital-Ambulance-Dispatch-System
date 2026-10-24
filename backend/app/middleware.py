"""Request context: an `X-Request-ID` per HTTP request (accepted from the proxy when well-formed, else generated),
echoed on the response, bound to every log record and written to the access log."""
from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
import weakref

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


class ConcurrencyLimitMiddleware:
    """Admission control: at most `limit` API requests are in flight; the rest wait here, holding no DB connection.

    A sync FastAPI request hops between worker threads (auth dependency, endpoint, teardown) and keeps its DB session's
    connection while it waits for the next thread. Unbounded, an SOS burst parks hundreds of requests that each hold a
    connection while every worker thread waits for one: a deadlock until the pool timeout. Capping in-flight requests
    below the pool size (Settings.api_threads vs db_pool_size + db_max_overflow) makes that impossible. Health probes
    and websockets are never queued.
    """

    EXEMPT = ("/api/health", "/api/ready")

    def __init__(self, app, limit: int):
        self.app = app
        self.limit = limit
        self._sems: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()   # one per event loop (tests run several)

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/") or scope["path"] in self.EXEMPT:
            return await self.app(scope, receive, send)
        loop = asyncio.get_running_loop()
        sem = self._sems.get(loop)
        if sem is None:
            sem = self._sems[loop] = asyncio.Semaphore(self.limit)
        async with sem:
            await self.app(scope, receive, send)
