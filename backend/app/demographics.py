"""Zone demographics: residences (households) and age groups per 0.02-degree grid zone.

Ambulance demand rises with the number of residents and, much more steeply, with the number of older residents
(cardiac, stroke, respiratory and fall emergencies), so the demand model uses these as features.

SYNTHETIC ESTIMATE. ``generate_chennai_demographics`` builds a plausible Chennai picture, calibrated to the city's
broad shape (about 3.9 persons per household, roughly 11-12 % aged 60+, older residential belts such as Adyar,
Mylapore and Anna Nagar, younger commercial cores and periphery). It is NOT census data. Replace it with real
ward-level data through the admin CSV import (``POST /api/admin/demographics/import`` or
``scripts/import_demographics.py``); the import format is ``lat,lng,households,pop_0_14,pop_15_59,pop_60_74,pop_75_plus``
with one row per ward / locality centroid.
"""
from __future__ import annotations

import csv
import io
import math
import random

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .geo import in_city, zone_center, zone_of
from .models import ZoneDemographics, utcnow

COLUMNS = ("lat", "lng", "households", "pop_0_14", "pop_15_59", "pop_60_74", "pop_75_plus")
COUNTS = COLUMNS[2:]
AGE_KEYS = COUNTS[1:]

# Populated metro used by the generator (inside CHENNAI_BBOX; the Bay of Bengal is excluded by _coast_lng).
_LAT_RANGE = (12.86, 13.22)
_LNG_RANGE = (80.06, 80.32)
_CENTRE = (13.06, 80.24)

# (lat, lng, kind) of named localities: "old" residential belts skew older, "core" commercial skews working-age.
_LOCALITIES = [
    (13.0067, 80.2570, "old"), (13.0339, 80.2676, "old"), (13.0850, 80.2101, "old"), (12.9815, 80.2180, "old"),
    (13.1187, 80.2335, "old"), (13.0500, 80.2300, "old"),
    (13.0418, 80.2341, "core"), (13.0780, 80.2600, "core"), (13.0694, 80.1948, "core"), (13.0067, 80.2206, "core"),
    (12.9010, 80.2279, "young"), (12.9249, 80.1170, "young"), (13.1143, 80.1548, "young"), (13.0382, 80.1565, "young"),
]


def _coast_lng(lat: float) -> float:
    """Approximate shoreline longitude (Kovalam 12.8 N ~80.25 E to Ennore 13.22 N ~80.31 E)."""
    return 80.25 + (lat - 12.80) * 0.15


def _kernel(lat: float, lng: float, kind: str, sigma: float = 0.025) -> float:
    return sum(math.exp(-((lat - a) ** 2 + (lng - b) ** 2) / (2 * sigma ** 2)) for a, b, k in _LOCALITIES if k == kind)


def generate_chennai_demographics(seed: int = 11) -> list[dict]:
    """One row per populated zone (see module docstring: synthetic estimate). Deterministic for a seed."""
    from .config import get_settings
    rng = random.Random(seed)
    cell = get_settings().zone_cell_deg
    rows = []
    lat = _LAT_RANGE[0]
    while lat < _LAT_RANGE[1]:
        lng = _LNG_RANGE[0]
        while lng < _LNG_RANGE[1]:
            z = zone_of(lat + cell / 2, lng + cell / 2)
            clat, clng = zone_center(z)
            lng += cell
            if clng > _coast_lng(clat) or not in_city(clat, clng):
                continue
            d = math.hypot(clat - _CENTRE[0], (clng - _CENTRE[1]) * 0.97)
            core = math.exp(-(d ** 2) / (2 * 0.09 ** 2))          # 1 in the centre, ~0 at the edge
            old, young, comm = _kernel(clat, clng, "old"), _kernel(clat, clng, "young"), _kernel(clat, clng, "core")
            households = int(2500 + 17000 * core + 5000 * min(old, 1.5) + 2500 * min(young, 1.5)
                             * rng.uniform(0.8, 1.2) + rng.uniform(-600, 600))
            households = max(400, households)
            persons = households * rng.uniform(3.6, 4.2)
            senior = min(0.22, max(0.05, 0.115 + 0.08 * min(old, 1.2) - 0.025 * min(comm, 1.2)
                                   - 0.035 * min(young, 1.2) - 0.04 * (1 - core) + rng.gauss(0, 0.008)))
            child = min(0.30, max(0.12, 0.20 + 0.03 * (1 - core) + 0.02 * min(young, 1.2) - 0.025 * min(old, 1.2)
                                  + rng.gauss(0, 0.01)))
            elderly_frac = rng.uniform(0.22, 0.30)                   # share of seniors aged 75+
            p_child, p_senior = int(persons * child), int(persons * senior)
            p75 = int(p_senior * elderly_frac)
            rows.append({"zone_id": z, "households": households, "pop_0_14": p_child,
                         "pop_15_59": int(persons) - p_child - p_senior, "pop_60_74": p_senior - p75,
                         "pop_75_plus": p75, "source": "synthetic"})
        lat += cell
    return rows


def parse_demographics_csv(text: str) -> tuple[list[dict], list[str]]:
    """Parse an import file. Rows are mapped to grid zones and summed per zone. Any error rejects the whole file:
    returns ([], errors) with every problem as "row N: message" (row 1 is the header)."""
    errors: list[str] = []
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    header = [h.strip() for h in (reader.fieldnames or [])]
    missing = [c for c in COLUMNS if c not in header]
    if missing:
        return [], [f"row 1: missing column(s) {', '.join(missing)}; expected {','.join(COLUMNS)}"]
    zones: dict[str, dict] = {}
    n = 0
    for i, raw in enumerate(reader, start=2):
        n += 1
        rec = {(k or "").strip(): (v or "").strip() for k, v in raw.items() if k is not None}
        if None in raw or any(rec.get(c, "") == "" for c in COLUMNS):
            errors.append(f"row {i}: expected {len(COLUMNS)} values")
            continue
        try:
            lat, lng = float(rec["lat"]), float(rec["lng"])
        except ValueError:
            errors.append(f"row {i}: lat/lng must be numbers")
            continue
        if not in_city(lat, lng):
            errors.append(f"row {i}: location {lat},{lng} is outside the Chennai service area")
            continue
        vals, bad = {}, None
        for c in COUNTS:
            try:
                v = int(rec[c])
            except ValueError:
                v = -1
            if v < 0:
                bad = c
                break
            vals[c] = v
        if bad:
            errors.append(f"row {i}: {bad} must be a whole number >= 0")
            continue
        z = zone_of(lat, lng)
        acc = zones.setdefault(z, {"zone_id": z, **{c: 0 for c in COUNTS}})
        for c in COUNTS:
            acc[c] += vals[c]
    if n == 0:
        errors.append("row 2: the file has no data rows")
    return ([], errors) if errors else (list(zones.values()), [])


def replace_demographics(db: Session, rows: list[dict], source: str) -> dict:
    """Replace all zone demographics (caller commits, so a failure leaves the old data intact)."""
    db.execute(delete(ZoneDemographics))
    now = utcnow()
    for r in rows:
        db.add(ZoneDemographics(zone_id=r["zone_id"], households=r["households"], pop_0_14=r["pop_0_14"],
                                pop_15_59=r["pop_15_59"], pop_60_74=r["pop_60_74"], pop_75_plus=r["pop_75_plus"],
                                source=source, updated_at=now))
    db.flush()
    return summary(db)


def load(db: Session) -> dict[str, ZoneDemographics]:
    return {z.zone_id: z for z in db.execute(select(ZoneDemographics)).scalars()}


def load_dicts(db: Session) -> dict[str, dict]:
    """zone_id -> plain counts (for code that must stay ORM-free, e.g. the synthetic history generator)."""
    return {z.zone_id: {c: getattr(z, c) for c in COUNTS} for z in db.execute(select(ZoneDemographics)).scalars()}


def summary(db: Session) -> dict:
    rows = list(db.execute(select(ZoneDemographics)).scalars())
    sources = {r.source for r in rows}
    return {"zones": len(rows), "households": sum(r.households for r in rows),
            "population": sum(r.population for r in rows), "seniors": sum(r.seniors for r in rows),
            "source": sources.pop() if len(sources) == 1 else ("mixed" if sources else None)}
