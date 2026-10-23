"""Periodic model refresh (FR8). Started by services.background.start_background() when importable.

Interval: env HADS_ANALYTICS_INTERVAL_S (seconds, default 3600) or, if set, PlatformSetting
analytics_retrain_interval_min. Retrains when live incidents were added since the last model (or no model exists).
Never raises: failures are logged and the loop continues.
"""
from __future__ import annotations

import asyncio
import logging
import os

from sqlalchemy import func, select

from .. import db as dbmod
from ..models import IncidentHistory, PlatformSetting
from . import analytics

log = logging.getLogger("hads.analytics.jobs")


def interval_seconds() -> float:
    default = float(os.environ.get("HADS_ANALYTICS_INTERVAL_S", "3600"))
    try:
        with dbmod.SessionLocal() as db:
            row = db.get(PlatformSetting, "analytics_retrain_interval_min")
            if row and isinstance(row.value, dict) and row.value.get("value"):
                return max(60.0, float(row.value["value"]) * 60.0)
    except Exception:
        pass
    return max(1.0, default)


def run_once(force: bool = False) -> dict | None:
    """Synchronous retrain-if-needed (runs in a worker thread). Returns metrics or None if skipped."""
    with dbmod.SessionLocal() as db:
        info = analytics.model_info(db, history=1)
        n_live = db.scalar(select(func.count(IncidentHistory.id)).where(IncidentHistory.source == "live")) or 0
        if not force and info["model_version"] and n_live <= (info.get("n_live") or 0):
            return None
        return analytics.train_model(db)


async def loop() -> None:
    while True:
        try:
            await asyncio.sleep(interval_seconds())
            res = await asyncio.to_thread(run_once)
            if res:
                log.info("periodic retrain done: %s", res)
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("analytics refresh failed; will retry next interval")
            await asyncio.sleep(1)
