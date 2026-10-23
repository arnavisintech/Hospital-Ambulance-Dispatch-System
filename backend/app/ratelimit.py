"""In-process sliding-window rate limits (single backend instance is the supported topology).

Used for brute-force protection (login), sign-up abuse (register / guest) and SOS floods. Controllers and
idempotent SOS retries are never limited: emergency intake must not be blocked by a safety limit.
"""
import threading
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request


class RateLimiter:
    def __init__(self, limit: int, window_s: float, clock=time.monotonic):
        self.limit, self.window_s, self.clock = limit, window_s, clock
        self._hits: dict[str, deque] = defaultdict(deque)
        self._lock = threading.Lock()

    def _trim(self, q: deque, now: float) -> None:
        while q and now - q[0] >= self.window_s:
            q.popleft()

    def hit(self, key: str) -> tuple[bool, float]:
        """Record one event for `key`. Returns (allowed, retry_after_s); a denied event is not recorded."""
        now = self.clock()
        with self._lock:
            q = self._hits[key]
            self._trim(q, now)
            if len(q) >= self.limit:
                return False, max(0.001, self.window_s - (now - q[0]))
            q.append(now)
            return True, 0.0

    def blocked(self, key: str) -> float:
        """Seconds until `key` may act again (0 = not blocked). Does not record an event."""
        now = self.clock()
        with self._lock:
            q = self._hits.get(key)
            if not q:
                return 0.0
            self._trim(q, now)
            return max(0.001, self.window_s - (now - q[0])) if len(q) >= self.limit else 0.0

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._hits.clear()


_registry: dict[str, RateLimiter] = {}
_reg_lock = threading.Lock()


def limiter(name: str, limit: int, window_s: float) -> RateLimiter:
    with _reg_lock:
        if name not in _registry:
            _registry[name] = RateLimiter(limit, window_s)
        return _registry[name]


def reset_all() -> None:
    for rl in list(_registry.values()):
        rl.clear()


def client_ip(request: Request) -> str:
    """Peer address; uvicorn --proxy-headers already rewrites it from X-Forwarded-For behind nginx."""
    return request.client.host if request.client else "unknown"


def too_many(retry_after: float, what: str = "Too many requests") -> HTTPException:
    return HTTPException(429, f"{what}; try again in {int(retry_after) + 1} s",
                         headers={"Retry-After": str(int(retry_after) + 1)})


def limit(name: str, limit_n: int, window_s: float):
    """FastAPI dependency: at most `limit_n` calls per client IP per window."""
    rl = limiter(name, limit_n, window_s)

    def dep(request: Request) -> None:
        ok, retry = rl.hit(f"{name}:{client_ip(request)}")
        if not ok:
            raise too_many(retry)
    return dep
