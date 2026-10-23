import pytest
from sqlalchemy import select

from ops_helpers import Env
from app import events
from app.models import Ambulance, AmbulanceStatus, DarkStation, RebalanceRecommendation


@pytest.fixture()
def env():
    return Env()


def test_generate_list_and_publish(env, monkeypatch):
    published = []
    monkeypatch.setattr("app.services.rebalance.publish", lambda t, ty, d: published.append((t, ty, d)))
    c, h = env.client, env.as_("controller@hads.in")
    r = c.post("/api/rebalance/generate", headers=h)
    assert r.status_code == 200
    recs = r.json()
    assert recs, "seeded fleet should yield at least one recommendation"
    assert published and published[0][:2] == ("controller", "rebalance.new")
    for x in recs:
        assert x["from_station_id"] != x["to_station_id"] and x["expected_gain_seconds"] >= 1 and x["status"] == "pending"
    pending = c.get("/api/rebalance/recommendations?status=pending", headers=h).json()
    assert {x["id"] for x in pending} == {x["id"] for x in recs}
    # regenerating supersedes the previous pending set
    c.post("/api/rebalance/generate", headers=h)
    still = {x["id"] for x in c.get("/api/rebalance/recommendations", headers=h).json()}
    assert not still & {x["id"] for x in recs}
    assert c.get("/api/rebalance/recommendations?status=dismissed", headers=h).json()


def test_moves_only_from_overcovered_stations(env):
    from app.services import rebalance
    with env.db() as db:
        counts = {}
        for a in db.execute(select(Ambulance)).scalars():
            counts[a.station_id] = counts.get(a.station_id, 0) + 1
        for m in rebalance.compute_moves(db):
            assert counts[m["from_station_id"]] > 1


def test_accept_moves_idle_ambulance_and_audits(env):
    c, h = env.client, env.as_("controller@hads.in")
    rec = c.post("/api/rebalance/generate", headers=h).json()[0]
    r = c.post(f"/api/rebalance/{rec['id']}/accept", headers=h)
    assert r.status_code == 200 and r.json()["status"] == "accepted"
    with env.db() as db:
        assert db.get(Ambulance, rec["ambulance_id"]).station_id == rec["to_station_id"]
    assert c.post(f"/api/rebalance/{rec['id']}/accept", headers=h).status_code == 409
    assert c.post(f"/api/rebalance/{rec['id']}/dismiss", headers=h).status_code == 409
    acts = [i["action"] for i in c.get("/api/audit?action=rebalance.&limit=50", headers=env.as_("admin@hads.in")).json()["items"]]
    assert "rebalance.accept" in acts and "rebalance.generate" in acts


def test_accept_rejected_when_ambulance_busy_or_moved(env):
    c, h = env.client, env.as_("admin@hads.in")
    recs = c.post("/api/rebalance/generate", headers=h).json()
    rec = recs[0]
    with env.db() as db:
        db.get(Ambulance, rec["ambulance_id"]).status = AmbulanceStatus.en_route
        db.commit()
    r = c.post(f"/api/rebalance/{rec['id']}/accept", headers=h)
    assert r.status_code == 409 and "idle" in r.json()["detail"]
    with env.db() as db:
        assert db.get(Ambulance, rec["ambulance_id"]).station_id == rec["from_station_id"]
        db.get(Ambulance, rec["ambulance_id"]).status = AmbulanceStatus.available
        db.get(Ambulance, rec["ambulance_id"]).station_id = rec["to_station_id"]
        db.commit()
    assert c.post(f"/api/rebalance/{rec['id']}/accept", headers=h).status_code == 409


def test_dismiss_and_roles_and_404(env):
    c = env.client
    h = env.as_("controller@hads.in")
    rec = c.post("/api/rebalance/generate", headers=h).json()[0]
    assert c.post(f"/api/rebalance/{rec['id']}/dismiss", headers=h).json()["status"] == "dismissed"
    with env.db() as db:
        assert db.get(Ambulance, rec["ambulance_id"]).station_id == rec["from_station_id"]
    assert c.post("/api/rebalance/99999/accept", headers=h).status_code == 404
    for who in ("user@hads.in", "crew1@hads.in", "authority@hads.in", "staff1@hads.in"):
        assert c.get("/api/rebalance/recommendations", headers=env.as_(who)).status_code == 403
        assert c.post("/api/rebalance/generate", headers=env.as_(who)).status_code == 403


def test_no_recommendations_without_model():
    e = Env(seed=False)
    from app.models import Role, User
    from app.security import hash_password
    with e.db() as db:
        db.add(User(name="A", email="a@x.in", password_hash=hash_password("Hads@1234"), role=Role.admin))
        db.commit()
    assert e.client.post("/api/rebalance/generate", headers=e.as_("a@x.in")).json() == []
