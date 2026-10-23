"""Places (v2 section 8): reverse geocoding and locality search, Chennai-bounded."""
from fastapi import APIRouter, Depends, Query

from ..deps import current_user
from ..models import User
from ..services import geocode

router = APIRouter(prefix="/api/geo", tags=["geo"])


@router.get("/reverse")
def reverse(lat: float = Query(ge=-90, le=90), lng: float = Query(ge=-180, le=180), _: User = Depends(current_user)):
    """{label, locality, address} -- Nominatim when reachable, built-in gazetteer otherwise."""
    return geocode.reverse(lat, lng)


@router.get("/search")
def search(q: str = Query(min_length=2, max_length=120), _: User = Depends(current_user)):
    """[{label, lat, lng}] inside the Chennai metro bbox."""
    return geocode.search(q)
