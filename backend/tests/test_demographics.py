"""Zone demographics: households and age groups per grid zone (Task 11)."""
import statistics

from sqlalchemy import func, select

from app import demographics as demo
from app.db import SessionLocal
from app.geo import CHENNAI_BBOX, in_city, zone_of
from app.models import Role, ZoneDemographics

HEADER = "lat,lng,households,pop_0_14,pop_15_59,pop_60_74,pop_75_plus\n"


def test_generator_is_deterministic_and_plausible():
    a, b = demo.generate_chennai_demographics(seed=11), demo.generate_chennai_demographics(seed=11)
    assert a == b and len(a) >= 150
    assert all(r["source"] == "synthetic" for r in a)
    pop = sum(r["pop_0_14"] + r["pop_15_59"] + r["pop_60_74"] + r["pop_75_plus"] for r in a)
    seniors = sum(r["pop_60_74"] + r["pop_75_plus"] for r in a)
    hh = sum(r["households"] for r in a)
    assert 0.09 <= seniors / pop <= 0.15
    assert 3.2 <= pop / hh <= 4.4
    shares = [(r["pop_60_74"] + r["pop_75_plus"]) / max(1, r["pop_0_14"] + r["pop_15_59"] + r["pop_60_74"] + r["pop_75_plus"])
              for r in a]
    assert statistics.pstdev(shares) >= 0.015


def test_generator_differs_by_seed():
    assert demo.generate_chennai_demographics(seed=1) != demo.generate_chennai_demographics(seed=2)


def test_bbox_helper():
    assert in_city(13.0827, 80.2707) and not in_city(28.6, 77.2)
    assert CHENNAI_BBOX[0] < CHENNAI_BBOX[2] and CHENNAI_BBOX[1] < CHENNAI_BBOX[3]


def test_parse_csv_sums_rows_in_same_zone():
    text = HEADER + "13.0418,80.2341,100,40,250,60,20\n13.0420,80.2343,50,10,100,30,10\n13.0850,80.2101,70,20,150,40,5\n"
    rows, errors = demo.parse_demographics_csv(text)
    assert errors == []
    by = {r["zone_id"]: r for r in rows}
    z = zone_of(13.0418, 80.2341)
    assert by[z]["households"] == 150 and by[z]["pop_60_74"] == 90 and len(by) == 2


def test_parse_csv_reports_every_bad_row():
    text = HEADER + "13.04,80.23,-5,1,1,1,1\n13.04,80.23,10,x,1,1,1\n28.6,77.2,10,1,1,1,1\n13.04,80.23,10,1,1,1\n"
    rows, errors = demo.parse_demographics_csv(text)
    assert rows == [] or errors
    assert [e.split(":")[0] for e in errors] == ["row 2", "row 3", "row 4", "row 5"]


def test_parse_csv_missing_column_and_empty():
    assert demo.parse_demographics_csv("lat,lng,households\n13.0,80.2,5\n")[1]
    assert demo.parse_demographics_csv("")[1]
    assert demo.parse_demographics_csv(HEADER)[1]  # header only: nothing to import


def _upload(client, h, text):
    return client.post("/api/admin/demographics/import", files={"file": ("d.csv", text.encode(), "text/csv")}, headers=h)


def test_import_endpoint_replaces_atomically(client, world):
    admin = world.user(Role.admin)
    with SessionLocal() as db:
        demo.replace_demographics(db, demo.generate_chennai_demographics(seed=11), "synthetic")
        db.commit()
        before = db.scalar(select(func.count(ZoneDemographics.zone_id)))
    bad = _upload(client, admin["h"], HEADER + "13.04,80.23,10,1,1,1,1\n13.04,80.23,-1,1,1,1,1\n")
    assert bad.status_code == 422 and bad.json()["detail"]["errors"] == ["row 3: households must be a whole number >= 0"]
    with SessionLocal() as db:
        assert db.scalar(select(func.count(ZoneDemographics.zone_id))) == before
    ok = _upload(client, admin["h"], HEADER + "13.0418,80.2341,100,40,250,60,20\n")
    assert ok.status_code == 200
    assert ok.json() == {"zones": 1, "households": 100, "population": 370, "seniors": 80, "source": "import"}
    s = client.get("/api/admin/demographics/summary", headers=admin["h"]).json()
    assert s == ok.json()


def test_import_is_admin_only(client, world):
    ctl = world.user(Role.controller)
    assert _upload(client, ctl["h"], HEADER + "13.04,80.23,1,1,1,1,1\n").status_code == 403
    assert client.get("/api/admin/demographics/summary", headers=ctl["h"]).status_code == 403


def test_load_dicts(world):
    with SessionLocal() as db:
        demo.replace_demographics(db, [{"zone_id": "0_0", "households": 10, "pop_0_14": 1, "pop_15_59": 2,
                                        "pop_60_74": 3, "pop_75_plus": 4}], "import")
        db.commit()
        d = demo.load_dicts(db)
    assert d == {"0_0": {"households": 10, "pop_0_14": 1, "pop_15_59": 2, "pop_60_74": 3, "pop_75_plus": 4}}


def test_seed_loads_synthetic_demographics():
    from ops_helpers import Env
    env = Env()
    with env.db() as db:
        s = demo.summary(db)
    assert s["zones"] >= 150 and s["source"] == "synthetic"


def test_service_area_is_configurable(monkeypatch):
    """STRQ5: another city is a configuration change, not a code change (Chennai stays the default)."""
    from app.config import Settings, get_settings
    from app.geo import service_area
    assert Settings(_env_file=None).service_area == "12.80,79.98,13.25,80.35"
    monkeypatch.setattr(get_settings(), "service_area", "12.85,77.45,13.15,77.80")   # Bengaluru
    assert service_area() == (12.85, 77.45, 13.15, 77.80)
    assert in_city(12.97, 77.59) and not in_city(13.0827, 80.2707)


def test_malformed_service_area_is_rejected():
    import pytest
    from pydantic import ValidationError

    from app.config import Settings
    for bad in ("12.8,79.9,13.2", "13.25,79.98,12.80,80.35", "a,b,c,d"):
        with pytest.raises(ValidationError):
            Settings(_env_file=None, service_area=bad)
