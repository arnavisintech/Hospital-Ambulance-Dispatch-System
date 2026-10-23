"""Places (v2 section 8): Nominatim proxy (mocked) with gazetteer fallback, plus zone_label."""
import httpx
import pytest

from app import places
from app.config import get_settings
from app.services import geocode


class FakeNominatim:
    def __init__(self, mode="ok"):
        self.mode, self.calls = mode, []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        if self.mode == "down":
            raise httpx.ConnectError("no route to host", request=request)
        if self.mode == "429":
            return httpx.Response(429, text="slow down")
        if request.url.path == "/reverse":
            return httpx.Response(200, json={
                "display_name": "Apollo Hospitals, Greams Lane, Thousand Lights, Chennai, Tamil Nadu, 600006, India",
                "address": {"amenity": "Apollo Hospitals", "road": "Greams Lane", "suburb": "Thousand Lights",
                            "city": "Chennai", "postcode": "600006"}})
        if request.url.path == "/search":
            return httpx.Response(200, json=[
                {"display_name": "Anna Salai, Teynampet, Chennai, Tamil Nadu, India", "lat": "13.0405", "lon": "80.2503"},
                {"display_name": "Anna Salai, Coimbatore, Tamil Nadu, India", "lat": "11.0168", "lon": "76.9558"},
            ])
        return httpx.Response(404)


@pytest.fixture
def nominatim(monkeypatch):
    monkeypatch.setattr(get_settings(), "geo_provider", "nominatim")
    monkeypatch.setattr(get_settings(), "nominatim_url", "https://nominatim.test")
    sleeps = []
    monkeypatch.setattr(geocode.time, "sleep", lambda s: sleeps.append(s))
    fake = FakeNominatim()
    fake.sleeps = sleeps
    geocode.reset()
    geocode.set_http_client(httpx.Client(transport=httpx.MockTransport(fake),
                                         headers={"User-Agent": get_settings().geo_user_agent}))
    yield fake
    geocode.reset()


def test_reverse_via_nominatim_with_user_agent_and_cache(client, world, nominatim):
    u = world.user()
    r = client.get("/api/geo/reverse?lat=13.0630&lng=80.2512", headers=u["h"]).json()
    assert r["label"] == "Apollo Hospitals, Thousand Lights" and r["locality"] == "Thousand Lights"
    assert r["address"].startswith("Apollo Hospitals, Greams Lane")
    req = nominatim.calls[0]
    assert req.headers["User-Agent"] == "HADS/1.0 (student project)"
    assert req.url.params["format"] == "jsonv2" and req.url.params["lat"] == "13.063000"
    client.get("/api/geo/reverse?lat=13.06301&lng=80.25121", headers=u["h"])  # same ~11 m cell -> cache
    assert len(nominatim.calls) == 1


def test_search_is_bounded_to_chennai(client, world, nominatim):
    u = world.user()
    res = client.get("/api/geo/search?q=anna salai", headers=u["h"]).json()
    assert res == [{"label": "Anna Salai, Teynampet, Chennai", "lat": 13.0405, "lng": 80.2503, "source": "nominatim"}]
    p = nominatim.calls[0].url.params
    assert p["bounded"] == "1" and p["viewbox"] == "79.95,13.3,80.4,12.75" and p["countrycodes"] == "in"


def test_throttle_spaces_upstream_calls_one_second_apart(nominatim):
    geocode.reverse(13.04, 80.23)
    geocode.reverse(13.00, 80.25)  # different cell -> second upstream call, must wait ~1 s
    assert len(nominatim.calls) == 2 and nominatim.sleeps and 0 < nominatim.sleeps[-1] <= 1.0


@pytest.mark.parametrize("mode", ["down", "429"])
def test_fallback_to_gazetteer_when_upstream_fails(client, world, nominatim, mode):
    nominatim.mode = mode
    u = world.user()
    r = client.get("/api/geo/reverse?lat=13.0418&lng=80.2341", headers=u["h"]).json()
    assert r == {"label": "T. Nagar", "locality": "T. Nagar", "address": "T. Nagar, Chennai, Tamil Nadu 600017",
                 "source": "gazetteer"}
    n = len(nominatim.calls)
    s = client.get("/api/geo/search?q=adyar", headers=u["h"]).json()  # backed off: upstream not retried
    assert s[0]["label"] == "Adyar, Chennai" and len(nominatim.calls) == n


def test_offline_provider_never_calls_upstream(client, world, monkeypatch):
    monkeypatch.setattr(get_settings(), "geo_provider", "offline")
    calls = []
    geocode.set_http_client(httpx.Client(transport=httpx.MockTransport(lambda r: calls.append(r))))
    u = world.user()
    assert client.get("/api/geo/search?q=velach", headers=u["h"]).json()[0]["label"] == "Velachery, Chennai"
    assert client.get("/api/geo/reverse?lat=12.70&lng=80.10", headers=u["h"]).json()["label"].startswith("Near ")
    assert calls == []


def test_geo_requires_auth_and_validates(client, world):
    assert client.get("/api/geo/search?q=adyar").status_code == 401
    u = world.user()
    assert client.get("/api/geo/search?q=a", headers=u["h"]).status_code == 422
    assert client.get("/api/geo/reverse?lat=200&lng=80", headers=u["h"]).status_code == 422


def test_gazetteer_and_zone_label():
    assert len(places.LOCALITIES) >= 60
    assert all(places.in_bbox(lat, lng) for _n, lat, lng, _p in places.LOCALITIES)
    assert len({n for n, *_ in places.LOCALITIES}) == len(places.LOCALITIES)
    assert places.zone_label(13.0418, 80.2341) == "T. Nagar" and places.zone_label(13.0012, 80.2565) == "Adyar"
    assert places.zone_label(None, 80.0) is None
    assert [r["label"] for r in places.search("t nagar")][0] == "T. Nagar, Chennai"
    assert places.search("!!") == []
