"""Production config guard (Task 2): the app refuses to boot in production with unsafe settings."""
import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import Settings

GOOD_SECRET = "x" * 48


def prod(**over) -> Settings:
    base = dict(app_env="production", jwt_secret=GOOD_SECRET, cors_origins="https://hads.example",
                seed_on_startup=False, demo_autopilot=False, data_encryption_key="k" * 44)
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
