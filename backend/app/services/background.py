"""Background workers started from the app lifespan (UC-2 E1 ack-timeout watcher, analytics refresh,
demo autopilot when DEMO_AUTOPILOT=true)."""
import asyncio
import logging

from ..config import get_settings
from . import dispatch

log = logging.getLogger("hads.background")
TICK_S = 2.0


async def ack_timeout_loop(tick_s: float = TICK_S) -> None:
    """Every tick: reassign offers the crew did not acknowledge in time, then retry escalated requests."""
    while True:
        try:
            await asyncio.to_thread(dispatch.expire_stale_offers)
            await asyncio.to_thread(dispatch.retry_escalated)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - the watcher must never die
            log.exception("ack-timeout watcher iteration failed")
        await asyncio.sleep(tick_s)


def start_background() -> list[asyncio.Task]:
    """Must be called from inside the running event loop (FastAPI lifespan)."""
    tasks = [asyncio.create_task(ack_timeout_loop(), name="hads-ack-timeout")]
    try:  # ops-owned periodic model refresh; optional
        from . import analytics_jobs
        tasks.append(asyncio.create_task(analytics_jobs.loop(), name="hads-analytics-jobs"))
    except ImportError:
        pass
    if get_settings().demo_autopilot:
        from . import autopilot
        tasks.append(asyncio.create_task(autopilot.loop(), name="hads-demo-autopilot"))
    return tasks
