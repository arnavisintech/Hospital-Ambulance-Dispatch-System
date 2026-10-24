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
    """Admission control: at most `limit` API requests do server-side work at once; the rest wait here, holding no DB
    connection.

    A sync FastAPI request hops between worker threads (auth dependency, endpoint, teardown) and keeps its DB session's
    connection while it waits for the next thread. Unbounded, an SOS burst parks hundreds of requests that each hold a
    connection while every worker thread waits for one: a deadlock until the pool timeout. Capping in-flight requests
    below the pool size (Settings.api_threads vs db_pool_size + db_max_overflow) makes that impossible.

    A slot covers only the server's own work, so a slow client cannot hold one: the request body is read in full
    before a slot is taken, and the slot is released when the response starts (FastAPI closes the request's DB session
    before sending). Waiting for a slot is bounded: after `wait_s` the caller gets 503 with Retry-After (the SOS screen
    queues and resends). Buffering is bounded too: per route (JSON calls are small; only the CSV upload is large, the
    same 6 MB nginx allows), an oversized Content-Length is refused before reading, and all bodies being buffered at
    once share `buffer_budget` bytes (beyond it: 503). Health probes and websockets are never queued.
    """

    EXEMPT = ("/api/health", "/api/ready")
    MAX_JSON_BODY = 256 * 1024
    UPLOAD_ROUTES = {"/api/admin/demographics/import": 6 * 1024 * 1024}

    def __init__(self, app, limit: int, wait_s: float = 15.0, buffer_budget: int = 64 * 1024 * 1024):
        self.app = app
        self.limit = limit
        self.wait_s = wait_s
        self.buffer_budget = buffer_budget
        self._buffered = 0   # bytes held by in-progress requests' bodies (single event loop per process)
        self._sems: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()   # one per event loop (tests run several)

    def _sem(self) -> asyncio.Semaphore:
        loop = asyncio.get_running_loop()
        sem = self._sems.get(loop)
        if sem is None:
            sem = self._sems[loop] = asyncio.Semaphore(self.limit)
        return sem

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith("/api/") or scope["path"] in self.EXEMPT:
            return await self.app(scope, receive, send)
        cap = self.UPLOAD_ROUTES.get(scope["path"], self.MAX_JSON_BODY)
        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > cap:
            return await _plain(send, 413, b'{"detail":"Request body too large"}')   # refused before reading
        held = 0   # bytes this request counts against the budget until it finishes (its body waits for a slot)
        try:
            chunks = []
            while True:                               # read the body before taking a slot
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                chunk = message.get("body", b"")
                held += len(chunk)
                self._buffered += len(chunk)
                if held > cap:
                    return await _plain(send, 413, b'{"detail":"Request body too large"}')
                if self._buffered > self.buffer_budget:
                    return await _plain(send, 503, b'{"detail":"Server busy, retry shortly"}', [(b"retry-after", b"2")])
                chunks.append(chunk)
                if not message.get("more_body"):
                    break
            body = b"".join(chunks)
            chunks.clear()
            await self._run(scope, body, receive, send)
        finally:
            self._buffered -= held

    async def _run(self, scope, body: bytes, receive, send) -> None:
        replayed = False

        async def replay():
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()                    # after the body: disconnect notifications

        sem = self._sem()
        try:
            await asyncio.wait_for(sem.acquire(), self.wait_s)
        except TimeoutError:
            return await _plain(send, 503, b'{"detail":"Server busy, retry shortly"}', [(b"retry-after", b"2")])
        released = False

        def release():
            nonlocal released
            if not released:
                released = True
                sem.release()

        async def send_and_release(message):
            if message["type"] == "http.response.start":
                release()                             # server work is done; a slow reader must not hold the slot
            await send(message)

        try:
            await self.app(scope, replay, send_and_release)
        finally:
            release()


async def _plain(send, status: int, body: bytes, extra: list | None = None) -> None:
    await send({"type": "http.response.start", "status": status,
                "headers": [(b"content-type", b"application/json"), *(extra or [])]})
    await send({"type": "http.response.body", "body": body})
