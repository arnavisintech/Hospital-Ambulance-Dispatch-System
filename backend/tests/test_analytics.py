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
    assert set(j["zones"][0]) == {"zone_id", "lat", "lng", "expected_demand", "risk", "zone_label"}
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
