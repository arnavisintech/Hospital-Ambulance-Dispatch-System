"""Production config guard (Task 2): the app refuses to boot in production with unsafe settings."""
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app import main
from app.config import Settings

GOOD_SECRET = "x" * 48

_KEY = Fernet.generate_key().decode()


def prod(**over) -> Settings:
    base = dict(app_env="production", jwt_secret=GOOD_SECRET, cors_origins="https://hads.example",
                seed_on_startup=False, demo_autopilot=False, data_encryption_key=_KEY)
    base.update(over)
    return Settings(_env_file=None, **base)


def test_safe_production_config_has_no_problems():
    assert prod().production_problems() == []


def test_development_defaults_have_no_problems():
    assert Settings(_env_file=None, app_env="development").production_problems() == []


def test_seed_is_off_by_default(monkeypatch):
    monkeypatch.delenv("SEED_ON_STARTUP", raising=False)
    assert Settings(_env_file=None).seed_on_startup is False


@pytest.mark.parametrize("secret", ["change-me-in-production", "change-me", "dev-secret-change-me", "short-secret"])
def test_default_or_short_jwt_secret_rejected(secret):
    assert any("JWT_SECRET" in p for p in prod(jwt_secret=secret).production_problems())


def test_wildcard_cors_rejected():
    assert any("CORS_ORIGINS" in p for p in prod(cors_origins="*").production_problems())


def test_seed_and_autopilot_rejected():
    problems = prod(seed_on_startup=True, demo_autopilot=True).production_problems()
    assert any("SEED_ON_STARTUP" in p for p in problems)
    assert any("DEMO_AUTOPILOT" in p for p in problems)


def test_missing_encryption_key_rejected():
    assert any("DATA_ENCRYPTION_KEY" in p for p in prod(data_encryption_key="").production_problems())


def test_lifespan_refuses_unsafe_production(monkeypatch):
    bad = prod(jwt_secret="change-me", cors_origins="*")
    monkeypatch.setattr(main, "get_settings", lambda: bad)
    with pytest.raises(RuntimeError) as e:
        with TestClient(main.app):
            pass
    assert "JWT_SECRET" in str(e.value) and "CORS_ORIGINS" in str(e.value)


def test_geocoder_defaults_to_offline_gazetteer(monkeypatch):
    monkeypatch.delenv("GEO_PROVIDER", raising=False)
    from app.config import Settings
    assert Settings(_env_file=None).geo_provider == "offline"


@pytest.mark.parametrize("rel", ["docker-compose.yml", "docker-compose.demo.yml", "backend/.env.example"])
def test_no_public_nominatim_in_shipped_config(rel):
    import pathlib
    text = (pathlib.Path(__file__).resolve().parents[2] / rel).read_text(encoding="utf-8").lower()
    assert "nominatim" not in text


def test_spoofed_forwarded_for_cannot_fake_the_client_ip():
    """Rate limits and lockout key on the client IP: a client-supplied X-Forwarded-For entry must be ignored."""
    import pathlib
    import re

    from uvicorn.middleware.proxy_headers import _TrustedHosts
    root = pathlib.Path(__file__).resolve().parents[2]
    entry = (root / "backend/scripts/entrypoint.sh").read_text(encoding="utf-8")
    default = re.search(r'FORWARDED_ALLOW_IPS:-([^}"]+)\}', entry).group(1)
    assert default.strip() != "*"
    trusted = _TrustedHosts(default)
    # attacker sends "X-Forwarded-For: 6.6.6.6"; a proxy that appended would yield "6.6.6.6, <real>"
    assert trusted.get_trusted_client_host("6.6.6.6, 203.0.113.9") == "203.0.113.9"
    conf = (root / "frontend/nginx/api-proxy.conf").read_text(encoding="utf-8")
    assert "proxy_add_x_forwarded_for" not in conf and "X-Forwarded-For $remote_addr" in conf


def test_nginx_never_caps_websockets_or_emergency_intake_per_ip():
    """Final review: carrier-grade NAT and call-centre NAT put many users behind one IP. Long-lived tracking sockets
    must not count against a per-IP cap, and SOS / IVR / guest intake must never be capped per IP."""
    import pathlib
    import re
    root = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "nginx"
    conf = (root / "app.conf").read_text(encoding="utf-8")
    blocks = dict(re.findall(r"location\s+(?:(?:\^~|=)\s+)?(\S+)\s*\{(.*?)\n\}", conf, re.S))
    for loc in ("/api/ws", "/api/requests", "/api/auth/guest"):
        assert loc in blocks, f"{loc} needs its own location"
        assert "limit_conn" not in blocks[loc], loc
        assert "api-proxy.conf" in blocks[loc], loc
    m = re.search(r"limit_conn\s+hads_api_conn\s+(\d+)", blocks["/api/"])
    assert m and int(m.group(1)) >= 200


@pytest.mark.parametrize("bad", ["k" * 44, "not-a-key", f"{_KEY},garbage"])
def test_malformed_encryption_key_rejected(bad):
    """Final review: a non-empty but invalid Fernet key booted 'ready' and then failed every SOS insert with a 500."""
    assert any("DATA_ENCRYPTION_KEY" in p for p in prod(data_encryption_key=bad).production_problems())


def test_rotated_key_pair_is_accepted():
    other = Fernet.generate_key().decode()
    assert not prod(data_encryption_key=f"{_KEY},{other}").production_problems()


def test_container_healthcheck_and_hsts_hold_in_tls_mode():
    """Final review minors: in TLS mode port 80 redirects everything, so a healthcheck on '/' follows a 301 to a
    certificate busybox wget may refuse; and locations with their own add_header dropped the server-level HSTS."""
    import pathlib
    import re
    fe = pathlib.Path(__file__).resolve().parents[2] / "frontend"
    docker = (fe / "Dockerfile").read_text(encoding="utf-8")
    template = (fe / "templates/default.conf.template").read_text(encoding="utf-8")
    assert re.search(r"HEALTHCHECK .*http://127\.0\.0\.1/healthz", docker)
    port80 = template[template.index("listen 80"):]
    assert port80.index("location = /healthz") < port80.index("http-mode.conf")   # answered before any redirect
    headers = (fe / "nginx/security-headers.conf").read_text(encoding="utf-8")
    assert "include /etc/nginx/hads/hsts.conf;" in headers
    tls = (fe / "docker-entrypoint.d/40-hads-tls.sh").read_text(encoding="utf-8")
    assert tls.count("/etc/nginx/hads/hsts.conf") == 2   # written in both modes (empty without a certificate)
    assert "Strict-Transport-Security" in tls
