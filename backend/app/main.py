import asyncio
import importlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models  # noqa: F401  (register tables)
from .config import get_settings
from .db import Base, SessionLocal, engine
from .events import hub

log = logging.getLogger("hads")

# Routers are owned by different modules; each exposes `router` and is mounted under /api.
ROUTER_MODULES = [
    "auth", "requests", "crew", "controller", "hospitals", "tracking_ws",   # core workflow
    "public", "geo", "notifications",                                        # v2: share links, places, inbox
    "analytics", "rebalance", "billing", "dashboard", "admin", "audit",      # ops / analytics
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    s = get_settings()
    problems = s.production_problems()
    if problems:
        raise RuntimeError("Refusing to start in production: " + "; ".join(problems))
    hub.bind_loop(asyncio.get_running_loop())
    Base.metadata.create_all(engine)
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
                   allow_methods=["*"], allow_headers=["*"], allow_credentials=False)

for name in ROUTER_MODULES:
    try:
        mod = importlib.import_module(f"{__package__}.routers.{name}")
    except ModuleNotFoundError as e:
        if e.name and e.name.endswith(f"routers.{name}"):
            log.warning("router %s not present yet", name)
            continue
        raise
    app.include_router(mod.router)


@app.get("/api/health", tags=["system"])
def health():
    """Liveness/readiness probe for ALB / ECS health checks."""
    from sqlalchemy import text
    with SessionLocal() as db:
        db.execute(text("select 1"))
    from .services import routing
    s = get_settings()
    return {"status": "ok", "routing": routing.status(), "demo_autopilot": s.demo_autopilot}
