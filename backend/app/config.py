from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: str = "development"  # development | production (production refuses unsafe settings)
    database_url: str = "sqlite:///./data/hads.db"  # or postgresql+psycopg2://...
    jwt_secret: str = "change-me-in-production"
    jwt_expire_minutes: int = 720
    cors_origins: str = "*"  # comma separated
    data_encryption_key: str = ""  # Fernet key(s), comma separated; first encrypts (NFR3)

    # Pilot city (Chennai) -- map centre and prediction grid
    city_lat: float = 13.0827
    city_lng: float = 80.2707
    zone_cell_deg: float = 0.02  # ~2.2 km grid cells

    # Dispatch tuning
    routing_provider: str = "haversine"  # haversine | osrm
    osrm_url: str = "http://localhost:5000"  # self-hosted Chennai extract (docker-compose: http://osrm:5000)
    osrm_timeout_s: float = 1.5  # per call; slower answers fall back to haversine (NFR1)
    osrm_breaker_failures: int = 3  # consecutive failures that open the circuit
    osrm_breaker_cooldown_s: float = 30.0  # how long OSRM is skipped once the circuit is open
    route_cache_ttl_s: float = 30.0
    avg_speed_kmph: float = 32.0  # free-flow urban speed before traffic factor
    max_search_radius_km: float = 15.0
    crew_ack_timeout_s: int = 30
    location_stale_s: int = 120
    dispatch_target_s: int = 8  # NFR1
    capacity_stale_min: int = 15  # UC-3 E1
    hospital_search_radius_km: float = 12.0

    # Places (FR1 address labels): Nominatim proxy with offline gazetteer fallback
    geo_provider: str = "nominatim"  # nominatim | offline
    nominatim_url: str = "https://nominatim.openstreetmap.org"
    geo_user_agent: str = "HADS/1.0 (student project)"
    geo_timeout_s: float = 3.0

    # Family share links
    share_ttl_after_end_h: float = 2.0

    # Demo autopilot (simulated crews for ambulances without a live device)
    demo_autopilot: bool = False
    demo_speedup: float = 4.0
    autopilot_device_grace_s: int = 60  # a crew device that pinged within this window always wins

    bootstrap_admin_email: str = ""     # first boot only: creates this admin when no users exist
    bootstrap_admin_password: str = ""
    seed_on_startup: bool = False  # demo data with known passwords: never in production
    audit_retention_years: int = 5  # NFR7 (informational; rows are never deleted)

    def production_problems(self) -> list[str]:
        """Settings that make a production boot unsafe. Empty outside production."""
        if self.app_env.lower() != "production":
            return []
        problems = []
        if self.jwt_secret in _DEFAULT_SECRETS or len(self.jwt_secret) < 32:
            problems.append("JWT_SECRET must be a random value of at least 32 characters")
        if any(o.strip() == "*" for o in self.cors_origins.split(",")):
            problems.append("CORS_ORIGINS must list explicit origins, not '*'")
        if self.seed_on_startup:
            problems.append("SEED_ON_STARTUP must be false (demo accounts use a published password)")
        if self.demo_autopilot:
            problems.append("DEMO_AUTOPILOT must be false (it drives simulated ambulances)")
        if not self.data_encryption_key.strip():
            problems.append("DATA_ENCRYPTION_KEY must be set (patient data is encrypted at rest)")
        return problems


_DEFAULT_SECRETS = {"change-me-in-production", "change-me", "dev-secret-change-me"}


@lru_cache
def get_settings() -> Settings:
    return Settings()
