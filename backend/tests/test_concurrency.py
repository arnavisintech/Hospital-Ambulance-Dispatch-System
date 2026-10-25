"""Concurrency proof for dispatch (Task 24): simultaneous SOS requests never double-book an ambulance, nothing is left
half-dispatched, and higher severity is offered first. Runs on SQLite by default and on PostgreSQL when
HADS_TEST_DATABASE_URL is set (scripts/test-postgres.ps1)."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db import SessionLocal
from app.main import app
from app.models import (Ambulance, AmbulanceStatus, AttemptStatus, DispatchAttempt, EmergencyRequest, RequestStatus,
                        Role, utcnow)
from app.services import dispatch
from conftest import PATIENT

N_REQUESTS, N_AMBULANCES = 40, 10
TERMINAL = {RequestStatus.completed, RequestStatus.cancelled}


def _fleet(world, n):
    st = world.station(world.hospital())
    return [world.ambulance(st, lat=PATIENT[0] + 0.001 * i, lng=PATIENT[1]) for i in range(n)]


def test_simultaneous_sos_never_double_books(world):
    _fleet(world, N_AMBULANCES)
    users = [world.user(Role.requester) for _ in range(N_REQUESTS)]

    def sos(u):
        c = TestClient(app)  # own client per thread, like separate phones (no lifespan: no background workers)
        r = c.post("/api/requests", headers=u["h"], json={"lat": PATIENT[0], "lng": PATIENT[1], "severity": 3})
        return r.status_code

    with ThreadPoolExecutor(max_workers=16) as pool:
        codes = list(pool.map(sos, users))
    assert Counter(codes) == {201: N_REQUESTS}

    with SessionLocal() as db:
        reqs = db.execute(select(EmergencyRequest)).scalars().all()
        assert len(reqs) == N_REQUESTS
        statuses = Counter(r.status for r in reqs)
        assert statuses[RequestStatus.offered] == N_AMBULANCES
        assert statuses[RequestStatus.awaiting_manual] == N_REQUESTS - N_AMBULANCES
        assert not statuses[RequestStatus.received] and not statuses[RequestStatus.matching]

        live = [r.ambulance_id for r in reqs if r.ambulance_id and r.status not in TERMINAL]
        assert len(live) == len(set(live)) == N_AMBULANCES        # no ambulance in two live requests

        offered = Counter(a.ambulance_id for a in db.execute(
            select(DispatchAttempt).where(DispatchAttempt.status == AttemptStatus.offered)).scalars())
        for amb in db.execute(select(Ambulance)).scalars():
            assert amb.status == AmbulanceStatus.assigned
            assert offered[amb.id] == 1


def test_higher_severity_is_offered_first(world):
    _fleet(world, 3)
    now = utcnow()
    with SessionLocal() as db:
        low = [EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=1, created_at=now) for _ in range(3)]
        high = [EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=5, created_at=now) for _ in range(3)]
        db.add_all(low + high)   # low-severity rows get the smaller ids
        db.commit()
        low_ids = [r.id for r in low]
    dispatch.run_dispatch(low_ids[0])
    with SessionLocal() as db:
        attempts = db.execute(select(DispatchAttempt).order_by(DispatchAttempt.offered_at, DispatchAttempt.id)).scalars().all()
        sev = {r.id: r.severity for r in db.execute(select(EmergencyRequest)).scalars()}
        assert [sev[a.request_id] for a in attempts] == [5, 5, 5]
        assert db.get(EmergencyRequest, low_ids[0]).status == RequestStatus.awaiting_manual


def test_dispatch_never_parks_the_calling_thread(world):
    """A burst of SOS must not tie up server threads waiting on the dispatch lock: run_dispatch returns at once when
    another thread is dispatching, and that thread (or the watcher's sweep) picks the request up."""
    import threading
    import time

    _fleet(world, 1)
    with SessionLocal() as db:
        req = EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=3)
        db.add(req)
        db.commit()
        rid = req.id
    held, release = threading.Event(), threading.Event()

    def holder():
        with dispatch._LOCK:
            held.set()
            release.wait(5)
    t = threading.Thread(target=holder)
    t.start()
    held.wait(5)
    t0 = time.perf_counter()
    caller = threading.Thread(target=dispatch.run_dispatch, args=(rid,))
    caller.start()
    caller.join(2)
    assert not caller.is_alive() and time.perf_counter() - t0 < 1.0     # returned instead of waiting
    release.set()
    t.join(5)
    with SessionLocal() as db:
        assert db.get(EmergencyRequest, rid).status == RequestStatus.received   # lock holder was not a dispatcher
    dispatch.run_dispatch()                                                   # the watcher's sweep (every tick)
    with SessionLocal() as db:
        assert db.get(EmergencyRequest, rid).status == RequestStatus.offered


def test_watcher_sweeps_stranded_requests(world, monkeypatch):
    """A request whose dispatch task never ran (process stopped after the commit) is still dispatched."""
    import asyncio

    from app.services import background
    _fleet(world, 1)
    with SessionLocal() as db:
        req = EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=4)
        db.add(req)
        db.commit()
        rid = req.id
    monkeypatch.setattr(dispatch, "expire_stale_offers", lambda: [])
    monkeypatch.setattr(dispatch, "retry_escalated", lambda: [])

    async def one_tick():
        task = asyncio.create_task(background.ack_timeout_loop(0.05))
        await asyncio.sleep(0.3)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    asyncio.run(one_tick())
    with SessionLocal() as db:
        assert db.get(EmergencyRequest, rid).status == RequestStatus.offered


def test_cancel_during_dispatch_is_never_overwritten(world, monkeypatch):
    """Final review: a cancel that lands while the request waits in the dispatch drain (e.g. during the routing call)
    must win: no ambulance is offered to a cancelled call."""
    from app.services import routing, trips
    amb = _fleet(world, 1)[0]
    with SessionLocal() as db:
        req = EmergencyRequest(lat=PATIENT[0], lng=PATIENT[1], severity=3)
        db.add(req)
        db.commit()
        rid = req.id
    real = routing.eta_many

    def eta_many_then_cancel(*a, **kw):
        with SessionLocal() as other:                 # the requester cancels while routing is in flight
            r = other.get(EmergencyRequest, rid)
            if r.status not in trips.TERMINAL:
                trips.cancel_request(other, r, None, "changed my mind")
        return real(*a, **kw)
    monkeypatch.setattr(routing, "eta_many", eta_many_then_cancel)
    dispatch.run_dispatch(rid)
    with SessionLocal() as db:
        assert db.get(EmergencyRequest, rid).status == RequestStatus.cancelled
        assert db.get(EmergencyRequest, rid).ambulance_id is None
        assert db.get(Ambulance, amb).status == AmbulanceStatus.available
        assert db.execute(select(DispatchAttempt).where(DispatchAttempt.request_id == rid)).first() is None
