"""Active trip legs (v2 section 2): the road route an ambulance is currently following for a request.

One routed leg per (request, phase, destination) is computed when the leg starts and kept in memory; every
later position update only *projects* the ambulance onto that polyline to get the remaining route / ETA, so
live tracking costs one OSRM /route call per leg instead of one per GPS ping. The leg is recomputed (and a
`request.route` event published) when the phase or destination changes, or when the ambulance strays more than
OFF_ROUTE_M from the polyline (rate-limited to one reroute per REROUTE_MIN_S).

Process-local cache: fine for the single-instance pilot; for multi-instance deployment move it to Redis.
"""
from __future__ import annotations

import logging
import math
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field

from .. import events
from ..models import EmergencyRequest, Hospital, RequestStatus
from . import routing

log = logging.getLogger("hads.legs")
RS = RequestStatus
OFF_ROUTE_M = 150.0
REROUTE_MIN_S = 15.0
MAX_LEGS = 500

TO_PATIENT = {RS.offered, RS.accepted, RS.en_route}
TO_HOSPITAL = {RS.transporting, RS.arrived}

Point = tuple[float, float]


@dataclass
class Leg:
    request_id: int
    phase: str
    dest: Point
    poly: list[Point]
    cum_m: list[float]
    distance_km: float
    duration_s: int
    steps: list[dict]
    provider: str
    created: float = field(default_factory=time.monotonic)
    last_idx: int = 0

    @property
    def length_m(self) -> float:
        return self.cum_m[-1] if self.cum_m else 0.0


_legs: OrderedDict[int, Leg] = OrderedDict()
_lock = threading.Lock()


# ---------------------------------------------------------------- planar geometry (local equirectangular metres)
def _xy(p: Point, ref: Point) -> tuple[float, float]:
    k = 111_320.0
    return ((p[1] - ref[1]) * k * math.cos(math.radians(ref[0])), (p[0] - ref[0]) * k)


def _dist_m(a: Point, b: Point) -> float:
    x, y = _xy(b, a)
    return math.hypot(x, y)


def cumulative(poly: list[Point]) -> list[float]:
    out = [0.0]
    for i in range(1, len(poly)):
        out.append(out[-1] + _dist_m(poly[i - 1], poly[i]))
    return out


def project(poly: list[Point], cum: list[float], pos: Point) -> tuple[float, float, int]:
    """(distance along polyline in m, distance off the polyline in m, segment index) of the nearest point."""
    if len(poly) < 2:
        return 0.0, (_dist_m(poly[0], pos) if poly else 0.0), 0
    best = (float("inf"), 0.0, 0)
    for i in range(len(poly) - 1):
        a, b = poly[i], poly[i + 1]
        bx, by = _xy(b, a)
        px, py = _xy(pos, a)
        seg2 = bx * bx + by * by
        t = 0.0 if seg2 == 0 else max(0.0, min(1.0, (px * bx + py * by) / seg2))
        off = math.hypot(px - t * bx, py - t * by)
        if off < best[0]:
            best = (off, cum[i] + t * (cum[i + 1] - cum[i]), i)
    return best[1], best[0], best[2]


def point_at(poly: list[Point], cum: list[float], s: float) -> tuple[Point, int]:
    """Position at distance s (m) along the polyline, and the segment index it lies on."""
    if not poly:
        raise ValueError("empty polyline")
    if s <= 0 or len(poly) == 1:
        return poly[0], 0
    if s >= cum[-1]:
        return poly[-1], len(poly) - 2
    lo = 0
    hi = len(cum) - 1
    while lo < hi - 1:  # binary search for the segment containing s
        mid = (lo + hi) // 2
        if cum[mid] <= s:
            lo = mid
        else:
            hi = mid
    seg = cum[lo + 1] - cum[lo]
    t = 0.0 if seg == 0 else (s - cum[lo]) / seg
    a, b = poly[lo], poly[lo + 1]
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), lo


# ---------------------------------------------------------------- leg management
def target(db, req: EmergencyRequest) -> tuple[str, Point] | None:
    """(phase, destination) the ambulance should currently be driving, or None (no leg in this status)."""
    if req.status in TO_PATIENT:
        return "to_patient", (req.lat, req.lng)
    if req.status in TO_HOSPITAL and req.destination_hospital_id:
        h = db.get(Hospital, req.destination_hospital_id)
        if h is not None:
            return "to_hospital", (h.lat, h.lng)
    return None


def build_leg(request_id: int, phase: str, start: Point, dest: Point) -> Leg:
    r = routing.route(start, dest)
    poly = [tuple(p) for p in r["polyline"]] or [start, dest]
    if _dist_m(poly[0], start) > 1.0:
        poly.insert(0, start)  # OSRM snaps to the nearest road; keep the true start for smooth animation
    if _dist_m(poly[-1], dest) > 1.0:
        poly.append(dest)
    return Leg(request_id=request_id, phase=phase, dest=dest, poly=poly, cum_m=cumulative(poly),
               distance_km=float(r["distance_km"]), duration_s=int(r["eta_seconds"]), steps=r.get("steps", []),
               provider=r.get("provider", "haversine"))


def get(request_id: int) -> Leg | None:
    with _lock:
        return _legs.get(request_id)


def drop(request_id: int) -> None:
    with _lock:
        _legs.pop(request_id, None)


def clear() -> None:
    with _lock:
        _legs.clear()


def _store(leg: Leg) -> None:
    with _lock:
        _legs[leg.request_id] = leg
        _legs.move_to_end(leg.request_id)
        while len(_legs) > MAX_LEGS:
            _legs.popitem(last=False)


def ensure(db, req: EmergencyRequest, pos: Point) -> tuple[Leg | None, bool]:
    """Current leg for `req` given the ambulance position; (leg, changed). changed => new or rerouted."""
    tgt = target(db, req)
    if tgt is None:
        drop(req.id)
        return None, False
    phase, dest = tgt
    leg = get(req.id)
    if leg is not None and leg.phase == phase and _dist_m(leg.dest, dest) < 1.0:
        _s, off, idx = project(leg.poly, leg.cum_m, pos)
        if off <= OFF_ROUTE_M or time.monotonic() - leg.created < REROUTE_MIN_S:
            leg.last_idx = idx
            return leg, False
        log.info("request %s: ambulance %.0f m off route; rerouting", req.id, off)
    leg = build_leg(req.id, phase, pos, dest)
    _store(leg)
    return leg, True


def remaining(leg: Leg, pos: Point) -> dict:
    """{phase, polyline, distance_km, eta_seconds} from the ambulance position to the leg's destination."""
    s, _off, idx = project(leg.poly, leg.cum_m, pos)
    total = leg.length_m
    frac = 1.0 if total <= 0 else max(0.0, min(1.0, (total - s) / total))
    _here, seg = point_at(leg.poly, leg.cum_m, s)
    # start the drawn line at the ambulance marker itself, then follow the remaining road geometry
    poly = [[round(pos[0], 6), round(pos[1], 6)]] + [[round(p[0], 6), round(p[1], 6)] for p in leg.poly[seg + 1:]]
    eta = int(round(leg.duration_s * frac))
    return {"phase": leg.phase, "polyline": poly, "distance_km": round(leg.distance_km * frac, 2),
            "eta_seconds": max(0, eta) if frac > 0 else 0}


def publish_route(req: EmergencyRequest, snap: dict) -> None:
    data = {"request_id": req.id, **snap}
    events.publish(f"request:{req.id}", "request.route", data)
    events.publish("controller", "request.route", data)
    if req.ambulance_id:
        events.publish(f"crew:{req.ambulance_id}", "request.route", data)


def snapshot(db, req: EmergencyRequest, pos: Point | None, publish: bool = True) -> dict | None:
    """Remaining route for the request from `pos`; publishes `request.route` when the leg changed."""
    if pos is None:
        return None
    try:
        leg, changed = ensure(db, req, pos)
    except Exception:  # noqa: BLE001 - tracking must never fail because routing did
        log.exception("leg computation failed for request %s", req.id)
        return None
    if leg is None:
        return None
    snap = remaining(leg, pos)
    if changed and publish:
        publish_route(req, snap)
    return snap
