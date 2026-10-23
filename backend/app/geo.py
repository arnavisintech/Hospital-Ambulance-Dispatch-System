"""Geo helpers shared by dispatch, capacity, analytics."""
import math

from .config import get_settings

EARTH_KM = 6371.0088


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_KM * math.asin(math.sqrt(a))


def zone_of(lat: float, lng: float) -> str:
    """Grid zone id 'row_col' relative to the city centre (can be negative)."""
    s = get_settings()
    row = math.floor((lat - s.city_lat) / s.zone_cell_deg)
    col = math.floor((lng - s.city_lng) / s.zone_cell_deg)
    return f"{row}_{col}"


def zone_center(zone_id: str) -> tuple[float, float]:
    s = get_settings()
    row, col = (int(x) for x in zone_id.split("_"))
    return (s.city_lat + (row + 0.5) * s.zone_cell_deg, s.city_lng + (col + 0.5) * s.zone_cell_deg)
