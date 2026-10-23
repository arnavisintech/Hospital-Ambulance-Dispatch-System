"""Routing provider (FR4/FR6, v2 section 1).

Two providers behind one interface:

* ``haversine`` -- straight-line distance x detour factor at an average urban speed. Always available; used in
  tests and as the automatic fallback.
* ``osrm`` -- self-hosted OSRM (Chennai extract, MLD). ``/table`` ranks many candidates in ONE call (NFR1),
  ``/route`` (steps=true, geometries=geojson) produces road-following polylines and turn-by-turn steps.

OSRM only knows free-flow speeds (no live traffic), so the same time-of-day traffic multiplier used by the
haversine provider is applied on top of every OSRM duration.

Resilience: every OSRM call has a hard timeout (``osrm_timeout_s``, 1.5 s). A small circuit breaker opens after
``osrm_breaker_failures`` consecutive failures and skips OSRM for ``osrm_breaker_cooldown_s`` seconds, so a dead
router costs dispatch at most one timeout instead of one per request. Any failure falls back to haversine.
Routes are cached for ``route_cache_ttl_s`` seconds (keyed on ~11 m rounded endpoints + traffic band).
"""
from __future__ import annotations

import logging
import math
import threading
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

import httpx

from ..config import get_settings
from ..geo import haversine_km

log = logging.getLogger("hads.routing")

DETOUR_FACTOR = 1.35  # road distance / straight-line distance for a dense grid city
Point = tuple[float, float]


# ---------------------------------------------------------------- shared helpers
def traffic_factor(hour: int | None = None) -> float:
    """Multiplier (>=1) applied to free-flow travel time for the hour of day (0..23, IST)."""
    if hour is None:
        hour = datetime.now(timezone(timedelta(hours=5, minutes=30))).hour  # pilot city is IST
    if 8 <= hour < 11 or 17 <= hour < 21:
        return 1.6   # peak
    if 11 <= hour < 17 or 7 <= hour < 8 or 21 <= hour < 22:
        return 1.25  # shoulder
    return 1.0       # night / free flow


def road_km(a: Point, b: Point) -> float:
    return haversine_km(a[0], a[1], b[0], b[1]) * DETOUR_FACTOR


def bearing(a: Point, b: Point) -> float:
    """Initial compass bearing a -> b in degrees (0 = north, clockwise)."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


_bearing = bearing  # backwards-compatible alias


def compass(deg: float) -> str:
    return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][int(((deg + 22.5) % 360) // 45)]


def _first_bearing(poly: list[list[float]]) -> float | None:
    for i in range(1, len(poly)):
        if haversine_km(poly[0][0], poly[0][1], poly[i][0], poly[i][1]) > 0.003:
            return round(bearing(tuple(poly[0]), tuple(poly[i])), 1)
    return None


# ---------------------------------------------------------------- haversine provider
def _haversine_eta(a: Point, b: Point, hour: int | None) -> int:
    s = get_settings()
    km = road_km(a, b)
    return max(1, int(round(km / s.avg_speed_kmph * 3600 * traffic_factor(hour))))


def _haversine_route(a: Point, b: Point, hour: int | None) -> dict:
    total_km = road_km(a, b)
    eta = _haversine_eta(a, b, hour)
    n = max(1, min(6, int(total_km // 1.0) + 1))  # ~1 km legs, at most 6 steps
    pts = [(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n) for i in range(n + 1)]
    steps = []
    for i in range(n):
        d = compass(bearing(pts[i], pts[i + 1]))
        steps.append({"instruction": f"Head {d}" if i == 0 else f"Continue {d}", "name": "",
                      "maneuver": {"type": "depart" if i == 0 else "continue", "modifier": None if i == 0 else "straight"},
                      "distance_m": int(total_km * 1000 / n), "duration_s": int(round(eta / n)),
                      "lat": round(pts[i][0], 6), "lng": round(pts[i][1], 6)})
    steps.append({"instruction": "Arrive at destination", "name": "", "maneuver": {"type": "arrive", "modifier": None},
                  "distance_m": 0, "duration_s": 0, "lat": round(b[0], 6), "lng": round(b[1], 6)})
    poly = [[round(p[0], 6), round(p[1], 6)] for p in pts]
    return {"steps": steps, "polyline": poly, "distance_km": round(total_km, 2), "eta_seconds": eta,
            "bearing_deg": _first_bearing(poly), "provider": "haversine"}


# ---------------------------------------------------------------- OSRM provider
class CircuitBreaker:
    """closed -> (N consecutive failures) -> open for `cooldown` s -> half-open (one probe) -> closed/open."""

    def __init__(self, failures: int, cooldown_s: float, clock=time.monotonic):
        self.max_failures, self.cooldown_s, self.clock = failures, cooldown_s, clock
        self.failures = 0
        self.opened_at: float | None = None
        self._probe = False
        self._lock = threading.Lock()

    @property
    def state(self) -> str:
        if self.opened_at is None:
            return "closed"
        return "half_open" if self.clock() - self.opened_at >= self.cooldown_s else "open"

    def allow(self) -> bool:
        with self._lock:
            st = self.state
            if st == "closed":
                return True
            if st == "half_open" and not self._probe:
                self._probe = True  # exactly one trial request while half-open
                return True
            return False

    def success(self) -> None:
        with self._lock:
            self.failures, self.opened_at, self._probe = 0, None, False

    def failure(self) -> None:
        with self._lock:
            self.failures += 1
            if self._probe or self.failures >= self.max_failures:
                if self.opened_at is None or self._probe:
                    log.warning("OSRM circuit opened after %d failure(s); using haversine for %.0fs",
                                self.failures, self.cooldown_s)
                self.opened_at = self.clock()
            self._probe = False


class OsrmUnavailable(RuntimeError):
    pass


_breaker: CircuitBreaker | None = None
_client: httpx.Client | None = None
_state_lock = threading.Lock()


def breaker() -> CircuitBreaker:
    global _breaker
    with _state_lock:
        if _breaker is None:
            s = get_settings()
            _breaker = CircuitBreaker(s.osrm_breaker_failures, s.osrm_breaker_cooldown_s)
        return _breaker


def http_client() -> httpx.Client:
    """Pooled keep-alive client (tests replace it with an httpx.MockTransport client via set_http_client)."""
    global _client
    with _state_lock:
        if _client is None:
            t = get_settings().osrm_timeout_s
            _client = httpx.Client(timeout=httpx.Timeout(t, connect=min(1.0, t)),
                                   limits=httpx.Limits(max_connections=20, max_keepalive_connections=10))
        return _client


def set_http_client(client: httpx.Client | None) -> None:
    global _client
    with _state_lock:
        _client = client


def reset() -> None:
    """Forget breaker state, HTTP client and caches (tests / config reload)."""
    global _breaker
    with _state_lock:
        _breaker = None
    set_http_client(None)
    _route_cache.clear()


def _osrm_get(path: str, params: dict) -> dict:
    br = breaker()
    if not br.allow():
        raise OsrmUnavailable("circuit open")
    url = f"{get_settings().osrm_url.rstrip('/')}{path}"
    try:
        r = http_client().get(url, params=params)
        r.raise_for_status()
        data = r.json()
        if data.get("code") != "Ok":
            # NoRoute / NoSegment are answers about the data, not router health
            if data.get("code") in ("NoRoute", "NoSegment"):
                br.success()
            raise OsrmUnavailable(f"OSRM code {data.get('code')}: {data.get('message')}")
    except OsrmUnavailable:
        raise
    except Exception as e:  # noqa: BLE001 - timeouts, connection errors, bad JSON, 5xx
        br.failure()
        raise OsrmUnavailable(str(e)) from e
    br.success()
    return data


def _coords(points: list[Point]) -> str:
    return ";".join(f"{p[1]:.6f},{p[0]:.6f}" for p in points)  # OSRM wants lng,lat


ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"]


def instruction(m_type: str, modifier: str | None, name: str, *, exit_no: int | None = None,
                bearing_after: float | None = None, last: bool = False) -> str:
    """Human turn instruction from an OSRM maneuver, e.g. ('turn', 'left', 'Anna Salai') -> 'Turn left onto Anna Salai'."""
    mod = (modifier or "").strip()
    onto = f" onto {name}" if name else ""
    on = f" on {name}" if name else ""
    if m_type == "depart":
        head = compass(bearing_after) if bearing_after is not None else "out"
        return f"Head {head}{on}"
    if m_type == "arrive":
        side = f" on the {mod}" if mod in ("left", "right") else ""
        return f"Arrive at destination{side}" if last else f"Arrive at waypoint{side}"
    if m_type in ("roundabout", "rotary"):
        ex = f"take the {ORDINALS[exit_no - 1]} exit" if exit_no and 0 < exit_no <= len(ORDINALS) else "take the exit"
        return f"At the roundabout, {ex}{onto}"
    if m_type in ("exit roundabout", "exit rotary"):
        return f"Exit the roundabout{onto}"
    if m_type == "roundabout turn":
        return f"At the roundabout, turn {mod}{onto}".replace("  ", " ")
    if mod == "uturn":
        return f"Make a U-turn{onto}"
    if m_type == "new name":
        return f"Continue{onto}" if name else "Continue straight"
    if m_type in ("continue", "notification", "use lane"):
        if mod in ("", "straight"):
            return f"Continue straight{on}"
        return f"Keep {mod.replace('slight ', '')}{on}"
    if m_type == "merge":
        return f"Merge {mod.replace('slight ', '')}{onto}".replace("  ", " ").replace("Merge straight", "Merge")
    if m_type == "on ramp":
        return f"Take the ramp on the {mod.replace('slight ', '')}{onto}" if mod else f"Take the ramp{onto}"
    if m_type == "off ramp":
        return f"Take the exit on the {mod.replace('slight ', '')}{onto}" if mod else f"Take the exit{onto}"
    if m_type == "fork":
        side = mod.replace("slight ", "") or "straight"
        return f"Keep {side} at the fork{onto}" if side != "straight" else f"Go straight at the fork{onto}"
    if m_type == "end of road":
        return f"At the end of the road, turn {mod.replace('slight ', '')}{onto}"
    # 'turn' and anything new OSRM may add
    if mod == "straight":
        return f"Go straight{onto}"
    if mod.startswith("slight "):
        return f"Bear {mod.split(' ', 1)[1]}{onto}"
    if mod.startswith("sharp "):
        return f"Turn sharp {mod.split(' ', 1)[1]}{onto}"
    return f"Turn {mod}{onto}".replace("  ", " ") if mod else f"Continue{onto}"


def _osrm_route(a: Point, b: Point, hour: int | None) -> dict:
    data = _osrm_get(f"/route/v1/driving/{_coords([a, b])}",
                     {"overview": "full", "geometries": "geojson", "steps": "true"})
    route = data["routes"][0]
    tf = traffic_factor(hour)
    steps = []
    raw = [st for leg in route["legs"] for st in leg["steps"]]
    for i, st in enumerate(raw):
        m = st.get("maneuver", {}) or {}
        loc = m.get("location", [b[1], b[0]])
        name = (st.get("name") or "").strip()
        if not name and st.get("ref"):
            name = st["ref"]
        m_type, mod = m.get("type", "turn"), m.get("modifier")
        steps.append({"instruction": instruction(m_type, mod, name, exit_no=m.get("exit"),
                                                 bearing_after=m.get("bearing_after"), last=i == len(raw) - 1),
                      "name": name, "maneuver": {"type": m_type, "modifier": mod},
                      "distance_m": int(round(st.get("distance", 0))),
                      "duration_s": int(round(st.get("duration", 0) * tf)),
                      "lat": round(loc[1], 6), "lng": round(loc[0], 6)})
    poly = [[round(c[1], 6), round(c[0], 6)] for c in route["geometry"]["coordinates"]]
    first = (raw[0].get("maneuver") or {}).get("bearing_after") if raw else None
    return {"steps": steps, "polyline": poly, "distance_km": round(route["distance"] / 1000, 2),
            "eta_seconds": max(1, int(round(route["duration"] * tf))),
            "bearing_deg": float(first) if first is not None else _first_bearing(poly), "provider": "osrm"}


def _osrm_table(sources: list[Point], destinations: list[Point], hour: int | None) -> list[list[tuple[int, float] | None]]:
    """Matrix [i][j] -> (eta_s with traffic, distance_km) or None when unroutable."""
    pts = sources + destinations
    ns = len(sources)
    data = _osrm_get(f"/table/v1/driving/{_coords(pts)}", {
        "sources": ";".join(str(i) for i in range(ns)),
        "destinations": ";".join(str(ns + j) for j in range(len(destinations))),
        "annotations": "duration,distance"})
    tf = traffic_factor(hour)
    durs, dists = data.get("durations") or [], data.get("distances") or []
    out = []
    for i in range(ns):
        row = []
        for j in range(len(destinations)):
            d = durs[i][j] if i < len(durs) and j < len(durs[i]) else None
            km = dists[i][j] / 1000 if i < len(dists) and j < len(dists[i]) and dists[i][j] is not None else None
            row.append(None if d is None else (max(1, int(round(d * tf))), km if km is not None else road_km(sources[i], destinations[j])))
        out.append(row)
    return out


def use_osrm() -> bool:
    return get_settings().routing_provider.lower() == "osrm"


_use_osrm = use_osrm  # backwards-compatible alias


# ---------------------------------------------------------------- route cache
class _TTLCache:
    def __init__(self, maxsize: int = 512):
        self.maxsize = maxsize
        self._d: OrderedDict = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key, ttl: float):
        with self._lock:
            hit = self._d.get(key)
            if hit is None:
                return None
            ts, val = hit
            if time.monotonic() - ts > ttl:
                del self._d[key]
                return None
            self._d.move_to_end(key)
            return val

    def put(self, key, val) -> None:
        with self._lock:
            self._d[key] = (time.monotonic(), val)
            self._d.move_to_end(key)
            while len(self._d) > self.maxsize:
                self._d.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._d.clear()


_route_cache = _TTLCache()


def _key(p: Point) -> tuple[float, float]:
    return (round(p[0], 4), round(p[1], 4))


# ---------------------------------------------------------------- public API
def eta_many(sources: list[Point], dest: Point, hour: int | None = None) -> list[int]:
    """Road-time ETA from each source to one destination -- ONE OSRM /table call (candidate ranking)."""
    if not sources:
        return []
    if use_osrm():
        try:
            m = _osrm_table(list(sources), [dest], hour)
            return [m[i][0][0] if m[i][0] is not None else _haversine_eta(sources[i], dest, hour)
                    for i in range(len(sources))]
        except Exception as e:  # noqa: BLE001
            log.warning("OSRM table failed (%s); falling back to haversine", e)
    return [_haversine_eta(s, dest, hour) for s in sources]


def eta_from(source: Point, dests: list[Point], hour: int | None = None) -> list[int]:
    """Road-time ETA from one source to each destination -- ONE OSRM /table call (hospital ranking)."""
    if not dests:
        return []
    if use_osrm():
        try:
            m = _osrm_table([source], list(dests), hour)
            return [m[0][j][0] if m[0][j] is not None else _haversine_eta(source, dests[j], hour)
                    for j in range(len(dests))]
        except Exception as e:  # noqa: BLE001
            log.warning("OSRM table failed (%s); falling back to haversine", e)
    return [_haversine_eta(source, d, hour) for d in dests]


def eta_seconds(a: Point, b: Point, hour: int | None = None) -> int:
    """Road-time ETA in seconds from a to b (never the straight-line distance)."""
    return eta_many([a], b, hour)[0]


def route(a: Point, b: Point, hour: int | None = None) -> dict:
    """{steps:[{instruction,name,maneuver:{type,modifier},distance_m,duration_s,lat,lng}], polyline:[[lat,lng]],
    distance_km, eta_seconds, bearing_deg, provider}. Cached briefly."""
    tf = traffic_factor(hour)
    osrm = use_osrm()
    key = ("osrm" if osrm else "hav", _key(a), _key(b), tf)
    hit = _route_cache.get(key, get_settings().route_cache_ttl_s)
    if hit is not None:
        return hit
    res = None
    if osrm:
        try:
            res = _osrm_route(a, b, hour)
        except Exception as e:  # noqa: BLE001
            log.warning("OSRM route failed (%s); falling back to haversine", e)
    if res is None:
        res = _haversine_route(a, b, hour)
    if res["provider"] == "osrm":  # never pin a fallback answer in the cache
        _route_cache.put(key, res)
    return res


def status() -> dict:
    """Provider diagnostics for /api/health."""
    out = {"provider": get_settings().routing_provider}
    if use_osrm():
        b = breaker()
        out.update(osrm_url=get_settings().osrm_url, circuit=b.state, consecutive_failures=b.failures)
    return out
