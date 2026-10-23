"""HADS load / behaviour simulator (for the NFR1 evaluation).

Runs against a live server. Logs in as the demo requester and crew accounts (+ hospital staff for handover), fires N
concurrent emergency requests, auto-accepts offers as crew, drives each ambulance along the returned route via
POST /crew/location, walks the trip state machine and finally confirms handover. Reports latency percentiles.

    python scripts/simulate.py --base-url http://localhost:8000 --requests 20 --concurrency 10 --crews 10
    python scripts/simulate.py --requests 50 --json results.json --speed 40
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import statistics
import sys
import time
import uuid

import httpx

PASSWORD = "Hads@1234"
HOTSPOTS = [(13.0418, 80.2341), (13.0694, 80.1948), (13.0067, 80.2206), (13.0630, 80.2640), (13.0780, 80.2600),
            (12.9815, 80.2180), (13.0067, 80.2570), (13.1210, 80.2330), (13.0382, 80.1565), (13.0850, 80.2101)]
TYPES = ["cardiac", "trauma", "stroke", "respiratory", "maternity", "burns", "poisoning", "other"]


def pct(vals: list[float], p: float) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    k = (len(s) - 1) * p / 100
    f, c = int(k), min(int(k) + 1, len(s) - 1)
    return round(s[f] + (s[c] - s[f]) * (k - f), 3)


def summarise(vals: list[float]) -> dict:
    return {"n": len(vals), "mean": round(statistics.fmean(vals), 3) if vals else None, "p50": pct(vals, 50),
            "p90": pct(vals, 90), "p95": pct(vals, 95), "p99": pct(vals, 99), "max": round(max(vals), 3) if vals else None}


class Sim:
    def __init__(self, a: argparse.Namespace):
        self.a = a
        self.base = a.base_url.rstrip("/") + "/api"
        self.client = httpx.AsyncClient(timeout=30, limits=httpx.Limits(max_connections=200))
        self.rng = random.Random(a.seed)
        self.stop = asyncio.Event()
        self.metrics: dict[str, list[float]] = {k: [] for k in ("post_ms", "to_offered_s", "to_accepted_s", "match_ms", "trip_s")}
        self.errors: list[str] = []
        self.completed = self.failed = 0
        self.handled: set[int] = set()
        self.staff: dict[int, dict] = {}   # hospital_id -> auth headers

    # ---------------------------------------------------------------- http helpers
    async def login(self, email: str) -> dict:
        r = await self.client.post(f"{self.base}/auth/login", json={"identifier": email, "password": PASSWORD})
        r.raise_for_status()
        return {"Authorization": f"Bearer {r.json()['token']}"}

    async def call(self, method: str, path: str, headers: dict, **kw) -> httpx.Response | None:
        try:
            r = await self.client.request(method, f"{self.base}{path}", headers=headers, **kw)
            if r.status_code >= 500:
                self.errors.append(f"{method} {path} -> {r.status_code}")
            return r
        except httpx.HTTPError as e:
            self.errors.append(f"{method} {path} -> {type(e).__name__}")
            return None

    # ---------------------------------------------------------------- crew behaviour
    async def crew_worker(self, idx: int) -> None:
        email = f"crew{idx}@hads.in"
        try:
            h = await self.login(email)
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"login {email}: {e}")
            return
        await self.call("POST", "/crew/duty", h, json={"on_duty": True})
        while not self.stop.is_set():
            r = await self.call("GET", "/crew/me", h)
            offer = r.json().get("pending_offer") if r is not None and r.status_code == 200 else None
            if offer and offer["id"] not in self.handled:
                self.handled.add(offer["id"])
                await asyncio.sleep(self.rng.uniform(*self.a.accept_delay))
                acc = await self.call("POST", f"/crew/offers/{offer['id']}/accept", h)
                if acc is not None and acc.status_code < 300:
                    await self.drive_trip(offer["id"], h)
                continue
            await asyncio.sleep(self.a.poll)

    async def drive_trip(self, rid: int, h: dict) -> None:
        t0 = time.perf_counter()
        for phase_status, final in (("en_route", "on_scene"), ("transporting", "arrived")):
            await self.call("POST", f"/crew/trips/{rid}/status", h, json={"status": phase_status})
            rt = await self.call("GET", f"/crew/trips/{rid}/route", h)
            if rt is not None and rt.status_code == 200:
                await self.follow(rt.json().get("polyline", []), h)
            await self.call("POST", f"/crew/trips/{rid}/status", h, json={"status": final})
        # hospital staff confirms handover
        info = await self.call("GET", f"/requests/{rid}", h)
        hid = (info.json().get("destination_hospital") or {}).get("id") if info is not None and info.status_code == 200 else None
        if hid and hid in self.staff:
            r = await self.call("POST", f"/hospitals/{hid}/handover/{rid}", self.staff[hid])
            if r is not None and r.status_code < 300:
                self.completed += 1
                self.metrics["trip_s"].append(time.perf_counter() - t0)
                return
        self.failed += 1

    async def follow(self, poly: list, h: dict) -> None:
        """Send ~`steps` GPS points along the polyline (sleep scaled by --speed)."""
        if len(poly) < 2:
            return
        pts = poly if len(poly) <= self.a.steps else [poly[int(i * (len(poly) - 1) / (self.a.steps - 1))] for i in range(self.a.steps)]
        for lat, lng in pts:
            await self.call("POST", "/crew/location", h, json={"lat": lat, "lng": lng})
            await asyncio.sleep(self.a.step_delay / max(self.a.speed, 0.01))

    # ---------------------------------------------------------------- requester
    async def fire(self, i: int, h: dict, sem: asyncio.Semaphore) -> None:
        async with sem:
            lat, lng = self.rng.choice(HOTSPOTS)
            body = {"client_uuid": str(uuid.uuid4()), "lat": lat + self.rng.uniform(-0.012, 0.012),
                    "lng": lng + self.rng.uniform(-0.012, 0.012), "incident_type": self.rng.choice(TYPES),
                    "severity": self.rng.randint(2, 5), "notes": f"simulated #{i}"}
            t0 = time.perf_counter()
            r = await self.call("POST", "/requests", h, json=body)
            if r is None or r.status_code not in (200, 201):
                self.failed += 1
                self.errors.append(f"POST /requests #{i} -> {getattr(r, 'status_code', 'x')}")
                return
            self.metrics["post_ms"].append((time.perf_counter() - t0) * 1000)
            rid, offered, accepted = r.json()["id"], None, None
            deadline = t0 + self.a.timeout
            while time.perf_counter() < deadline and accepted is None:
                g = await self.call("GET", f"/requests/{rid}", h)
                if g is not None and g.status_code == 200:
                    j, now = g.json(), time.perf_counter() - t0
                    if offered is None and j["status"] in ("offered", "accepted", "en_route", "on_scene", "transporting",
                                                           "arrived", "completed"):
                        offered = now
                        self.metrics["to_offered_s"].append(now)
                        if j.get("match_duration_ms") is not None:
                            self.metrics["match_ms"].append(j["match_duration_ms"])
                    if j["status"] in ("accepted", "en_route", "on_scene", "transporting", "arrived", "completed"):
                        accepted = now
                        self.metrics["to_accepted_s"].append(now)
                    if j["status"] in ("awaiting_manual", "failed", "cancelled"):
                        self.errors.append(f"request {rid} ended {j['status']}")
                        self.failed += 1
                        return
                await asyncio.sleep(self.a.poll)
            if accepted is None:
                self.errors.append(f"request {rid} not accepted within {self.a.timeout}s")

    async def run(self) -> dict:
        a = self.a
        user_h = await self.login(a.user)
        for hid in range(1, a.hospitals + 1):
            try:
                me = (await self.client.get(f"{self.base}/auth/me", headers=(sh := await self.login(f"staff{hid}@hads.in")))).json()
                self.staff[me.get("hospital_id") or hid] = sh
            except Exception as e:  # noqa: BLE001
                self.errors.append(f"staff{hid} login: {e}")
        crews = [asyncio.create_task(self.crew_worker(i)) for i in range(1, a.crews + 1)]
        await asyncio.sleep(0.5)
        sem = asyncio.Semaphore(a.concurrency)
        t0 = time.perf_counter()
        await asyncio.gather(*(self.fire(i, user_h, sem) for i in range(a.requests)))
        wall_dispatch = time.perf_counter() - t0
        if not a.no_drain:   # let in-flight trips finish
            end = time.perf_counter() + a.drain
            while time.perf_counter() < end and self.completed + self.failed < a.requests:
                await asyncio.sleep(0.5)
        self.stop.set()
        await asyncio.gather(*crews, return_exceptions=True)
        await self.client.aclose()
        return {"config": {k: v for k, v in vars(a).items()}, "requests": a.requests, "completed_trips": self.completed,
                "failed": self.failed, "wall_dispatch_s": round(wall_dispatch, 2),
                "latency": {k: summarise(v) for k, v in self.metrics.items()}, "errors": self.errors[:25],
                "n_errors": len(self.errors),
                "nfr1_within_target_pct": round(100 * sum(1 for m in self.metrics["match_ms"] if m <= a.target_s * 1000)
                                                / len(self.metrics["match_ms"]), 1) if self.metrics["match_ms"] else None}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--base-url", default="http://localhost:8000")
    p.add_argument("--requests", "-n", type=int, default=10)
    p.add_argument("--concurrency", "-c", type=int, default=5)
    p.add_argument("--crews", type=int, default=10, help="crew accounts crew1..crewN to run (max 10 in the seed)")
    p.add_argument("--hospitals", type=int, default=8)
    p.add_argument("--user", default="user@hads.in")
    p.add_argument("--speed", type=float, default=20.0, help="time-compression factor for driving (higher = faster)")
    p.add_argument("--steps", type=int, default=12, help="GPS points sent per route leg")
    p.add_argument("--step-delay", type=float, default=2.0, help="seconds between GPS points at speed 1")
    p.add_argument("--accept-delay", type=float, nargs=2, default=(0.2, 1.5), metavar=("MIN", "MAX"))
    p.add_argument("--poll", type=float, default=0.25)
    p.add_argument("--timeout", type=float, default=60, help="per-request seconds to wait for acceptance")
    p.add_argument("--drain", type=float, default=300, help="max seconds to wait for trips to finish after dispatch")
    p.add_argument("--no-drain", action="store_true")
    p.add_argument("--target-s", type=float, default=8, help="NFR1 dispatch target")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--json", help="write full results to this file")
    a = p.parse_args()
    res = asyncio.run(Sim(a).run())
    print(f"\nHADS simulation: {res['requests']} requests, {res['completed_trips']} trips completed, {res['failed']} failed, "
          f"{res['n_errors']} errors, dispatch wall time {res['wall_dispatch_s']}s")
    print(f"{'metric':<14}{'n':>5}{'mean':>10}{'p50':>10}{'p90':>10}{'p95':>10}{'p99':>10}{'max':>10}")
    for k, v in res["latency"].items():
        print(f"{k:<14}{v['n']:>5}" + "".join(f"{(v[c] if v[c] is not None else float('nan')):>10.3f}" for c in
                                              ("mean", "p50", "p90", "p95", "p99", "max")))
    if res["nfr1_within_target_pct"] is not None:
        print(f"NFR1: {res['nfr1_within_target_pct']}% of matches within {a.target_s}s")
    for e in res["errors"][:10]:
        print("  !", e)
    if a.json:
        with open(a.json, "w") as f:
            json.dump(res, f, indent=2)
    return 0 if res["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
