"""Synthetic Chennai incident generator (FR3 training data / cold start).

Plausible demand model: hotspots at arterial junctions / commercial hubs / residential belts, each with its own
hour-of-day profile, rush-hour and night patterns, weekday vs weekend effects, a daily random factor (weather/events),
an incident-type mix that shifts through the day and a traffic_index feature. Fully deterministic for a given seed.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from .geo import zone_of
from .models import IncidentType

IST = timezone(timedelta(hours=5, minutes=30))
IST_OFFSET = timedelta(hours=5, minutes=30)

# (name, lat, lng, weight, sigma_deg, kind)  kind: arterial | commercial | residential | mixed
HOTSPOTS = [
    ("T Nagar", 13.0418, 80.2341, 1.0, 0.010, "commercial"),
    ("Koyambedu", 13.0694, 80.1948, 0.95, 0.010, "arterial"),
    ("Guindy Junction", 13.0067, 80.2206, 1.0, 0.009, "arterial"),
    ("Anna Salai / Spencer", 13.0630, 80.2640, 0.85, 0.008, "arterial"),
    ("Egmore / Central", 13.0780, 80.2600, 0.9, 0.009, "mixed"),
    ("Velachery", 12.9815, 80.2180, 0.8, 0.010, "residential"),
    ("Tambaram", 12.9249, 80.1170, 0.5, 0.012, "mixed"),
    ("OMR Sholinganallur", 12.9010, 80.2279, 0.65, 0.012, "arterial"),
    ("Adyar", 13.0067, 80.2570, 0.7, 0.009, "residential"),
    ("Perambur", 13.1210, 80.2330, 0.5, 0.010, "residential"),
    ("Tondiarpet", 13.1250, 80.2880, 0.5, 0.010, "mixed"),
    ("Porur", 13.0382, 80.1565, 0.65, 0.011, "arterial"),
    ("Ambattur", 13.1143, 80.1548, 0.4, 0.011, "residential"),
    ("Anna Nagar", 13.0850, 80.2101, 0.65, 0.009, "residential"),
    ("Mylapore", 13.0368, 80.2676, 0.55, 0.008, "commercial"),
    ("Marina / Triplicane", 13.0500, 80.2824, 0.4, 0.008, "mixed"),
]

TYPES = [t.value for t in IncidentType]
_BASE_TYPE_P = np.array([0.20, 0.27, 0.07, 0.12, 0.07, 0.05, 0.04, 0.18])  # cardiac..other


def _gauss(h: np.ndarray, mu: float, sd: float) -> np.ndarray:
    d = np.minimum(np.abs(h - mu), 24 - np.abs(h - mu))
    return np.exp(-0.5 * (d / sd) ** 2)


def hour_profile(kind: str) -> np.ndarray:
    """Relative demand multiplier per local hour 0..23 for a hotspot kind."""
    h = np.arange(24, dtype=float)
    night = 0.35
    if kind == "arterial":
        p = night + 1.5 * _gauss(h, 9, 1.8) + 1.7 * _gauss(h, 18.5, 2.0) + 0.6 * _gauss(h, 13, 3)
    elif kind == "commercial":
        p = night + 1.4 * _gauss(h, 12.5, 3.5) + 1.0 * _gauss(h, 18, 2.5)
    elif kind == "residential":
        p = night + 0.7 * _gauss(h, 8, 1.5) + 1.1 * _gauss(h, 20.5, 2.5) + 0.5 * _gauss(h, 2, 2.5)
    else:
        p = night + 0.9 * _gauss(h, 9, 2) + 0.9 * _gauss(h, 14, 3) + 1.0 * _gauss(h, 19, 2.5)
    return p / p.mean()


def traffic_profile(hour: int | np.ndarray, weekday: int | np.ndarray):
    """Deterministic expected traffic index (0 free .. 1 gridlock) by local hour and weekday (0=Mon)."""
    h = np.asarray(hour, dtype=float)
    wd = np.asarray(weekday)
    weekday_curve = 0.18 + 0.55 * _gauss(h, 9, 1.6) + 0.62 * _gauss(h, 18.3, 1.9) + 0.2 * _gauss(h, 13, 3)
    weekend_curve = 0.15 + 0.35 * _gauss(h, 11.5, 3) + 0.4 * _gauss(h, 18.5, 2.5)
    out = np.where(wd >= 5, weekend_curve, weekday_curve)
    return np.clip(out, 0.05, 0.98)


def _type_probs(hours: np.ndarray, traffic: np.ndarray) -> np.ndarray:
    """(n, 8) incident-type probabilities that shift with hour of day and traffic."""
    n = len(hours)
    p = np.tile(_BASE_TYPE_P, (n, 1))
    idx = {t: i for i, t in enumerate(TYPES)}
    p[:, idx["trauma"]] *= 1 + 1.6 * traffic                       # road accidents scale with congestion
    p[:, idx["cardiac"]] *= 1 + 0.8 * _gauss(hours, 7, 2.5) + 0.3 * _gauss(hours, 22, 2)
    p[:, idx["stroke"]] *= 1 + 0.6 * _gauss(hours, 8, 3)
    p[:, idx["maternity"]] *= 1 + 0.9 * _gauss(hours, 3, 4)
    p[:, idx["respiratory"]] *= 1 + 0.5 * _gauss(hours, 3, 3)
    p[:, idx["burns"]] *= 1 + 0.6 * _gauss(hours, 19, 2)
    p /= p.sum(axis=1, keepdims=True)
    return p


# severity distribution per type (1..5)
_SEV_P = {
    "cardiac": [0.02, 0.08, 0.25, 0.35, 0.30], "trauma": [0.05, 0.20, 0.35, 0.25, 0.15],
    "stroke": [0.02, 0.08, 0.25, 0.35, 0.30], "respiratory": [0.06, 0.24, 0.35, 0.25, 0.10],
    "maternity": [0.10, 0.30, 0.35, 0.20, 0.05], "burns": [0.05, 0.20, 0.35, 0.25, 0.15],
    "poisoning": [0.08, 0.27, 0.35, 0.22, 0.08], "other": [0.30, 0.35, 0.22, 0.10, 0.03],
}


def generate_history(days: int = 90, end: datetime | None = None, seed: int = 42,
                     rate_scale: float = 1.0) -> pd.DataFrame:
    """Return a DataFrame [ts(UTC), lat, lng, zone_id, incident_type, severity, traffic_index], sorted by ts."""
    rng = np.random.default_rng(seed)
    end = (end or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    n_hours = days * 24
    hours_utc = pd.date_range(end=end - timedelta(hours=1), periods=n_hours, freq="h", tz="UTC")
    local = hours_utc + IST_OFFSET
    hod = local.hour.to_numpy()
    wd = local.weekday.to_numpy()
    day_key = (local.normalize().astype("int64") // (24 * 3600 * 10**9)).to_numpy()
    uniq_days, inv = np.unique(day_key, return_inverse=True)
    day_factor = rng.lognormal(0.0, 0.12, len(uniq_days))[inv]           # weather / events
    traffic = np.clip(traffic_profile(hod, wd) + rng.normal(0, 0.05, n_hours), 0.02, 1.0)
    dow = np.where(wd >= 5, 1.1, 1.0) * np.where((wd == 4) & (hod >= 17), 1.2, 1.0)  # weekend / Friday evening
    base = 1.3 * rate_scale
    lam = np.empty((n_hours, len(HOTSPOTS)))
    for k, (_, _, _, w, _, kind) in enumerate(HOTSPOTS):
        prof = hour_profile(kind)[hod]
        wk = np.where(wd >= 5, 0.75 if kind in ("arterial", "commercial") else 1.2, 1.0)
        lam[:, k] = base * w * prof * wk * dow * day_factor * (0.8 + 0.6 * traffic)
    counts = rng.poisson(lam)
    h_idx, k_idx = np.nonzero(counts)
    reps = counts[h_idx, k_idx]
    h_rep = np.repeat(h_idx, reps)
    k_rep = np.repeat(k_idx, reps)
    n = len(h_rep)
    centers = np.array([[h[1], h[2]] for h in HOTSPOTS])
    sig = np.array([h[4] for h in HOTSPOTS])[k_rep]
    lat = centers[k_rep, 0] + rng.normal(0, 1, n) * sig
    lng = centers[k_rep, 1] + rng.normal(0, 1, n) * sig * 1.05
    minutes = rng.integers(0, 3600, n)
    ts = hours_utc[h_rep] + pd.to_timedelta(minutes, unit="s")
    tr = traffic[h_rep]
    probs = _type_probs(hod[h_rep].astype(float), tr)
    cum = probs.cumsum(axis=1)
    t_idx = (rng.random(n)[:, None] > cum).sum(axis=1).clip(max=len(TYPES) - 1)
    sev = np.empty(n, dtype=int)
    for i, t in enumerate(TYPES):
        m = t_idx == i
        sev[m] = rng.choice([1, 2, 3, 4, 5], size=int(m.sum()), p=_SEV_P[t])
    zones = [zone_of(a, b) for a, b in zip(lat, lng)]
    df = pd.DataFrame({"ts": ts, "lat": lat, "lng": lng, "zone_id": zones,
                       "incident_type": np.array(TYPES)[t_idx], "severity": sev, "traffic_index": tr.round(3)})
    return df.sort_values("ts").reset_index(drop=True)


def to_rows(df: pd.DataFrame, source: str = "synthetic") -> list[dict]:
    """DataFrame -> dicts for IncidentHistory bulk insert."""
    out = []
    for r in df.itertuples(index=False):
        out.append({"ts": r.ts.to_pydatetime(), "lat": float(r.lat), "lng": float(r.lng), "zone_id": r.zone_id,
                    "incident_type": r.incident_type, "severity": int(r.severity),
                    "traffic_index": float(r.traffic_index), "response_time_seconds": None, "source": source})
    return out
