"""Nominatim proxy with offline fallback (v2 section 8).

Nominatim usage policy: identifying User-Agent, at most 1 request/second, cache results. All three are enforced
here process-wide. When Nominatim is unreachable, slow, rate-limits us, or GEO_PROVIDER=offline, answers come
from the built-in gazetteer (app/places.py) instead -- the endpoints never fail because of the upstream.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict

import httpx

from .. import places
from ..config import get_settings

log = logging.getLogger("hads.geocode")

MIN_INTERVAL_S = 1.0       # Nominatim policy: max 1 request / second
MAX_QUEUE_WAIT_S = 2.0     # don't make a user wait in line longer than this; use the gazetteer instead
BACKOFF_S = 60.0           # after an upstream failure, skip Nominatim for this long
CACHE_TTL_S = 24 * 3600
CACHE_SIZE = 2048

_throttle = threading.Lock()
_last_call = 0.0
_down_until = 0.0
_client: httpx.Client | None = None
_cache: OrderedDict = OrderedDict()
_cache_lock = threading.Lock()


def set_http_client(client: httpx.Client | None) -> None:
    global _client
    _client = client


def reset() -> None:
    global _last_call, _down_until
    _last_call, _down_until = 0.0, 0.0
    with _cache_lock:
        _cache.clear()
    set_http_client(None)


def _http() -> httpx.Client:
    global _client
    if _client is None:
        s = get_settings()
        _client = httpx.Client(timeout=s.geo_timeout_s, headers={"User-Agent": s.geo_user_agent,
                                                                 "Accept-Language": "en"})
    return _client


def _cache_get(key):
    with _cache_lock:
        hit = _cache.get(key)
        if hit is None:
            return None
        ts, val = hit
        if time.monotonic() - ts > CACHE_TTL_S:
            del _cache[key]
            return None
        _cache.move_to_end(key)
        return val


def _cache_put(key, val) -> None:
    with _cache_lock:
        _cache[key] = (time.monotonic(), val)
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)


def _enabled() -> bool:
    return get_settings().geo_provider.lower() == "nominatim" and time.monotonic() >= _down_until


def _call(path: str, params: dict):
    """Throttled GET against Nominatim. Raises on any failure (callers fall back)."""
    global _last_call, _down_until
    if not _throttle.acquire(timeout=MAX_QUEUE_WAIT_S):
        raise TimeoutError("geocoder queue busy")
    try:
        wait = MIN_INTERVAL_S - (time.monotonic() - _last_call)
        if wait > 0:
            time.sleep(wait)
        _last_call = time.monotonic()
        s = get_settings()
        r = _http().get(f"{s.nominatim_url.rstrip('/')}{path}", params=params,
                        headers={"User-Agent": s.geo_user_agent})
        if r.status_code in (403, 429) or r.status_code >= 500:
            _down_until = time.monotonic() + BACKOFF_S
        r.raise_for_status()
        return r.json()
    except Exception:
        _down_until = max(_down_until, time.monotonic() + BACKOFF_S)
        raise
    finally:
        _throttle.release()


def _label_from_address(addr: dict, fallback: str) -> tuple[str, str]:
    locality = (addr.get("suburb") or addr.get("neighbourhood") or addr.get("city_district")
                or addr.get("quarter") or addr.get("town") or addr.get("village") or fallback)
    head = addr.get("amenity") or addr.get("building") or addr.get("road") or addr.get("pedestrian")
    label = f"{head}, {locality}" if head and head != locality else locality
    return label, locality


def _short(display_name: str, parts: int = 3) -> str:
    bits = [b.strip() for b in (display_name or "").split(",") if b.strip()]
    bits = [b for b in bits if b not in ("India", "Tamil Nadu")]
    return ", ".join(bits[:parts])


def reverse(lat: float, lng: float) -> dict:
    """{label, locality, address, source}"""
    key = ("rev", round(lat, 4), round(lng, 4))
    hit = _cache_get(key)
    if hit is not None:
        return hit
    if _enabled():
        try:
            j = _call("/reverse", {"format": "jsonv2", "lat": f"{lat:.6f}", "lon": f"{lng:.6f}", "zoom": 17,
                                   "addressdetails": 1})
            if isinstance(j, dict) and j.get("display_name"):
                label, locality = _label_from_address(j.get("address") or {}, places.zone_label(lat, lng))
                out = {"label": label, "locality": locality, "address": _short(j["display_name"], 5),
                       "source": "nominatim"}
                _cache_put(key, out)
                return out
        except Exception as e:  # noqa: BLE001
            log.warning("Nominatim reverse failed (%s); using gazetteer", e)
    return places.reverse(lat, lng)


def search(q: str, limit: int = 8) -> list[dict]:
    """[{label, lat, lng, source}] bounded to the Chennai metro bbox."""
    q = " ".join(q.split())
    key = ("search", q.lower())
    hit = _cache_get(key)
    if hit is not None:
        return hit
    if _enabled():
        try:
            b = places.BBOX
            j = _call("/search", {"format": "jsonv2", "q": q, "limit": limit, "countrycodes": "in",
                                  "viewbox": f"{b[0]},{b[3]},{b[2]},{b[1]}", "bounded": 1})
            if isinstance(j, list):
                out = []
                for item in j:
                    try:
                        la, ln = float(item["lat"]), float(item["lon"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    if places.in_bbox(la, ln):
                        out.append({"label": _short(item.get("display_name", "")), "lat": round(la, 6),
                                    "lng": round(ln, 6), "source": "nominatim"})
                if out:
                    _cache_put(key, out[:limit])
                    return out[:limit]
                local = places.search(q, limit)  # Nominatim found nothing in Chennai: try our localities
                _cache_put(key, local)
                return local
        except Exception as e:  # noqa: BLE001
            log.warning("Nominatim search failed (%s); using gazetteer", e)
    return places.search(q, limit)
