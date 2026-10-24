"""Predictive engine (FR3) + feedback loop (FR8).

Model: HistGradientBoostingRegressor (Poisson loss) predicting expected incidents per zone-hour from
[zone row/col, hour sin/cos, weekday, weekend flag, traffic index, historical zone mean, zone-hour-of-day mean,
 log households, senior share, log seniors, 75+ share].
Zones that have residents (ZoneDemographics) but too little incident history get a demographic prior for their
mean demand (a Poisson regression of observed zone means on the demographic features), so new or quiet
neighbourhoods with many older residents are still covered.
Predictions for every (zone, hour-of-day) are persisted as ZoneRisk rows; the dispatch hot path only reads an
in-memory cache (get_zone_risk) and NEVER trains.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import PoissonRegressor
from sklearn.metrics import mean_absolute_error, r2_score
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from .. import demographics, places
from ..geo import zone_center, zone_of
from ..models import IncidentHistory, ModelMetric, ZoneRisk, utcnow
from ..synthetic import IST_OFFSET, traffic_profile

log = logging.getLogger("hads.analytics")

HOLDOUT_DAYS = 14
MIN_ZONE_INCIDENTS = 3
_TTL_S = 300.0
_NEG_TTL_S = 15.0
_lock = threading.RLock()
_train_lock = threading.Lock()
_cache: dict[int, tuple[float, dict]] = {}


def local_hour(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return (now.astimezone(timezone.utc) + IST_OFFSET).hour


def clear_cache() -> None:
    with _lock:
        _cache.clear()


# ---------------------------------------------------------------- hot-path reads
def _load_hour(db: Session, hour: int) -> dict:
    latest = db.scalar(select(func.max(ZoneRisk.generated_at)))
    if latest is None:
        return {"version": None, "risk": {}, "demand": {}}
    rows = db.execute(select(ZoneRisk.zone_id, ZoneRisk.expected_demand, ZoneRisk.risk, ZoneRisk.model_version)
                      .where(ZoneRisk.generated_at == latest, ZoneRisk.hour == hour)).all()
    return {"version": rows[0][3] if rows else None, "generated_at": latest,
            "risk": {r[0]: float(r[2]) for r in rows}, "demand": {r[0]: float(r[1]) for r in rows}}


def _hour_data(db: Session, hour: int | None) -> dict:
    hour = local_hour() if hour is None else int(hour) % 24
    now = time.monotonic()
    hit = _cache.get(hour)
    if hit and hit[0] > now:
        return hit[1]
    data = _load_hour(db, hour)
    with _lock:
        _cache[hour] = (now + (_TTL_S if data["risk"] else _NEG_TTL_S), data)
    return data


def get_zone_risk(db: Session, hour: int | None = None) -> dict[str, float]:
    """zone_id -> normalised risk 0..1 for `hour` (default: current local hour). Empty dict if no model yet."""
    try:
        return _hour_data(db, hour)["risk"]
    except Exception:  # never break dispatch
        log.exception("get_zone_risk failed")
        return {}


def get_zone_demand(db: Session, hour: int | None = None) -> dict[str, float]:
    """zone_id -> expected incidents per hour."""
    try:
        return _hour_data(db, hour)["demand"]
    except Exception:
        log.exception("get_zone_demand failed")
        return {}


def risk_map(db: Session, hour: int | None = None) -> dict:
    hour = local_hour() if hour is None else int(hour) % 24
    d = _hour_data(db, hour)
    demo = demographics.load(db)
    zones = []
    for z, risk in d["risk"].items():
        lat, lng = zone_center(z)
        zd = demo.get(z)
        zones.append({"zone_id": z, "lat": round(lat, 5), "lng": round(lng, 5), "zone_label": places.zone_label(lat, lng),
                      "expected_demand": round(d["demand"][z], 4), "risk": round(risk, 4),
                      "households": zd.households if zd else None, "seniors": zd.seniors if zd else None,
                      "senior_share": round(zd.senior_share, 4) if zd else None})
    zones.sort(key=lambda x: -x["risk"])
    gen = d.get("generated_at")
    return {"hour": hour, "generated_at": gen.isoformat() if gen else None, "model_version": d["version"],
            "demographics_source": demographics.summary(db)["source"], "zones": zones}


# ---------------------------------------------------------------- FR8 feedback
def record_outcome(db: Session, request, trip) -> None:
    """FR8: store a completed trip as a live IncidentHistory row (caller commits). Idempotent per request."""
    ts = request.created_at or utcnow()
    if ts.tzinfo is None:
        ts = ts.replace(tzinfo=timezone.utc)
    db.flush()  # sessions run with autoflush=False; make pending rows visible to the dedupe check
    exists = db.scalar(select(IncidentHistory.id).where(
        IncidentHistory.source == "live", IncidentHistory.ts == ts,
        IncidentHistory.lat == request.lat, IncidentHistory.lng == request.lng).limit(1))
    if exists:
        return
    loc = ts.astimezone(timezone.utc) + IST_OFFSET
    traffic = float(traffic_profile(loc.hour, loc.weekday()))
    itype = request.incident_type.value if hasattr(request.incident_type, "value") else str(request.incident_type)
    db.add(IncidentHistory(
        ts=ts, lat=request.lat, lng=request.lng, zone_id=zone_of(request.lat, request.lng), incident_type=itype,
        severity=int(request.severity or 3), traffic_index=round(traffic, 3),
        response_time_seconds=getattr(trip, "response_time_seconds", None), source="live",
        patient_age_group=getattr(request, "patient_age_group", None) or "unknown"))


# ---------------------------------------------------------------- training
def _load_df(db: Session) -> pd.DataFrame:
    rows = db.execute(select(IncidentHistory.ts, IncidentHistory.zone_id, IncidentHistory.traffic_index,
                             IncidentHistory.source)).all()
    df = pd.DataFrame([tuple(r) for r in rows], columns=["ts", "zone_id", "traffic_index", "source"])
    if df.empty:
        return df
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    return df


def _zone_rc(zones: list[str]) -> np.ndarray:
    return np.array([[int(p) for p in z.split("_")] for z in zones], dtype=float)


DEMO_FEATURES = ("log_households", "senior_share", "log_seniors", "elderly_share")


def _demo_matrix(db: Session, zones: list[str]) -> np.ndarray:
    """(zones, 4): log1p(households), senior share, log1p(seniors), 75+ share. Zeros where demographics are unknown."""
    demo = demographics.load(db)
    out = np.zeros((len(zones), len(DEMO_FEATURES)))
    for i, z in enumerate(zones):
        d = demo.get(z)
        if d is None or d.population <= 0:
            continue
        out[i] = (np.log1p(d.households), d.senior_share, np.log1p(d.seniors), d.pop_75_plus / d.population)
    return out


def _demographic_prior(known_means: np.ndarray, demo_known: np.ndarray, demo_new: np.ndarray) -> np.ndarray:
    """Expected zone mean (incidents/hour) from demographics alone, fitted on zones that have history."""
    has = demo_known.any(axis=1)
    if has.sum() < 5 or not len(demo_new):
        fallback = float(np.median(known_means)) if len(known_means) else 0.0
        return np.full(len(demo_new), fallback)
    model = PoissonRegressor(alpha=1e-3, max_iter=1000).fit(demo_known[has], known_means[has])
    return np.clip(model.predict(demo_new), 0.0, None)


def _features(rc: np.ndarray, zone_mean: np.ndarray, zone_hod: np.ndarray, tmean: np.ndarray,
              hod: np.ndarray, wd: np.ndarray, demo: np.ndarray | None = None) -> np.ndarray:
    """Feature matrix for every (zone, column) pair; hod/wd are per-column arrays. Rows ordered zone-major."""
    z, c = len(rc), len(hod)
    ang = 2 * np.pi * hod / 24.0
    if demo is None:
        demo = np.zeros((z, len(DEMO_FEATURES)))
    cols = [
        np.repeat(rc[:, 0], c), np.repeat(rc[:, 1], c),
        np.tile(np.sin(ang), z), np.tile(np.cos(ang), z), np.tile(wd.astype(float), z),
        np.tile((wd >= 5).astype(float), z), np.tile(tmean[wd, hod], z),
        np.repeat(zone_mean, c), zone_hod[:, hod].reshape(-1),
        *(np.repeat(demo[:, k], c) for k in range(demo.shape[1])),
    ]
    return np.column_stack(cols)


def _stats(counts: np.ndarray, hod: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    zone_mean = counts.mean(axis=1)
    zone_hod = np.zeros((counts.shape[0], 24))
    for h in range(24):
        m = hod == h
        zone_hod[:, h] = counts[:, m].mean(axis=1) if m.any() else zone_mean
    return zone_mean, zone_hod


def _new_model() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(loss="poisson", max_iter=250, learning_rate=0.06, max_leaf_nodes=24,
                                         min_samples_leaf=40, l2_regularization=1.0, random_state=7)


def train_model(db: Session) -> dict:
    """Train on all IncidentHistory (synthetic + live), evaluate on a time-based holdout, refit on everything,
    persist ZoneRisk + ModelMetric and refresh the cache. Raises ValueError without data."""
    if not _train_lock.acquire(blocking=False):
        raise RuntimeError("training already in progress")
    t0 = time.monotonic()
    try:
        df = _load_df(db)
        if len(df) < 50:
            raise ValueError("not enough incident history to train")
        n_live = int((df["source"] == "live").sum())
        per_zone = df.groupby("zone_id").size()
        zones = sorted(per_zone[per_zone >= MIN_ZONE_INCIDENTS].index.tolist())
        if not zones:
            raise ValueError("no zone has enough history")
        zidx = {z: i for i, z in enumerate(zones)}
        df = df[df["zone_id"].isin(zidx)]
        local_ts = df["ts"] + IST_OFFSET
        hour_key = local_ts.dt.floor("h")
        start, end = hour_key.min(), hour_key.max()
        grid = pd.date_range(start, end, freq="h")
        H = len(grid)
        counts = np.zeros((len(zones), H))
        cols = ((hour_key - start) / pd.Timedelta(hours=1)).astype(int).to_numpy()
        np.add.at(counts, (df["zone_id"].map(zidx).to_numpy(), cols), 1)
        hod, wd = grid.hour.to_numpy(), grid.weekday.to_numpy()
        # traffic mean per (weekday, hour): observed, fallback to the deterministic profile
        tmean = np.array([[float(traffic_profile(h, d)) for h in range(24)] for d in range(7)])
        obs = pd.DataFrame({"wd": local_ts.dt.weekday, "h": local_ts.dt.hour,
                            "t": df["traffic_index"]}).groupby(["wd", "h"])["t"].mean()
        for (d, h), v in obs.items():
            tmean[int(d), int(h)] = float(v)
        rc = _zone_rc(zones)
        demo = _demo_matrix(db, zones)

        # --- time-based holdout evaluation
        split = max(H - HOLDOUT_DAYS * 24, int(H * 0.7))
        mae = r2 = float("nan")
        if H - split >= 24:
            zm, zh = _stats(counts[:, :split], hod[:split])
            ev = _new_model().fit(_features(rc, zm, zh, tmean, hod[:split], wd[:split], demo),
                                  counts[:, :split].reshape(-1))
            pred = ev.predict(_features(rc, zm, zh, tmean, hod[split:], wd[split:], demo))
            actual = counts[:, split:].reshape(-1)
            mae, r2 = float(mean_absolute_error(actual, pred)), float(r2_score(actual, pred))

        # --- final model on all data
        zm, zh = _stats(counts, hod)
        model = _new_model().fit(_features(rc, zm, zh, tmean, hod, wd, demo), counts.reshape(-1))

        # cold start: zones with residents but (almost) no incident history get a demographic prior
        known_set = set(zones)
        cold = sorted(z for z in demographics.load(db) if z not in known_set)
        all_zones = zones + cold
        if cold:
            demo_cold = _demo_matrix(db, cold)
            prior = _demographic_prior(zm, demo, demo_cold)
            city_hod = (zh.sum(axis=0) / max(zm.sum(), 1e-9))                 # city-wide hour-of-day shape
            zm_all = np.concatenate([zm, prior])
            zh_all = np.vstack([zh, prior[:, None] * city_hod[None, :]])
            rc_all, demo_all = np.vstack([rc, _zone_rc(cold)]), np.vstack([demo, demo_cold])
        else:
            zm_all, zh_all, rc_all, demo_all = zm, zh, rc, demo
        ph, pw = np.repeat(np.arange(24), 7), np.tile(np.arange(7), 24)
        pred = np.clip(model.predict(_features(rc_all, zm_all, zh_all, tmean, ph, pw, demo_all)), 0, None)
        pred = np.nan_to_num(pred, nan=0.0, posinf=0.0).reshape(len(all_zones), 24, 7).mean(axis=2)
        if cold:  # the tree model barely extrapolates to unseen zones; anchor cold zones on their prior
            n = len(zones)
            pred[n:] = np.maximum(pred[n:], zh_all[n:])
        peak = float(pred.max()) or 1.0
        now = utcnow()
        version = "hgb-" + now.strftime("%Y%m%d%H%M%S")
        db.execute(delete(ZoneRisk))
        db.bulk_insert_mappings(ZoneRisk, [
            {"generated_at": now, "zone_id": z, "hour": h, "expected_demand": float(pred[i, h]),
             "risk": float(min(1.0, pred[i, h] / peak)), "model_version": version}
            for i, z in enumerate(all_zones) for h in range(24)])
        db.add(ModelMetric(trained_at=now, model_version=version, mae=0.0 if np.isnan(mae) else round(mae, 5),
                           r2=0.0 if np.isnan(r2) else round(r2, 5), n_train=int(len(df)), n_live=n_live))
        db.commit()
        clear_cache()
        out = {"model_version": version, "mae": None if np.isnan(mae) else round(mae, 5),
               "r2": None if np.isnan(r2) else round(r2, 5), "n_train": int(len(df)), "n_live": n_live,
               "n_zones": len(all_zones), "n_cold_start_zones": len(cold), "trained_at": now.isoformat(), "train_seconds": round(time.monotonic() - t0, 2)}
        log.info("model trained: %s", out)
        return out
    finally:
        _train_lock.release()


def senior_demand_ratio(db: Session) -> float | None:
    """Predicted daily demand per resident in the oldest quartile of zones (by 60+ share) divided by the youngest
    quartile. > 1 means the model expects more emergencies where more older people live."""
    latest = db.scalar(select(func.max(ZoneRisk.generated_at)))
    demo = demographics.load(db)
    if latest is None or len(demo) < 8:
        return None
    daily = dict(db.execute(select(ZoneRisk.zone_id, func.sum(ZoneRisk.expected_demand))
                            .where(ZoneRisk.generated_at == latest).group_by(ZoneRisk.zone_id)).all())
    rows = [(d.senior_share, daily[z] / d.population) for z, d in demo.items() if z in daily and d.population > 0]
    if len(rows) < 8:
        return None
    rows.sort()
    q = len(rows) // 4
    low, high = np.mean([r[1] for r in rows[:q]]), np.mean([r[1] for r in rows[-q:]])
    return round(float(high / low), 3) if low > 0 else None


def model_info(db: Session, history: int = 20) -> dict:
    rows = db.execute(select(ModelMetric).order_by(ModelMetric.id.desc()).limit(history)).scalars().all()
    hist = [{"model_version": m.model_version, "mae": m.mae, "r2": m.r2, "n_train": m.n_train, "n_live": m.n_live,
             "trained_at": m.trained_at.isoformat()} for m in rows]
    if not rows:
        return {"model_version": None, "mae": None, "r2": None, "n_train": 0, "n_live": 0, "trained_at": None,
                "senior_demand_ratio": None, "history": []}
    return {**hist[0], "senior_demand_ratio": senior_demand_ratio(db), "history": hist}


def latest_metric(db: Session) -> ModelMetric | None:
    return db.execute(select(ModelMetric).order_by(ModelMetric.id.desc()).limit(1)).scalar_one_or_none()
