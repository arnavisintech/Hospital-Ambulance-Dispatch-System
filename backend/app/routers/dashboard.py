"""FR11 operational dashboard. Aggregations use SQL for counts and pandas for percentiles / group-bys."""
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import places
from ..db import get_db
from ..deps import require_roles
from ..geo import haversine_km, zone_center
from ..models import (Ambulance, AmbulanceStatus, DarkStation, EmergencyRequest, Hospital, RequestStatus, Role, TripRecord,
                      User, utcnow)
from ..services import analytics
from ..services.billing import get_platform_settings

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])
BUSY = [AmbulanceStatus.assigned, AmbulanceStatus.en_route, AmbulanceStatus.on_scene, AmbulanceStatus.transporting]


def _f(x, nd=1):
    return None if x is None or (isinstance(x, float) and np.isnan(x)) else round(float(x), nd)


def _val(x):
    return x.value if hasattr(x, "value") else str(x)


def _utc(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s, utc=True)


@router.get("/summary")
def summary(days: int = Query(7, ge=1, le=365), db: Session = Depends(get_db),
            _: User = Depends(require_roles(Role.admin, Role.authority, Role.controller))):
    now = utcnow()
    since = now - timedelta(days=days)
    cfg = get_platform_settings(db)
    target = int(cfg["dispatch_target_s"])

    req = pd.DataFrame([tuple(r) for r in db.execute(
        select(EmergencyRequest.id, EmergencyRequest.status, EmergencyRequest.incident_type, EmergencyRequest.created_at,
               EmergencyRequest.match_duration_ms).where(EmergencyRequest.created_at >= since)).all()],
        columns=["id", "status", "itype", "created_at", "match_ms"])
    trips = pd.DataFrame([tuple(r) for r in db.execute(
        select(TripRecord.id, TripRecord.ambulance_id, TripRecord.destination_hospital_id, TripRecord.dispatched_at,
               TripRecord.arrived_hospital_at, TripRecord.handover_time, TripRecord.response_time_seconds,
               TripRecord.summary, EmergencyRequest.created_at)
        .join(EmergencyRequest, EmergencyRequest.id == TripRecord.request_id)
        .where(EmergencyRequest.created_at >= since)).all()],
        columns=["id", "amb", "hosp", "dispatched_at", "arrived_h", "handover", "resp_s", "summary", "req_created"])

    total = len(req)
    if total:
        req["status"] = req["status"].map(_val)
        req["itype"] = req["itype"].map(_val)
    completed = int((req["status"] == RequestStatus.completed.value).sum()) if total else 0
    resp = trips["resp_s"].dropna().astype(float) if len(trips) else pd.Series(dtype=float)
    match_ms = req["match_ms"].dropna().astype(float) if total else pd.Series(dtype=float)
    handover_s = pd.Series(dtype=float)
    if len(trips):
        ha, hb = _utc(trips["arrived_h"]), _utc(trips["handover"])
        handover_s = (hb - ha).dt.total_seconds().dropna()
        handover_s = handover_s[handover_s >= 0]
        trips["dur_s"] = (hb - _utc(trips["dispatched_at"])).dt.total_seconds()
        trips["req_created"] = _utc(trips["req_created"])

    n_amb = db.scalar(select(func.count(Ambulance.id)).where(Ambulance.status != AmbulanceStatus.maintenance)) or 0
    busy_now = db.scalar(select(func.count(Ambulance.id)).where(Ambulance.status.in_(BUSY))) or 0
    busy_s = float(trips["dur_s"].clip(lower=0).sum()) if len(trips) else 0.0
    util = 100.0 * busy_s / (n_amb * days * 86400) if n_amb else 0.0
    redirect = int(sum(1 for s in trips["summary"] if isinstance(s, dict) and s.get("redirect_avoided"))) if len(trips) else 0
    ratings = [float(s["feedback"]["rating"]) for s in (trips["summary"] if len(trips) else [])
               if isinstance(s, dict) and isinstance(s.get("feedback"), dict) and s["feedback"].get("rating")]

    kpis = {
        "avg_response_s": _f(resp.mean()) if len(resp) else None,
        "p90_response_s": _f(resp.quantile(0.9)) if len(resp) else None,
        "avg_match_ms": _f(match_ms.mean()) if len(match_ms) else None,
        "requests_total": total, "completed": completed,
        "completion_rate": round(completed / total, 4) if total else 0.0,
        "avg_handover_s": _f(handover_s.mean()) if len(handover_s) else None,
        "fleet_utilisation_pct": round(min(util, 100.0), 2),
        "fleet_busy_now_pct": round(100.0 * busy_now / n_amb, 1) if n_amb else 0.0,
        "redirect_avoided": redirect,
        "avg_rating": round(sum(ratings) / len(ratings), 2) if ratings else None,
        "ratings_count": len(ratings),
    }

    by_day = []
    if len(trips) and trips["resp_s"].notna().any():
        t = trips.dropna(subset=["resp_s"]).copy()
        t["date"] = (t["req_created"] + pd.Timedelta(hours=5, minutes=30)).dt.strftime("%Y-%m-%d")
        g = t.groupby("date")["resp_s"].agg(["mean", "count"]).reset_index()
        by_day = [{"date": r.date, "avg_s": _f(r.mean), "count": int(r.count)} for r in g.itertuples()]
    by_incident = []
    if total:
        vc = req["itype"].value_counts()
        by_incident = [{"type": k, "count": int(v)} for k, v in vc.items()]

    # stations
    st_rows = db.execute(select(DarkStation.id, DarkStation.name, DarkStation.lat, DarkStation.lng)).all()
    amb_rows = db.execute(select(Ambulance.id, Ambulance.station_id, Ambulance.status, Ambulance.lat, Ambulance.lng)).all()
    amb_df = pd.DataFrame([tuple(r) for r in amb_rows], columns=["id", "station_id", "status", "lat", "lng"])
    if len(amb_df):
        amb_df["status"] = amb_df["status"].map(_val)
    stations = []
    for sid, name, _la, _ln in st_rows:
        mine = amb_df[amb_df["station_id"] == sid] if len(amb_df) else amb_df
        ids = set(mine["id"].tolist())
        tr = trips[trips["amb"].isin(ids)] if len(trips) else trips
        busy = float(tr["dur_s"].clip(lower=0).sum()) if len(tr) else 0.0
        denom = len(ids) * days * 86400
        stations.append({"id": sid, "name": name, "utilisation_pct": round(min(100.0 * busy / denom, 100.0), 2) if denom else 0.0,
                         "ambulances": len(ids), "available": int((mine["status"] == AmbulanceStatus.available.value).sum()) if len(mine) else 0,
                         "trips": int(len(tr))})

    # hospitals
    stale_min = int(cfg["capacity_stale_min"])
    hospitals = []
    recv = trips.groupby("hosp").size().to_dict() if len(trips) else {}
    for h in db.execute(select(Hospital).order_by(Hospital.id)).scalars():
        upd = h.capacity_updated_at
        if upd is not None and upd.tzinfo is None:
            upd = upd.replace(tzinfo=timezone.utc)
        age = (now - upd).total_seconds() / 60 if upd else None
        hospitals.append({"id": h.id, "name": h.name, "available_beds": h.available_beds, "total_beds": h.total_beds,
                          "available_icu": h.available_icu, "total_icu": h.total_icu,
                          "bed_occupancy_pct": round(100.0 * (1 - h.available_beds / h.total_beds), 1) if h.total_beds else 0.0,
                          "trips_received": int(recv.get(h.id, 0)), "capacity_age_min": _f(age),
                          "stale": age is None or age > stale_min})

    m = analytics.latest_metric(db)
    prediction = {"mae": m.mae if m else None, "r2": m.r2 if m else None, "model_version": m.model_version if m else None}

    # coverage gaps: highest-risk zones with the farthest available ambulance
    gaps = []
    risk = analytics.get_zone_risk(db, None)
    avail = amb_df[(amb_df["status"] == AmbulanceStatus.available.value) & amb_df["lat"].notna()] if len(amb_df) else amb_df
    if risk:
        pts = list(zip(avail["lat"], avail["lng"])) if len(avail) else []
        for z, rk in sorted(risk.items(), key=lambda kv: -kv[1])[:25]:
            lat, lng = zone_center(z)
            d = min((haversine_km(lat, lng, a, b) for a, b in pts), default=None)
            gaps.append({"zone_id": z, "lat": round(lat, 5), "lng": round(lng, 5), "zone_label": places.zone_label(lat, lng),
                         "risk": round(rk, 4),
                         "nearest_ambulance_km": None if d is None else round(d, 2)})
        gaps.sort(key=lambda g: -(g["risk"] * (g["nearest_ambulance_km"] if g["nearest_ambulance_km"] is not None else 99)))
        gaps = gaps[:10]

    within = round(100.0 * float((match_ms <= target * 1000).mean()), 1) if len(match_ms) else None
    return {"days": days, "generated_at": now.isoformat(), "kpis": kpis, "response_by_day": by_day,
            "by_incident": by_incident, "stations": stations, "hospitals": hospitals, "prediction": prediction,
            "coverage_gaps": gaps, "sla": {"nfr1_target_s": target, "within_target_pct": within}}
