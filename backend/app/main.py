import asyncio
import importlib
import logging
from contextlib import asynccontextmanager

import anyio.to_thread
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import models  # noqa: F401  (register tables)
from .config import get_settings
from .db import Base, SessionLocal, engine
from .events import hub
from .logging_setup import configure_logging
from .middleware import ConcurrencyLimitMiddleware, RequestContextMiddleware

log = logging.getLogger("hads")

# Routers are owned by different modules; each exposes `router` and is mounted under /api.
ROUTER_MODULES = [
    "auth", "requests", "crew", "controller", "hospitals", "tracking_ws",   # core workflow
    "public", "geo", "notifications", "interop",                             # v2: share links, places, inbox, 108/102
    "analytics", "rebalance", "billing", "dashboard", "admin", "audit",      # ops / analytics
]


def _require_migrated() -> None:
    from sqlalchemy import inspect
    if "alembic_version" not in inspect(engine).get_table_names():
        raise RuntimeError("Database schema is not initialised: run `python scripts/migrate.py` before starting "
                           "the API (set AUTO_CREATE_SCHEMA=true only for throwaway test databases)")


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    configure_logging(s.log_json)
    anyio.to_thread.current_default_thread_limiter().total_tokens = s.api_threads  # see Settings.api_threads
    problems = s.production_problems()
    if problems:
        raise RuntimeError("Refusing to start in production: " + "; ".join(problems))
    hub.bind_loop(asyncio.get_running_loop())
    if s.auto_create_schema:
        Base.metadata.create_all(engine)
    else:
        _require_migrated()
    if s.seed_on_startup or s.is_demo:
        try:
            from .seed import seed_if_empty
            with SessionLocal() as db:
                seed_if_empty(db)
        except ImportError:
            log.warning("seed module not present yet")
    else:
        from .bootstrap import ensure_bootstrap_admin
        with SessionLocal() as db:
            if ensure_bootstrap_admin(db):
                log.info("bootstrap admin created")
    try:  # v2: give pre-existing / seeded requests a status timeline (idempotent)
        from .services.trips import backfill_events
        with SessionLocal() as db:
            n = backfill_events(db)
            db.commit()
            if n:
                log.info("backfilled %d request timeline events", n)
    except Exception:  # noqa: BLE001 - never block startup on a backfill
        log.exception("timeline backfill failed")
    tasks = []
    try:  # background workers: crew-ack timeout watcher, periodic model refresh, etc.
        from .services.background import start_background
        tasks = start_background()
    except ImportError:
        pass
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="HADS - Hospital Ambulance Dispatch System", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[o.strip() for o in get_settings().cors_origins.split(",")],
                   allow_methods=["*"], allow_headers=["*"], allow_credentials=False,
                   expose_headers=["X-Request-ID", "Content-Disposition"])
app.add_middleware(ConcurrencyLimitMiddleware, limit=get_settings().api_threads)  # admission control (see class)
app.add_middleware(RequestContextMiddleware)  # outermost: every response and log line carries the request id

for name in ROUTER_MODULES:
    try:
        mod = importlib.import_module(f"{__package__}.routers.{name}")
    except ModuleNotFoundError as e:
        if e.name and e.name.endswith(f"routers.{name}"):
            log.warning("router %s not present yet", name)
            continue
        raise
    app.include_router(mod.router)


def _db_ok() -> bool:
    from sqlalchemy import text
    try:
        with SessionLocal() as db:
            db.execute(text("select 1"))
        return True
    except Exception:  # noqa: BLE001 - reported, never raised
        log.exception("database health check failed")
        return False


@app.get("/api/health", tags=["system"])
def health():
    """Liveness: always 200 while the process serves HTTP; `status` is `degraded` if the DB or a worker is unhealthy."""
    from .services import background, routing
    db_ok = _db_ok()
    stale = background.stale_workers()
    return {"status": "ok" if db_ok and not stale else "degraded", "db": db_ok,
            "workers": background.worker_ages(), "stale_workers": stale,
            "routing": routing.status(), "demo_autopilot": get_settings().demo_autopilot}


@app.get("/api/ready", tags=["system"])
def ready():
    """Readiness: 503 when the DB is unreachable or the dispatch ack-timeout watcher has stopped beating."""
    from .services import background
    problems = []
    if not _db_ok():
        problems.append("database unreachable")
    age = background.worker_ages().get("ack_timeout")
    if age is None or age > background.ACK_STALE_S:
        problems.append("ack_timeout worker " + ("not started" if age is None else f"stale ({age:.0f} s)"))
    if problems:
        return JSONResponse({"ready": False, "detail": "; ".join(problems)}, status_code=503)
    return {"ready": True}
