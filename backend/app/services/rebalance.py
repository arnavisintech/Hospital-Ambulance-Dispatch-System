"""FR9: proactive fleet rebalancing.

Objective J = sum_z demand_z * t_z, where t_z is the road-time proxy (haversine * detour / speed) from zone centre
to the nearest idle ambulance (located at its home station). A greedy search moves one idle ambulance at a time from a
station holding >1 idle units (over-covered) to the station that lowers J the most. expected_gain_seconds is the
demand-weighted mean response-time saving per incident.
"""
from __future__ import annotations

import numpy as np
from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .. import audit
from ..config import get_settings
from ..events import publish
from ..geo import haversine_km, zone_center
from ..models import Ambulance, AmbulanceStatus, DarkStation, RebalanceRecommendation, RebalanceStatus
from . import analytics
from .billing import get_platform_settings

DETOUR = 1.35
MIN_GAIN_S = 2
SERVICE_H = 1.5      # mean ambulance occupancy per incident (hours) -> offered load
FALLBACK_S = 600.0   # penalty when only one station is staffed


def _erlang_b(servers: int, load: float) -> float:
    """Probability that all `servers` idle units at a station are busy (Erlang-B)."""
    b = 1.0
    for n in range(1, servers + 1):
        b = load * b / (n + load * b)
    return b


def _time_matrix(zone_xy: list[tuple[float, float]], pts: list[tuple[float, float]]) -> np.ndarray:
    speed = get_settings().avg_speed_kmph
    m = np.empty((len(zone_xy), len(pts)))
    for i, (la, ln) in enumerate(zone_xy):
        for j, (pa, pn) in enumerate(pts):
            m[i, j] = haversine_km(la, ln, pa, pn) * DETOUR / speed * 3600.0
    return m


def compute_moves(db: Session, hour: int | None = None, max_moves: int | None = None) -> list[dict]:
    demand = analytics.get_zone_demand(db, hour)
    if not demand:
        return []
    max_moves = max_moves or int(get_platform_settings(db)["rebalance_max_moves"])
    stations = {s.id: s for s in db.execute(select(DarkStation).where(DarkStation.is_active.is_(True))).scalars()}
    ambs = db.execute(select(Ambulance).where(Ambulance.status == AmbulanceStatus.available,
                                              Ambulance.staffed.is_(True))).scalars().all()
    ambs = [a for a in ambs if a.station_id in stations]
    if len(stations) < 2 or len(ambs) < 2:
        return []
    zones = list(demand)
    d = np.array([demand[z] for z in zones])
    total = float(d.sum())
    if total <= 0:
        return []
    st_ids = list(stations)
    st_idx = {sid: i for i, sid in enumerate(st_ids)}
    T = _time_matrix([zone_center(z) for z in zones], [(stations[s].lat, stations[s].lng) for s in st_ids])  # Z x S
    home = {a.id: a.station_id for a in ambs}
    amb_by_id = {a.id: a for a in ambs}
    moved: set[int] = set()
    out: list[dict] = []
    risk = analytics.get_zone_risk(db, hour)

    def cost(assign: dict[int, int]) -> float:
        """Demand-weighted expected response seconds incl. the chance that the nearest station's units are all busy."""
        k = np.zeros(len(st_ids))
        for sid in assign.values():
            k[st_idx[sid]] += 1
        cols = np.nonzero(k)[0]
        sub = T[:, cols]
        order = np.argsort(sub, axis=1)
        rows = np.arange(len(zones))
        t1 = sub[rows, order[:, 0]]
        s1 = order[:, 0]
        t2 = sub[rows, order[:, 1]] if len(cols) > 1 else t1 + FALLBACK_S
        load = np.bincount(s1, weights=d, minlength=len(cols)) * SERVICE_H   # offered load (Erlangs) per station
        pb = np.array([_erlang_b(int(k[c]), load[i]) for i, c in enumerate(cols)])
        return float((d * (t1 + pb[s1] * (t2 - t1))).sum())

    for _ in range(max_moves):
        base = cost(home)
        per_station: dict[int, list[int]] = {}
        for aid, sid in home.items():
            per_station.setdefault(sid, []).append(aid)
        best = None
        for sid, aids in per_station.items():
            if len(aids) < 2:      # only draw from over-covered stations
                continue
            aid = next((x for x in sorted(aids) if x not in moved), None)
            if aid is None:
                continue
            for tid in st_ids:
                if tid == sid:
                    continue
                trial = dict(home)
                trial[aid] = tid
                gain = (base - cost(trial)) / total
                if best is None or gain > best[0]:
                    best = (gain, aid, sid, tid)
        if best is None or best[0] < MIN_GAIN_S:
            break
        gain, aid, sid, tid = best
        # reason: highest-demand zone whose nearest station is the target
        near = np.nonzero(T.argmin(axis=1) == st_idx[tid])[0]
        top = int(max(near, key=lambda i: d[i])) if len(near) else int(np.argmax(d))
        zid = zones[top]
        out.append({"ambulance_id": aid, "from_station_id": sid, "to_station_id": tid,
                    "expected_gain_seconds": int(round(gain)),
                    "reason": (f"{stations[sid].name} has {len(per_station[sid])} idle units; {stations[tid].name} "
                               f"covers high-demand zone {zid} (risk {risk.get(zid, 0):.2f}, "
                               f"{demand[zid]:.2f} incidents/h). Saves ~{int(round(gain))}s mean response."[:255])})
        home[aid] = tid
        moved.add(aid)
    return out


def generate(db: Session, user_id: int | None = None, hour: int | None = None) -> list[RebalanceRecommendation]:
    """Replace pending recommendations with a fresh set; audits and publishes rebalance.new."""
    db.execute(update(RebalanceRecommendation).where(RebalanceRecommendation.status == RebalanceStatus.pending)
               .values(status=RebalanceStatus.dismissed))
    recs = []
    for m in compute_moves(db, hour):
        r = RebalanceRecommendation(status=RebalanceStatus.pending, **m)
        db.add(r)
        recs.append(r)
    db.flush()
    audit.log(db, "rebalance.generate", "rebalance", None, user_id,
              {"count": len(recs), "ids": [r.id for r in recs],
               "total_gain_s": sum(r.expected_gain_seconds for r in recs)})
    db.commit()
    if recs:
        publish("controller", "rebalance.new", {"count": len(recs), "recommendations": [rec_out(db, r) for r in recs]})
    return recs


def rec_out(db: Session, r: RebalanceRecommendation) -> dict:
    amb, fs, ts = db.get(Ambulance, r.ambulance_id), db.get(DarkStation, r.from_station_id), db.get(DarkStation, r.to_station_id)
    return {"id": r.id, "created_at": r.created_at.isoformat() if r.created_at else None,
            "ambulance_id": r.ambulance_id, "registration_number": amb.registration_number if amb else None,
            "from_station_id": r.from_station_id, "from_station_name": fs.name if fs else None,
            "to_station_id": r.to_station_id, "to_station_name": ts.name if ts else None,
            "reason": r.reason, "expected_gain_seconds": r.expected_gain_seconds, "status": r.status.value,
            "decided_by": r.decided_by}


def accept(db: Session, rec_id: int, user_id: int) -> RebalanceRecommendation:
    r = db.get(RebalanceRecommendation, rec_id)
    if not r:
        raise HTTPException(404, "Recommendation not found")
    if r.status != RebalanceStatus.pending:
        raise HTTPException(409, f"Recommendation already {r.status.value}")
    amb = db.get(Ambulance, r.ambulance_id)
    to = db.get(DarkStation, r.to_station_id)
    if not amb or not to or not to.is_active:
        raise HTTPException(409, "Ambulance or target station no longer valid")
    if amb.status != AmbulanceStatus.available:
        raise HTTPException(409, f"Ambulance is {amb.status.value}; only idle ambulances can be relocated")
    if amb.station_id != r.from_station_id:
        raise HTTPException(409, "Ambulance is no longer at the recommended source station")
    amb.station_id = to.id
    r.status = RebalanceStatus.accepted
    r.decided_by = user_id
    audit.log(db, "rebalance.accept", "rebalance", r.id, user_id,
              {"ambulance_id": amb.id, "from_station_id": r.from_station_id, "to_station_id": to.id,
               "expected_gain_seconds": r.expected_gain_seconds})
    db.commit()
    return r


def dismiss(db: Session, rec_id: int, user_id: int) -> RebalanceRecommendation:
    r = db.get(RebalanceRecommendation, rec_id)
    if not r:
        raise HTTPException(404, "Recommendation not found")
    if r.status != RebalanceStatus.pending:
        raise HTTPException(409, f"Recommendation already {r.status.value}")
    r.status = RebalanceStatus.dismissed
    r.decided_by = user_id
    audit.log(db, "rebalance.dismiss", "rebalance", r.id, user_id, {"ambulance_id": r.ambulance_id})
    db.commit()
    return r
