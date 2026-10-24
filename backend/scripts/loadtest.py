"""NFR4 / NFR1 load test: hold N simultaneously active emergency requests against a running HADS stack.

    python scripts/loadtest.py --base-url http://localhost:8000 --active 300 --duration 120 --json out.json

What it does (demo stack: APP_ENV=demo, DEMO_AUTOPILOT=true, so simulated crews accept and drive):
  1. tops the fleet up to --fleet ambulances through the admin API (spread over the existing stations);
  2. fires --active requests at once through the controller IVR channel (requester accounts are rate limited to
     20 SOS/hour by design; the controller path is exempt and runs the same intake + dispatch pipeline);
  3. polls every request until it has a dispatch decision (offered to a unit, or escalated to a controller because
     no unit is free) and keeps them active for --duration seconds while the autopilot works through them;
  4. cancels whatever is still open, so the stack is left clean.

Pass (exit 0): p95 server-side time to a dispatch decision (request created -> first offered / escalated status, read
from each request's own timeline, i.e. NFR1 measured where the SRS defines it) <= --target-s (8 s) and error rate <= 1 %.
The client-observed time (including HTTP queueing and the poll interval) is reported alongside. --ramp spreads arrivals
(0 = all at once, the worst case); --poll sets how often each simulated caller checks status (the app is pushed
updates over a websocket and polls every 6-20 s only as a fallback).
Reuses the HTTP helpers and the statistics of scripts/simulate.py.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import asyncio
import json
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from simulate import HOTSPOTS, TYPES, Sim, summarise  # noqa: E402

DECIDED = {"offered", "accepted", "en_route", "on_scene", "transporting", "arrived", "completed", "awaiting_manual"}
OPEN = DECIDED - {"completed"} | {"received", "matching"}


class LoadTest(Sim):
    def __init__(self, a: argparse.Namespace):
        super().__init__(a)
        self.decision_s: list[float] = []       # client-observed
        self.server_decision_s: list[float] = []  # created_at -> first decision, from the request timeline
        self.calls = 0
        self.outcomes: dict[str, int] = {}

    async def call(self, method, path, headers, **kw):
        self.calls += 1
        return await super().call(method, path, headers, **kw)

    async def top_up_fleet(self, admin: dict) -> int:
        stations = (await self.call("GET", "/admin/stations", admin)).json()
        have = sum(s.get("ambulances", 0) for s in stations)
        need = max(0, self.a.fleet - have)
        tag = uuid.uuid4().hex[:4].upper()
        for i in range(need):
            st = stations[i % len(stations)]["id"]
            r = await self.call("POST", f"/admin/stations/{st}/ambulances", admin,
                                json={"registration_number": f"TN99LT{tag}{i:04d}", "kind": "ALS" if i % 4 == 0 else "BLS"})
            if r is None or r.status_code >= 300:
                self.errors.append(f"register ambulance -> {getattr(r, 'status_code', 'x')}")
        return have + need

    async def one(self, i: int, ctl: dict, until: float) -> int | None:
        if self.a.ramp:
            await asyncio.sleep(self.a.ramp * i / max(self.a.active, 1))
        lat, lng = self.rng.choice(HOTSPOTS)
        body = {"client_uuid": str(uuid.uuid4()), "lat": lat + self.rng.uniform(-0.012, 0.012),
                "lng": lng + self.rng.uniform(-0.012, 0.012), "incident_type": self.rng.choice(TYPES),
                "severity": self.rng.randint(1, 5), "caller_phone": "9000000000", "notes": f"load test #{i}"}
        t0 = time.perf_counter()
        r = await self.call("POST", "/requests/ivr", ctl, json=body)
        if r is None or r.status_code not in (200, 201):
            self.errors.append(f"POST /requests/ivr #{i} -> {getattr(r, 'status_code', 'x')}")
            return None
        self.metrics["post_ms"].append((time.perf_counter() - t0) * 1000)
        rid, decided = r.json()["id"], False
        while time.perf_counter() < until:
            g = await self.call("GET", f"/requests/{rid}", ctl)
            if g is not None and g.status_code == 200:
                j = g.json()
                if not decided and j["status"] in DECIDED:
                    decided = True
                    self.decision_s.append(time.perf_counter() - t0)
                    server = _server_decision_s(j)
                    if server is not None:
                        self.server_decision_s.append(server)
                    if j.get("match_duration_ms") is not None:
                        self.metrics["match_ms"].append(j["match_duration_ms"])
                if j["status"] in ("completed", "cancelled"):
                    break
            await asyncio.sleep(self.a.poll if not decided else max(self.a.poll, 5.0))
        if not decided:
            self.errors.append(f"request {rid}: no dispatch decision within the run")
        return rid

    async def run(self) -> dict:
        a = self.a
        admin, ctl = await self.login(a.admin), await self.login(a.controller)
        fleet = await self.top_up_fleet(admin)
        await asyncio.sleep(a.settle)   # let the autopilot give new units a GPS heartbeat
        start = time.perf_counter()
        rids = await asyncio.gather(*(self.one(i, ctl, start + a.duration) for i in range(a.active)))
        wall = time.perf_counter() - start
        for rid in filter(None, rids):   # leave the stack clean
            g = await self.call("GET", f"/requests/{rid}", ctl)
            status = g.json()["status"] if g is not None and g.status_code == 200 else "unknown"
            self.outcomes[status] = self.outcomes.get(status, 0) + 1
            if status in OPEN:
                await self.call("POST", f"/requests/{rid}/cancel", ctl, json={"reason": "load test cleanup"})
        await self.client.aclose()
        p95 = summarise(self.server_decision_s)["p95"]
        n_err = len(self.errors)
        return {"config": {k: v for k, v in vars(a).items()}, "fleet": fleet, "active": a.active, "wall_s": round(wall, 1),
                "http_calls": self.calls, "error_rate_pct": round(100 * n_err / max(self.calls, 1), 3),
                "server_decision_s": summarise(self.server_decision_s), "client_decision_s": summarise(self.decision_s), "post_ms": summarise(self.metrics["post_ms"]),
                "match_ms": summarise(self.metrics["match_ms"]), "outcomes_at_end": self.outcomes,
                "errors": self.errors[:25], "n_errors": n_err,
                "pass": p95 is not None and p95 <= a.target_s and 100 * n_err / max(self.calls, 1) <= a.max_error_pct}


def _server_decision_s(req: dict) -> float | None:
    """Seconds from the request's creation to its first dispatch decision, from its own status timeline."""
    created, first = None, None
    for ev in req.get("timeline") or []:
        at = datetime.fromisoformat(ev["at"])
        if ev["status"] == "received" and created is None:
            created = at
        elif ev["status"] in DECIDED and first is None:
            first = at
    return None if created is None or first is None else max(0.0, (first - created).total_seconds())


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", default="http://localhost:8000")
    p.add_argument("--active", type=int, default=300, help="simultaneously active requests (NFR4: 300)")
    p.add_argument("--duration", type=float, default=120, help="seconds to keep them active")
    p.add_argument("--fleet", type=int, default=150, help="top the fleet up to this many ambulances")
    p.add_argument("--settle", type=float, default=35, help="seconds for new units to get a GPS heartbeat")
    p.add_argument("--admin", default="admin@hads.in")
    p.add_argument("--controller", default="controller@hads.in")
    p.add_argument("--poll", type=float, default=2.0, help="seconds between a caller's status checks")
    p.add_argument("--ramp", type=float, default=0.0, help="spread the arrivals over this many seconds (0 = burst)")
    p.add_argument("--target-s", type=float, default=8, help="NFR1: p95 time to a dispatch decision")
    p.add_argument("--max-error-pct", type=float, default=1.0)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--json", help="write full results to this file")
    a = p.parse_args()
    res = asyncio.run(LoadTest(a).run())
    d, c, m, q = res["server_decision_s"], res["client_decision_s"], res["post_ms"], res["match_ms"]
    print(f"\nHADS load test: {res['active']} simultaneous requests, fleet {res['fleet']}, {res['wall_s']} s, "
          f"{res['http_calls']} HTTP calls, error rate {res['error_rate_pct']} %")
    print(f"  NFR1 decision, server (s):     p50 {d['p50']}  p95 {d['p95']}  p99 {d['p99']}  max {d['max']}  (n={d['n']})")
    print(f"  decision seen by caller (s):   p50 {c['p50']}  p95 {c['p95']}  max {c['max']}")
    print(f"  intake POST (ms):              p50 {m['p50']}  p95 {m['p95']}  max {m['max']}")
    print(f"  server match time (ms):        p50 {q['p50']}  p95 {q['p95']}  max {q['max']}")
    print(f"  outcomes before cleanup: {res['outcomes_at_end']}")
    for e in res["errors"][:10]:
        print("  !", e)
    print("PASS" if res["pass"] else "FAIL")
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=2)
    return 0 if res["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
