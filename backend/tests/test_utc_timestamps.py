"""Browser walk-through finding: SQLite drops the timezone, so the API sent naive timestamps ("2026-10-25T09:04:04")
that a browser in India reads as IST, 5.5 h off -- fresh hospital capacity showed as "updated 6 h ago"."""
from datetime import timezone

from app.db import SessionLocal
from app.models import Hospital, Role


def test_timestamps_read_back_from_the_database_are_utc_aware(client, world):
    hid = world.hospital()
    with SessionLocal() as db:
        h = db.get(Hospital, hid)
        assert h.capacity_updated_at is not None
        assert h.capacity_updated_at.tzinfo is not None
        assert h.capacity_updated_at.utcoffset() == timezone.utc.utcoffset(None)


def test_api_timestamps_carry_an_offset(client, world):
    admin = world.user(Role.admin)
    hid = world.hospital()
    body = client.get(f"/api/hospitals/{hid}", headers=admin["h"]).json()
    ts = body["capacity_updated_at"]
    assert ts.endswith("Z") or ts.endswith("+00:00"), ts
