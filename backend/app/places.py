"""Offline Chennai locality gazetteer (v2 section 8).

Used for `zone_label` (nearest named locality for a point / prediction zone) and as the fallback for
/geo/reverse and /geo/search when Nominatim is unreachable. Coordinates are locality centroids
(approximate, ~0.5 km); good enough for "near T. Nagar"-style labels, not for street addressing.
"""
from __future__ import annotations

import re

from .geo import haversine_km

# Chennai metro bounding box used for search bounding (min_lng, min_lat, max_lng, max_lat)
BBOX = (79.95, 12.75, 80.40, 13.30)

# name, lat, lng, PIN (for the synthetic address line)
LOCALITIES: list[tuple[str, float, float, str]] = [
    ("Park Town", 13.0810, 80.2730, "600003"),
    ("George Town", 13.0943, 80.2878, "600001"),
    ("Egmore", 13.0732, 80.2609, "600008"),
    ("Chepauk", 13.0630, 80.2800, "600005"),
    ("Triplicane", 13.0588, 80.2756, "600005"),
    ("Royapettah", 13.0540, 80.2640, "600014"),
    ("Thousand Lights", 13.0590, 80.2530, "600006"),
    ("Gopalapuram", 13.0500, 80.2560, "600086"),
    ("Mylapore", 13.0339, 80.2676, "600004"),
    ("Santhome", 13.0330, 80.2780, "600004"),
    ("Mandaveli", 13.0270, 80.2620, "600028"),
    ("Alwarpet", 13.0339, 80.2550, "600018"),
    ("Teynampet", 13.0405, 80.2503, "600018"),
    ("Nandanam", 13.0300, 80.2400, "600035"),
    ("Nungambakkam", 13.0569, 80.2425, "600034"),
    ("T. Nagar", 13.0418, 80.2341, "600017"),
    ("West Mambalam", 13.0390, 80.2220, "600033"),
    ("Kodambakkam", 13.0521, 80.2255, "600024"),
    ("Vadapalani", 13.0500, 80.2121, "600026"),
    ("Ashok Nagar", 13.0373, 80.2123, "600083"),
    ("K. K. Nagar", 13.0410, 80.1990, "600078"),
    ("Saligramam", 13.0550, 80.2000, "600093"),
    ("Virugambakkam", 13.0530, 80.1910, "600092"),
    ("Valasaravakkam", 13.0400, 80.1720, "600087"),
    ("Ramapuram", 13.0320, 80.1820, "600089"),
    ("Manapakkam", 13.0187, 80.1800, "600125"),
    ("Porur", 13.0382, 80.1565, "600116"),
    ("Saidapet", 13.0213, 80.2231, "600015"),
    ("Guindy", 13.0067, 80.2206, "600032"),
    ("Ekkatuthangal", 13.0170, 80.2050, "600032"),
    ("Kotturpuram", 13.0170, 80.2410, "600085"),
    ("Adyar", 13.0012, 80.2565, "600020"),
    ("Besant Nagar", 13.0003, 80.2668, "600090"),
    ("Thiruvanmiyur", 12.9830, 80.2594, "600041"),
    ("Taramani", 12.9863, 80.2432, "600113"),
    ("Velachery", 12.9815, 80.2180, "600042"),
    ("Alandur", 13.0020, 80.2010, "600016"),
    ("St. Thomas Mount", 13.0033, 80.1940, "600016"),
    ("Nanganallur", 12.9810, 80.1880, "600061"),
    ("Madipakkam", 12.9647, 80.1961, "600091"),
    ("Keelkattalai", 12.9550, 80.1850, "600117"),
    ("Pallavaram", 12.9675, 80.1491, "600043"),
    ("Chromepet", 12.9516, 80.1462, "600044"),
    ("Tambaram", 12.9249, 80.1000, "600045"),
    ("Selaiyur", 12.9050, 80.1430, "600073"),
    ("Medavakkam", 12.9200, 80.1920, "600100"),
    ("Pallikaranai", 12.9349, 80.2137, "600100"),
    ("Perungudi", 12.9654, 80.2461, "600096"),
    ("Thoraipakkam", 12.9416, 80.2362, "600097"),
    ("Neelankarai", 12.9490, 80.2590, "600041"),
    ("Injambakkam", 12.9200, 80.2500, "600115"),
    ("Sholinganallur", 12.9010, 80.2279, "600119"),
    ("Perumbakkam", 12.8996, 80.2047, "600100"),
    ("Semmancheri", 12.8700, 80.2250, "600119"),
    ("Navalur", 12.8459, 80.2265, "600130"),
    ("Siruseri", 12.8250, 80.2180, "603103"),
    ("Kelambakkam", 12.7870, 80.2190, "603103"),
    ("Kilpauk", 13.0825, 80.2420, "600010"),
    ("Chetpet", 13.0715, 80.2420, "600031"),
    ("Purasawalkam", 13.0880, 80.2550, "600007"),
    ("Aminjikarai", 13.0710, 80.2240, "600029"),
    ("Shenoy Nagar", 13.0790, 80.2280, "600030"),
    ("Choolaimedu", 13.0630, 80.2270, "600094"),
    ("Arumbakkam", 13.0735, 80.2100, "600106"),
    ("Anna Nagar", 13.0850, 80.2101, "600040"),
    ("Koyambedu", 13.0694, 80.1948, "600107"),
    ("Maduravoyal", 13.0650, 80.1610, "600095"),
    ("Mogappair", 13.0837, 80.1750, "600037"),
    ("Padi", 13.0980, 80.1860, "600050"),
    ("Villivakkam", 13.1050, 80.2050, "600049"),
    ("Kolathur", 13.1240, 80.2120, "600099"),
    ("Perambur", 13.1187, 80.2335, "600011"),
    ("Vyasarpadi", 13.1170, 80.2520, "600039"),
    ("Washermanpet", 13.1140, 80.2870, "600021"),
    ("Royapuram", 13.1137, 80.2954, "600013"),
    ("Tondiarpet", 13.1268, 80.2880, "600081"),
    ("Kodungaiyur", 13.1370, 80.2480, "600118"),
    ("Madhavaram", 13.1488, 80.2306, "600060"),
    ("Thiruvottiyur", 13.1600, 80.3000, "600019"),
    ("Manali", 13.1667, 80.2667, "600068"),
    ("Ennore", 13.2146, 80.3203, "600057"),
    ("Puzhal", 13.1590, 80.2030, "600066"),
    ("Red Hills", 13.1860, 80.1990, "600052"),
    ("Ambattur", 13.1143, 80.1548, "600053"),
    ("Avadi", 13.1067, 80.0970, "600054"),
    ("Poonamallee", 13.0473, 80.0945, "600056"),
    ("Vanagaram", 13.0640, 80.1530, "600095"),
]


def in_bbox(lat: float, lng: float) -> bool:
    return BBOX[1] <= lat <= BBOX[3] and BBOX[0] <= lng <= BBOX[2]


def nearest(lat: float, lng: float) -> tuple[str, float, float, str, float]:
    """(name, lat, lng, pin, distance_km) of the closest gazetteer locality."""
    best = min(LOCALITIES, key=lambda p: haversine_km(lat, lng, p[1], p[2]))
    return (*best, haversine_km(lat, lng, best[1], best[2]))


def zone_label(lat: float | None, lng: float | None) -> str | None:
    """Nearest named locality, e.g. 'T. Nagar'. None for missing coordinates."""
    if lat is None or lng is None:
        return None
    return nearest(lat, lng)[0]


def reverse(lat: float, lng: float) -> dict:
    name, _la, _ln, pin, km = nearest(lat, lng)
    label = name if km <= 2.5 else f"Near {name}"
    return {"label": label, "locality": name, "address": f"{label}, Chennai, Tamil Nadu {pin}", "source": "gazetteer"}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def search(q: str, limit: int = 8) -> list[dict]:
    """Case/punctuation-insensitive match on locality names: prefix matches first, then substrings."""
    nq = _norm(q)
    if not nq:
        return []
    scored = []
    for name, lat, lng, _pin in LOCALITIES:
        n = _norm(name)
        if n.startswith(nq):
            scored.append((0, name, lat, lng))
        elif nq in n or n in nq:
            scored.append((1, name, lat, lng))
    scored.sort(key=lambda r: (r[0], r[1]))
    return [{"label": f"{name}, Chennai", "lat": lat, "lng": lng, "source": "gazetteer"}
            for _rank, name, lat, lng in scored[:limit]]
