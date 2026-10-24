"""Demo autopilot (v2 section 9): simulated crews that make a live demo feel real.

Every ambulance whose crew device has NOT pinged /crew/location within `autopilot_device_grace_s` (60 s) is driven
by a per-ambulance state machine, re-derived from the database on every tick so it follows cancellations,
controller overrides (reassignment, destination change, manual close) and hospital handovers automatically:

    offered      -> accept after 3-6 s                          (crew_actions.accept_offer, audited actor=autopilot)
    accepted     -> en_route after ~1 s
    en_route     -> drive the road leg to the patient, 1 GPS fix / s (crew_actions.record_location -> WS events)
    on scene     -> dwell 20 s / DEMO_SPEEDUP, then transporting (retries while no hospital is confirmed)
    transporting -> drive the leg to the hospital, then arrived
    arrived      -> auto-handover after 45 s / DEMO_SPEEDUP unless hospital staff confirm first
    available    -> drive back to the home station; idle units get a GPS heartbeat so they stay dispatchable

Vehicle speed follows the routed ETA (OSRM free-flow duration x traffic factor) x DEMO_SPEEDUP. The class is
clock-agnostic: `tick(now)` takes the time explicitly so tests drive it with a fake clock. Errors are contained
per ambulance and per tick -- the loop never dies.
"""
from __future__ import annotations

import asyncio
import logging
import random
import time
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy import select

from .. import db as dbmod
from ..config import get_settings
from ..models import (Ambulance, AmbulanceStatus, EmergencyRequest, RequestStatus, utcnow)
from . import crew_actions, dispatch, legs, trips

log = logging.getLogger("hads.autopilot")
RS = RequestStatus
ACTOR = "autopilot"

ACCEPT_DELAY_S = (3.0, 6.0)
EN_ROUTE_DELAY_S = 1.0
SCENE_DWELL_S = 20.0       # divided by speedup
HANDOVER_WAIT_S = 45.0     # divided by speedup
NO_HOSPITAL_RETRY_S = 5.0
HOME_RADIUS_M = 80.0
HEARTBEAT_S = 30.0
MAX_DT_S = 3.0             # cap a single movement step after a stall so units never teleport
MIN_SPEED_MPS, MAX_SPEED_MPS = 3.0, 25.0


@dataclass
class Unit:
    amb_id: int
    mode: str = "idle"          # idle | offer | accepted | drive | dwell | handover_wait | home
    request_id: int | None = None
    due: float = 0.0
    last: float | None = None
    leg: legs.Leg | None = None  # leg currently being followed
    s_m: float = 0.0             # distance travelled along `leg`
    speed_mps: float = 8.0
    last_beat: float = -1e9

    def reset(self, request_id: int | None = None) -> None:
        self.mode, self.request_id, self.due, self.leg, self.s_m = "idle", request_id, 0.0, None, 0.0


class Autopilot:
    def __init__(self, speedup: float | None = None, rng: random.Random | None = None, session_factory=None,
                 device_grace_s: float | None = None):
        s = get_settings()
        self.speedup = max(0.1, float(speedup if speedup is not None else s.demo_speedup))
        self.rng = rng or random.Random()
        self.session_factory = session_factory
        self.device_grace_s = float(device_grace_s if device_grace_s is not None else s.autopilot_device_grace_s)
        self.units: dict[int, Unit] = {}

    # ------------------------------------------------------------ main step
    def _session(self):
        return (self.session_factory or dbmod.SessionLocal)()

    def tick(self, now: float) -> None:
        """Advance every simulated ambulance to time `now` (seconds, monotonic or fake)."""
        with self._session() as db:
            ambs = db.execute(select(Ambulance).where(Ambulance.status.notin_([AmbulanceStatus.offline,
                                                                               AmbulanceStatus.maintenance]))
                              .order_by(Ambulance.id).execution_options(populate_existing=True)).scalars().all()
            reqs: dict[int, EmergencyRequest] = {}
            for r in db.execute(select(EmergencyRequest).where(
                    EmergencyRequest.ambulance_id.is_not(None),
                    EmergencyRequest.status.in_([RS.offered] + crew_actions.TRIP_STATES))
                    .order_by(EmergencyRequest.id).execution_options(populate_existing=True)).scalars():
                reqs[r.ambulance_id] = r
            seen = set()
            for amb in ambs:
                seen.add(amb.id)
                try:
                    self._step(db, amb, reqs.get(amb.id), now)
                except Exception:  # noqa: BLE001 - one bad unit must not stop the others
                    db.rollback()
                    log.exception("autopilot step failed for ambulance %s", amb.id)
                    self.units.pop(amb.id, None)
            for gone in set(self.units) - seen:  # went offline / maintenance
                self.units.pop(gone, None)

    def _step(self, db, amb: Ambulance, req: EmergencyRequest | None, now: float) -> None:
        if crew_actions.device_active(amb.id, self.device_grace_s, now):
            self.units.pop(amb.id, None)  # a real crew is driving this ambulance
            return
        u = self.units.get(amb.id)
        if u is None:
            u = self.units[amb.id] = Unit(amb.id)
        dt = 0.0 if u.last is None else max(0.0, min(MAX_DT_S, now - u.last))
        u.last = now
        if req is None:
            if u.request_id is not None:
                u.reset()  # trip finished, cancelled or reassigned away from us
            self._idle(db, amb, u, now, dt)
            return
        if u.request_id != req.id:
            u.reset(req.id)
        st = req.status
        if st == RS.offered:
            if u.mode != "offer":
                u.mode, u.due = "offer", now + self.rng.uniform(*ACCEPT_DELAY_S)
            elif now >= u.due:
                crew_actions.accept_offer(db, amb, req.id, None, actor=ACTOR)
                u.mode, u.due = "accepted", now + EN_ROUTE_DELAY_S
        elif st == RS.accepted:
            if u.mode != "accepted":
                u.mode, u.due = "accepted", now + EN_ROUTE_DELAY_S
            elif now >= u.due:
                crew_actions.advance_status(db, amb, req.id, "en_route", None, actor=ACTOR)
                u.mode, u.leg = "drive", None
        elif st == RS.en_route:
            if self._drive(db, amb, req, u, dt):
                crew_actions.advance_status(db, amb, req.id, "on_scene", None, actor=ACTOR)
                u.mode, u.due, u.leg = "dwell", now + SCENE_DWELL_S / self.speedup, None
        elif st == RS.on_scene:
            if u.mode != "dwell":
                u.mode, u.due = "dwell", now + SCENE_DWELL_S / self.speedup
            elif now >= u.due:
                try:
                    crew_actions.advance_status(db, amb, req.id, "transporting", None, actor=ACTOR)
                    u.mode, u.leg = "drive", None
                except HTTPException as e:  # no eligible hospital yet: wait for the controller
                    db.rollback()
                    log.info("autopilot: request %s cannot start transport (%s); retrying", req.id, e.detail)
                    u.due = now + NO_HOSPITAL_RETRY_S
        elif st == RS.transporting:
            if self._drive(db, amb, req, u, dt):
                crew_actions.advance_status(db, amb, req.id, "arrived", None, actor=ACTOR)
                u.mode, u.due, u.leg = "handover_wait", now + HANDOVER_WAIT_S / self.speedup, None
        elif st == RS.arrived:
            if u.mode != "handover_wait":
                u.mode, u.due = "handover_wait", now + HANDOVER_WAIT_S / self.speedup
            elif now >= u.due:
                with dispatch._LOCK:
                    locked = dispatch.lock_request(db, req.id)
                    if locked is not None and locked.status == RS.arrived:  # staff may have confirmed meanwhile
                        trips.close_trip(db, locked, None, actor_note=ACTOR)
                u.reset()

    # ------------------------------------------------------------ movement
    def _follow(self, leg: legs.Leg, u: Unit, pos) -> None:
        """Start following `leg` from the ambulance's current projection onto it."""
        u.leg = leg
        u.s_m = legs.project(leg.poly, leg.cum_m, pos)[0]
        speed = leg.length_m / max(1, leg.duration_s)
        u.speed_mps = max(MIN_SPEED_MPS, min(MAX_SPEED_MPS, speed))

    def _advance(self, db, amb: Ambulance, u: Unit, dt: float) -> bool:
        """Move along u.leg by dt seconds; record the GPS fix. True when the end was reached."""
        leg = u.leg
        u.s_m += u.speed_mps * self.speedup * dt
        arrived = u.s_m >= leg.length_m - 2.0
        pos = leg.poly[-1] if arrived else legs.point_at(leg.poly, leg.cum_m, u.s_m)[0]
        if dt > 0 or arrived:
            crew_actions.record_location(db, amb, round(pos[0], 6), round(pos[1], 6))
        return arrived

    def _drive(self, db, amb: Ambulance, req: EmergencyRequest, u: Unit, dt: float) -> bool:
        pos = trips.ambulance_point(amb)
        leg = legs.get(req.id)
        tgt = legs.target(db, req)
        if tgt is None:
            return False  # e.g. transporting without a destination: hold position
        if leg is None or leg.phase != tgt[0] or legs._dist_m(leg.dest, tgt[1]) >= 1.0:
            leg, _changed = legs.ensure(db, req, pos)
            if _changed:
                legs.publish_route(req, legs.remaining(leg, pos))
        if leg is None:
            return False
        if leg is not u.leg:  # new leg, reroute, or destination changed by the controller
            self._follow(leg, u, pos)
        u.mode = "drive"
        return self._advance(db, amb, u, dt)

    def _idle(self, db, amb: Ambulance, u: Unit, now: float, dt: float) -> None:
        if amb.status != AmbulanceStatus.available or not amb.staffed:
            return
        st = amb.station
        home = (st.lat, st.lng)
        pos = trips.ambulance_point(amb)
        heading_home = u.mode == "home" and u.leg is not None and legs._dist_m(u.leg.dest, home) < 1.0
        if heading_home or legs._dist_m(pos, home) > HOME_RADIUS_M:
            if not heading_home:
                self._follow(legs.build_leg(-amb.id, "home", pos, home), u, pos)
                u.mode = "home"
            if self._advance(db, amb, u, dt):
                u.reset()
            return
        if u.mode == "home":
            u.reset()
        if now - u.last_beat >= HEARTBEAT_S:
            fresh = amb.location_updated_at and (utcnow() - trips.aware(amb.location_updated_at)).total_seconds() < HEARTBEAT_S
            if not fresh:
                crew_actions.heartbeat(db, amb)
            u.last_beat = now


async def loop(tick_s: float = 1.0, autopilot: Autopilot | None = None) -> None:
    """Background task (started from services.background when DEMO_AUTOPILOT=true). Never raises except on cancel."""
    ap = autopilot or Autopilot()
    log.info("demo autopilot running (speedup x%s)", ap.speedup)
    while True:
        t0 = time.monotonic()
        try:
            await asyncio.to_thread(ap.tick, t0)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("autopilot tick failed")
        await asyncio.sleep(max(0.05, tick_s - (time.monotonic() - t0)))
