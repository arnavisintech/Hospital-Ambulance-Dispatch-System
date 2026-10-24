"""Compliance and equity reports (CSV) for the authority and admins.

Compliance checks the window's KPIs (the same numbers as /api/dashboard/summary) against the SRS targets.
Equity groups incidents by the senior share of the zone they happened in, so an authority can see whether
senior-heavy neighbourhoods are served more slowly. Demographics never influence dispatch (STRQ1); they are
only used here and in the demand model.
"""
from __future__ import annotations

import csv
import io
from datetime import timedelta

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import audit, demographics
from ..geo import zone_of
from ..models import EmergencyRequest, RequestStatus, TripRecord, utcnow
from . import kpis
from .billing import get_platform_settings

DISPATCH_WITHIN_TARGET_PCT = 95.0   # share of requests that must meet the NFR1 matching target
HANDOVER_LOGGED_PCT = 95.0          # completed trips with a recorded hospital handover (UC-4)
QUARTILES = ["Q1 (fewest seniors)", "Q2", "Q3", "Q4 (most seniors)"]
UNKNOWN = "unknown"
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _pct(n: int, d: int) -> float | None:
    return round(100.0 * n / d, 1) if d else None


def _handover_logged(db: Session, days: int) -> tuple[int, int]:
    since = utcnow() - timedelta(days=days)
    rows = db.execute(select(TripRecord.handover_time).join(EmergencyRequest, EmergencyRequest.id == TripRecord.request_id)
                      .where(EmergencyRequest.created_at >= since,
                             EmergencyRequest.status == RequestStatus.completed)).scalars().all()
    return sum(1 for h in rows if h is not None), len(rows)


def compliance_rows(db: Session, days: int) -> list[dict]:
    s = kpis.summary(db, days)
    k, sla = s["kpis"], s["sla"]
    response_target = int(get_platform_settings(db)["response_target_s"])
    p90 = k["p90_response_s"]
    within = sla["within_target_pct"]
    logged, completed_trips = _handover_logged(db, days)
    handover_pct = _pct(logged, completed_trips)
    chain = audit.verify_chain(db)

    def met(ok):
        return None if ok is None else bool(ok)

    return [
        {"key": "response_p90", "metric": "Response time, 90th percentile (call to scene, s)",
         "target": f"<= {response_target}", "value": p90, "met": met(None if p90 is None else p90 <= response_target)},
        {"key": "dispatch_within_target", "metric": f"Requests matched within {sla['nfr1_target_s']} s (NFR1, %)",
         "target": f">= {DISPATCH_WITHIN_TARGET_PCT:g}", "value": within,
         "met": met(None if within is None else within >= DISPATCH_WITHIN_TARGET_PCT)},
        {"key": "redirect_avoided", "metric": "Trips where a full hospital was avoided (%)", "target": "reported",
         "value": _pct(k["redirect_avoided"], k["completed"]), "met": None},
        {"key": "handover_logged", "metric": "Completed trips with a logged handover (%)",
         "target": f">= {HANDOVER_LOGGED_PCT:g}", "value": handover_pct,
         "met": met(None if handover_pct is None else handover_pct >= HANDOVER_LOGGED_PCT)},
        {"key": "audit_chain", "metric": "Audit log hash chain intact (NFR7)", "target": "intact",
         "value": f"intact ({chain['checked']} entries)" if chain["ok"] else f"broken at entry {chain['broken_at']}",
         "met": chain["ok"]},
    ]


def equity_rows(db: Session, days: int) -> list[dict]:
    """Four senior-share quartiles of zones (by zone, not by population) plus incidents in zones without data."""
    shares = {z: d.senior_share for z, d in demographics.load(db).items()}
    group_of: dict[str, str] = {}
    bounds: dict[str, list[float]] = {g: [] for g in QUARTILES}
    if len(shares) >= len(QUARTILES):
        ser = pd.Series(shares)
        q = pd.qcut(ser.rank(method="first"), len(QUARTILES), labels=QUARTILES)
        for z, g in q.items():
            group_of[z] = g
            bounds[g].append(shares[z])

    since = utcnow() - timedelta(days=days)
    rows = db.execute(select(EmergencyRequest.lat, EmergencyRequest.lng, TripRecord.response_time_seconds)
                      .outerjoin(TripRecord, TripRecord.request_id == EmergencyRequest.id)
                      .where(EmergencyRequest.created_at >= since)).all()
    per: dict[str, list] = {g: [] for g in [*QUARTILES, UNKNOWN]}
    for lat, lng, resp in rows:
        per[group_of.get(zone_of(lat, lng), UNKNOWN)].append(resp)

    out = []
    for g in [*QUARTILES, UNKNOWN]:
        resp = pd.Series([r for r in per[g] if r is not None], dtype=float)
        b = bounds.get(g) or []
        out.append({"group": g, "zones": len(b) if g != UNKNOWN else None,
                    "senior_share_min": round(min(b), 4) if b else None,
                    "senior_share_max": round(max(b), 4) if b else None,
                    "requests": len(per[g]),
                    "median_response_s": round(float(resp.median()), 1) if len(resp) else None})
    return out


def _cell(v) -> str | int | float:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (int, float)):
        return v
    s = str(v)
    if s.startswith(_FORMULA_PREFIXES) and not _is_number(s):   # spreadsheet formula injection
        return "'" + s
    return s


def _is_number(s: str) -> bool:
    try:
        float(s)
    except ValueError:
        return False
    return s.strip() == s


def to_csv(header: list[str], rows) -> str:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(header)
    for row in rows:
        w.writerow([_cell(v) for v in row])
    return buf.getvalue()


def _share_range(r: dict) -> str:
    if r["senior_share_min"] is None:
        return "no demographics"
    return f"{100 * r['senior_share_min']:.1f}-{100 * r['senior_share_max']:.1f} % seniors"


def report_csv(db: Session, days: int) -> str:
    rows = [["compliance", r["metric"], r["target"], r["value"], r["met"]] for r in compliance_rows(db, days)]
    for r in equity_rows(db, days):
        rows.append(["equity", f"{r['group']}: median response (s)", _share_range(r), r["median_response_s"], None])
        rows.append(["equity", f"{r['group']}: requests", _share_range(r), r["requests"], None])
    return to_csv(["section", "metric", "target", "value", "met"], rows)
