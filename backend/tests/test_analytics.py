import time
from datetime import datetime, timezone

import pytest
from sqlalchemy import func, select

from ops_helpers import Env
from app.geo import zone_of
from app.models import EmergencyRequest, IncidentHistory, IncidentType, ModelMetric, RequestStatus, TripRecord, ZoneRisk
from app.services import analytics, analytics_jobs
from app.synthetic import generate_history


@pytest.fixture(scope="module")
def env():
    return Env()


def test_synthetic_deterministic_and_plausible():
    end = datetime(2026, 1, 5, tzinfo=timezone.utc)
    a, b = generate_history(30, end=end, seed=1), generate_history(30, end=end, seed=1)
    assert a.equals(b)
    assert len(a) > 3000 and set(a.severity) <= {1, 2, 3, 4, 5}
    hod = ((a.ts + __import__("pandas").Timedelta(hours=5, minutes=30)).dt.hour)
    assert hod.isin([8, 9, 10, 17, 18, 19]).mean() > hod.isin([1, 2, 3, 4, 5, 6]).mean()  # rush > night
    assert a.zone_id.nunique() > 40


def test_seed_trains_model_with_metrics(env):
    with env.db() as db:
        info = analytics.model_info(db)
        assert info["model_version"] and info["mae"] is not None
        assert info["r2"] > 0.05 and info["mae"] < 0.5
        assert db.scalar(select(func.count(IncidentHistory.id))) > 20000


def test_get_zone_risk_normalised_cached_and_fast(env):
    with env.db() as db:
        r = analytics.get_zone_risk(db, 18)
        assert r and all(0 <= v <= 1 for v in r.values()) and max(r.values()) > 0.2
        t = time.perf_counter()
        for _ in range(1000):
            analytics.get_zone_risk(db, 18)
        assert time.perf_counter() - t < 0.2     # served from memory
        assert analytics.get_zone_risk(db, None) is not None


def test_risk_higher_in_rush_than_night(env):
    with env.db() as db:
        assert sum(analytics.get_zone_demand(db, 18).values()) > sum(analytics.get_zone_demand(db, 3).values())


def test_risk_map_endpoint_and_roles(env):
    c = env.client
    r = c.get("/api/analytics/risk-map?hour=9", headers=env.as_("controller@hads.in"))
    assert r.status_code == 200
    j = r.json()
    assert j["hour"] == 9 and j["model_version"] and j["zones"]
    assert set(j["zones"][0]) == {"zone_id", "lat", "lng", "expected_demand", "risk", "zone_label",
                                  "households", "seniors", "senior_share"}
    assert j["demographics_source"] == "synthetic"
    known = [z for z in j["zones"] if z["households"]]
    assert known and all(0 < z["senior_share"] < 0.5 for z in known)
    assert c.get("/api/analytics/risk-map", headers=env.as_("authority@hads.in")).status_code == 200
    assert c.get("/api/analytics/risk-map", headers=env.as_("user@hads.in")).status_code == 403
    assert c.get("/api/analytics/risk-map").status_code == 401
    assert c.get("/api/analytics/risk-map?hour=30", headers=env.as_("admin@hads.in")).status_code == 422


def test_retrain_admin_only_and_folds_live(env):
    c = env.client
    assert c.post("/api/analytics/retrain", headers=env.as_("controller@hads.in")).status_code == 403
    with env.db() as db:
        before = analytics.model_info(db)["n_live"]
        req = EmergencyRequest(lat=13.04, lng=80.23, incident_type=IncidentType.cardiac, severity=4,
                               status=RequestStatus.completed)
        db.add(req); db.flush()
        trip = TripRecord(request_id=req.id, response_time_seconds=300)
        db.add(trip); db.flush()
        analytics.record_outcome(db, req, trip)
        analytics.record_outcome(db, req, trip)   # idempotent
        db.commit()
        live = db.scalar(select(func.count(IncidentHistory.id)).where(IncidentHistory.source == "live"))
        assert live == before + 1
    r = c.post("/api/analytics/retrain", headers=env.as_("admin@hads.in"))
    assert r.status_code == 200
    assert r.json()["n_live"] == before + 1 and r.json()["train_seconds"] < 30
    m = c.get("/api/analytics/model", headers=env.as_("admin@hads.in")).json()
    assert len(m["history"]) >= 2 and m["model_version"] == r.json()["model_version"]
    with env.db() as db:  # only the latest generation of ZoneRisk is kept
        assert db.scalar(select(func.count(func.distinct(ZoneRisk.generated_at)))) == 1


def test_periodic_job_skips_without_new_live_and_never_raises(env, monkeypatch):
    from app import db as dbmod
    monkeypatch.setattr(dbmod, "SessionLocal", env.Session)
    assert analytics_jobs.run_once() is None            # nothing new
    assert analytics_jobs.run_once(force=True)["model_version"]


def test_empty_db_returns_empty_risk():
    e = Env(seed=False)
    with e.db() as db:
        assert analytics.get_zone_risk(db, 5) == {}
        assert analytics.model_info(db)["model_version"] is None
    r = e.client.get("/api/analytics/risk-map", headers={"Authorization": "Bearer x"})
    assert r.status_code == 401


# ---------------------------------------------------------------- Task 12: demographic-driven history
from app import demographics as demo_mod  # noqa: E402
from app.synthetic import AGE_GROUPS  # noqa: E402

_END = datetime(2026, 3, 2, tzinfo=timezone.utc)


def _demo():
    return {r["zone_id"]: {k: r[k] for k in ("households", "pop_0_14", "pop_15_59", "pop_60_74", "pop_75_plus")}
            for r in demo_mod.generate_chennai_demographics(seed=11)}


def test_history_without_demographics_has_unknown_age():
    df = generate_history(7, end=_END, seed=3)
    assert set(df.patient_age_group) == {"unknown"}


def test_demographic_history_deterministic_and_age_tagged():
    d = _demo()
    a = generate_history(14, end=_END, seed=5, demographics=d)
    b = generate_history(14, end=_END, seed=5, demographics=d)
    assert a.equals(b)
    assert set(a.patient_age_group) <= set(AGE_GROUPS) and a.patient_age_group.nunique() == 4
    base = len(generate_history(14, end=_END, seed=5))
    assert abs(len(a) - base) / base < 0.10  # same expected volume, split between traffic and residences


def test_volume_tracks_households():
    import pandas as pd
    d = _demo()
    df = generate_history(30, end=_END, seed=5, demographics=d)
    res = df[df.zone_id.isin(d.keys())].groupby("zone_id").size()
    hh = pd.Series({z: v["households"] for z, v in d.items()})
    joined = pd.concat([res.rename("n"), hh.rename("hh")], axis=1).fillna(0)
    assert joined["n"].rank().corr(joined["hh"].rank()) >= 0.5


def test_older_zones_have_older_patients():
    import pandas as pd
    d = _demo()
    df = generate_history(30, end=_END, seed=5, demographics=d)
    share = pd.Series({z: (v["pop_60_74"] + v["pop_75_plus"]) / max(1, sum(v[k] for k in v if k != "households"))
                       for z, v in d.items()})
    top, bottom = share[share >= share.quantile(0.75)].index, share[share <= share.quantile(0.25)].index
    older = df.patient_age_group.isin(["senior", "elderly"])
    assert older[df.zone_id.isin(top)].mean() >= 1.5 * older[df.zone_id.isin(bottom)].mean()


def test_elderly_have_more_cardiac_stroke_respiratory():
    df = generate_history(30, end=_END, seed=5, demographics=_demo())
    med = df.incident_type.isin(["cardiac", "stroke", "respiratory"])
    assert med[df.patient_age_group == "elderly"].mean() > med[df.patient_age_group == "adult"].mean() + 0.15


# ---------------------------------------------------------------- Task 14: demographic features in the model
import math  # noqa: E402

from app.models import ZoneDemographics  # noqa: E402


def test_model_reports_senior_demand_ratio(env):
    with env.db() as db:
        info = analytics.model_info(db)
    assert info["senior_demand_ratio"] is not None and info["senior_demand_ratio"] >= 1.3
    assert info["r2"] > 0.05 and info["mae"] < 0.5


def test_predictions_are_finite(env):
    with env.db() as db:
        vals = db.execute(select(ZoneRisk.expected_demand)).scalars().all()
    assert vals and all(math.isfinite(v) and v >= 0 for v in vals)


def test_cold_start_zone_gets_demand_from_demographics():
    from ops_helpers import Env
    e = Env()
    small, big = "-30_-30", "-31_-31"   # far outside the city: no incident history at all
    with e.db() as db:
        for z, hh in ((small, 2000), (big, 20000)):
            db.add(ZoneDemographics(zone_id=z, households=hh, pop_0_14=int(hh * 0.8), pop_15_59=int(hh * 2.6),
                                    pop_60_74=int(hh * 0.35), pop_75_plus=int(hh * 0.12), source="import"))
        db.commit()
        analytics.train_model(db)
        demand = {z: sum(r.expected_demand for r in db.execute(select(ZoneRisk).where(ZoneRisk.zone_id == z)).scalars())
                  for z in (small, big)}
    assert demand[small] > 0 and demand[big] > 2 * demand[small]
