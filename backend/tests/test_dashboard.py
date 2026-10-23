import pytest

from ops_helpers import Env

KPI_KEYS = {"avg_response_s", "p90_response_s", "avg_match_ms", "requests_total", "completed", "completion_rate",
            "avg_handover_s", "fleet_utilisation_pct", "redirect_avoided"}


@pytest.fixture(scope="module")
def env():
    return Env()


def test_summary_shape_and_values(env):
    r = env.client.get("/api/dashboard/summary?days=30", headers=env.as_("authority@hads.in"))
    assert r.status_code == 200
    j = r.json()
    assert KPI_KEYS <= set(j["kpis"])
    assert {"response_by_day", "by_incident", "stations", "hospitals", "prediction", "coverage_gaps", "sla"} <= set(j)
    k = j["kpis"]
    assert k["requests_total"] > 50 and 0 < k["completion_rate"] <= 1 and k["completed"] > 50
    assert 0 < k["avg_response_s"] < 3600 and k["p90_response_s"] >= k["avg_response_s"]
    assert k["avg_handover_s"] > 0 and 0 <= k["fleet_utilisation_pct"] <= 100
    assert len(j["stations"]) == 12 and len(j["hospitals"]) == 8
    assert sum(x["count"] for x in j["by_incident"]) == k["requests_total"]
    assert sum(x["count"] for x in j["response_by_day"]) == k["completed"]
    assert j["prediction"]["model_version"] and j["prediction"]["mae"] is not None
    assert j["sla"]["nfr1_target_s"] == 8 and 0 <= j["sla"]["within_target_pct"] <= 100
    assert j["coverage_gaps"] and {"zone_id", "lat", "lng", "risk", "nearest_ambulance_km"} <= set(j["coverage_gaps"][0])
    assert {"id", "name", "utilisation_pct", "ambulances", "available", "trips"} <= set(j["stations"][0])


def test_window_filters(env):
    c, h = env.client, env.as_("admin@hads.in")
    small = c.get("/api/dashboard/summary?days=1", headers=h).json()["kpis"]["requests_total"]
    big = c.get("/api/dashboard/summary?days=30", headers=h).json()["kpis"]["requests_total"]
    assert small < big
    assert c.get("/api/dashboard/summary?days=0", headers=h).status_code == 422


def test_roles(env):
    c = env.client
    assert c.get("/api/dashboard/summary", headers=env.as_("controller@hads.in")).status_code == 200
    for who in ("user@hads.in", "crew1@hads.in", "staff1@hads.in"):
        assert c.get("/api/dashboard/summary", headers=env.as_(who)).status_code == 403
    assert c.get("/api/dashboard/summary").status_code == 401


def test_empty_database_is_handled():
    e = Env(seed=False)
    from app.models import Role, User
    from app.security import hash_password
    with e.db() as db:
        db.add(User(name="A", email="a@x.in", password_hash=hash_password("Hads@1234"), role=Role.admin))
        db.commit()
    r = e.client.get("/api/dashboard/summary", headers=e.as_("a@x.in"))
    assert r.status_code == 200
    j = r.json()
    assert j["kpis"]["requests_total"] == 0 and j["kpis"]["completion_rate"] == 0
    assert j["kpis"]["avg_response_s"] is None and j["stations"] == [] and j["coverage_gaps"] == []
    assert j["prediction"]["mae"] is None and j["sla"]["within_target_pct"] is None
