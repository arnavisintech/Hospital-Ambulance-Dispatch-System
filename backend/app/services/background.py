"""Background workers started from the app lifespan (UC-2 E1 ack-timeout watcher, analytics refresh, data
retention, demo autopilot when DEMO_AUTOPILOT=true). Each loop records a heartbeat per iteration; /api/health
and /api/ready report a worker whose heartbeat is older than its stale threshold."""
import asyncio
import logging
import time
from datetime import datetime, timedelta

from sqlalchemy import delete

from ..config import get_settings
from ..db import SessionLocal
from ..models import AmbulanceLocation, Notification, utcnow
from . import dispatch

log = logging.getLogger("hads.background")
TICK_S = 2.0
RETENTION_EVERY_S = 600.0
HEARTBEATS: dict[str, float] = {}  # worker name -> time.monotonic() of its last iteration
ACK_STALE_S = 10.0


def beat(name: str) -> None:
    HEARTBEATS[name] = time.monotonic()


def stale_after(name: str) -> float:
    """Seconds without a heartbeat after which a worker counts as stuck."""
    if name == "ack_timeout":
        return ACK_STALE_S
    if name == "retention":
        return 2 * RETENTION_EVERY_S + 60
    if name == "analytics":
        from .analytics_jobs import interval_seconds
        return 2 * interval_seconds() + 60
    return 120.0


def worker_ages(now: float | None = None) -> dict[str, float]:
    now = time.monotonic() if now is None else now
    return {k: round(now - v, 1) for k, v in HEARTBEATS.items()}


def stale_workers(now: float | None = None) -> list[str]:
    return sorted(k for k, age in worker_ages(now).items() if age > stale_after(k))


async def ack_timeout_loop(tick_s: float = TICK_S) -> None:
    """Every tick: reassign offers the crew did not acknowledge in time, then retry escalated requests."""
    while True:
        beat("ack_timeout")
        try:
            await asyncio.to_thread(dispatch.expire_stale_offers)
            await asyncio.to_thread(dispatch.retry_escalated)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - the watcher must never die
            log.exception("ack-timeout watcher iteration failed")
        await asyncio.sleep(tick_s)


def run_retention_once(now: datetime | None = None) -> dict[str, int]:
    """Delete raw GPS history and read notifications past their retention windows. Unread notifications stay."""
    s = get_settings()
    now = now or utcnow()
    with SessionLocal() as db:
        gps = db.execute(delete(AmbulanceLocation).where(
            AmbulanceLocation.recorded_at < now - timedelta(hours=s.gps_retention_hours))).rowcount
        notes = db.execute(delete(Notification).where(
            Notification.read_at.is_not(None),
            Notification.created_at < now - timedelta(days=s.notification_retention_days))).rowcount
        db.commit()
    return {"gps_locations": int(gps or 0), "notifications": int(notes or 0)}


async def retention_loop(every_s: float = RETENTION_EVERY_S) -> None:
    while True:
        beat("retention")
        try:
            out = await asyncio.to_thread(run_retention_once)
            if any(out.values()):
                log.info("retention removed %s", out)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            log.exception("retention iteration failed")
        await asyncio.sleep(every_s)


def start_background() -> list[asyncio.Task]:
    """Must be called from inside the running event loop (FastAPI lifespan)."""
    tasks = [asyncio.create_task(ack_timeout_loop(), name="hads-ack-timeout"),
             asyncio.create_task(retention_loop(), name="hads-retention")]
    try:  # ops-owned periodic model refresh; optional
        from . import analytics_jobs
        tasks.append(asyncio.create_task(analytics_jobs.loop(), name="hads-analytics-jobs"))
    except ImportError:
        pass
    if get_settings().demo_autopilot:
        from . import autopilot
        tasks.append(asyncio.create_task(autopilot.loop(), name="hads-demo-autopilot"))
    return tasks
