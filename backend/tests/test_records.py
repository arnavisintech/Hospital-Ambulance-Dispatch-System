"""UR2: hospital staff search past trip/incident records by date, station or patient (request) ID.
UR4: export a station's trip and billing history as a PDF."""
from datetime import timedelta

from app.db import SessionLocal
from app.models import Ambulance, BillingRecord, EmergencyRequest, IncidentType, PaymentStatus, RequestStatus, Role, TripRecord, utcnow


def _trip(world_ids, *, amb, hosp, days_ago, incident=IncidentType.trauma, amount=None):
    with SessionLocal() as db:
        at = utcnow() - timedelta(days=days_ago)
        req = EmergencyRequest(lat=13.08, lng=80.27, status=RequestStatus.completed, incident_type=incident, severity=3,
                               ambulance_id=amb, destination_hospital_id=hosp, created_at=at, completed_at=at + timedelta(minutes=40),
                               caller_name="Secret Caller", caller_phone="9999999999")
        db.add(req)
        db.flush()
        station = db.get(Ambulance, amb).station_id
        trip = TripRecord(request_id=req.id, ambulance_id=amb, station_id=station, destination_hospital_id=hosp, dispatched_at=at,
                          handover_time=at + timedelta(minutes=35), response_time_seconds=480, distance_km=6.5)
        db.add(trip)
        db.flush()
        if amount is not None:
            db.add(BillingRecord(trip_id=trip.id, base_fare=500, distance_charge=162.5, surcharge=0, amount=amount,
                                 hospital_share=amount * 0.7, platform_share=amount * 0.3, payment_status=PaymentStatus.paid))
        db.commit()
        world_ids.append(req.id)
        return req.id


def _scene(world):
    h, other = world.hospital(), world.hospital()
    st1, st2 = world.station(h), world.station(h)
    a1, a2 = world.ambulance(st1), world.ambulance(st2, lat=13.09, lng=80.28)
    s_a1 = a1
    oa = world.ambulance(world.station(other), lat=13.07, lng=80.26)
    ids: list[int] = []
    s = {"h": h, "other": other, "st1": st1, "st2": st2, "ids": ids, "a1": s_a1,
         "staff": world.user(Role.hospital_staff, hospital_id=h), "stranger": world.user(Role.hospital_staff, hospital_id=other)}
    s["old"] = _trip(ids, amb=a1, hosp=h, days_ago=20, amount=662.5)
    s["recent"] = _trip(ids, amb=a2, hosp=h, days_ago=2, incident=IncidentType.cardiac, amount=900.0)
    s["delivered_by_other"] = _trip(ids, amb=oa, hosp=h, days_ago=1)        # other fleet, delivered here
    s["foreign"] = _trip(ids, amb=oa, hosp=other, days_ago=1)               # nothing to do with this hospital
    return s


def test_records_cover_own_fleet_and_patients_delivered_here(client, world):
    s = _scene(world)
    j = client.get(f"/api/hospitals/{s['h']}/records", headers=s["staff"]["h"]).json()
    ids = [r["request_id"] for r in j["items"]]
    assert sorted(ids) == sorted([s["old"], s["recent"], s["delivered_by_other"]]) and j["total"] == 3
    assert ids[0] == s["delivered_by_other"]                       # newest first
    assert "Secret Caller" not in str(j) and "9999999999" not in str(j)
    row = next(r for r in j["items"] if r["request_id"] == s["recent"])
    assert row["incident_type"] == "cardiac" and row["station_id"] == s["st2"] and row["response_time_seconds"] == 480


def test_records_filter_by_date_station_and_request_id(client, world):
    s = _scene(world)
    url, h = f"/api/hospitals/{s['h']}/records", s["staff"]["h"]
    since = (utcnow() - timedelta(days=5)).date().isoformat()
    assert {r["request_id"] for r in client.get(url, params={"date_from": since}, headers=h).json()["items"]} == {s["recent"], s["delivered_by_other"]}
    until = (utcnow() - timedelta(days=10)).date().isoformat()
    assert [r["request_id"] for r in client.get(url, params={"date_to": until}, headers=h).json()["items"]] == [s["old"]]
    assert [r["request_id"] for r in client.get(url, params={"station_id": s["st1"]}, headers=h).json()["items"]] == [s["old"]]
    assert [r["request_id"] for r in client.get(url, params={"request_id": s["recent"]}, headers=h).json()["items"]] == [s["recent"]]
    assert client.get(url, params={"request_id": s["foreign"]}, headers=h).json()["items"] == []


def test_records_are_scoped_to_the_hospital(client, world):
    s = _scene(world)
    assert client.get(f"/api/hospitals/{s['h']}/records", headers=s["stranger"]["h"]).status_code == 403
    assert client.get(f"/api/hospitals/{s['h']}/records", headers=world.user(Role.admin)["h"]).status_code == 200
    assert client.get(f"/api/hospitals/{s['h']}/records", params={"station_id": s["st1"]},
                      headers=s["stranger"]["h"]).status_code == 403


def test_trips_stay_with_the_hospital_that_ran_them_after_a_unit_moves(client, world):
    """A unit rebalanced to another hospital's station must not carry its past trips (and billing) with it."""
    s = _scene(world)
    other_station = world.station(s["other"])
    with SessionLocal() as db:
        db.get(Ambulance, s["a1"]).station_id = other_station
        db.commit()
    mine = {r["request_id"] for r in client.get(f"/api/hospitals/{s['h']}/records", headers=s["staff"]["h"]).json()["items"]}
    assert s["old"] in mine
    by_station = client.get(f"/api/hospitals/{s['h']}/records", params={"station_id": s["st1"]}, headers=s["staff"]["h"]).json()
    assert [r["request_id"] for r in by_station["items"]] == [s["old"]]
    theirs = {r["request_id"] for r in client.get(f"/api/hospitals/{s['other']}/records", headers=s["stranger"]["h"]).json()["items"]}
    assert s["old"] not in theirs


def test_new_trip_records_remember_their_station(client, world):
    from app.services import trips
    st = world.station(world.hospital())
    amb = world.ambulance(st)
    with SessionLocal() as db:
        req = EmergencyRequest(lat=13.08, lng=80.27, ambulance_id=amb)
        db.add(req)
        db.flush()
        assert trips.get_or_create_trip(db, req).station_id == st


def test_station_history_pdf(client, world):
    s = _scene(world)
    r = client.get(f"/api/hospitals/{s['h']}/stations/{s['st1']}/history.pdf", headers=s["staff"]["h"])
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert "attachment" in r.headers["content-disposition"] and ".pdf" in r.headers["content-disposition"]
    assert r.content.startswith(b"%PDF-") and r.content.rstrip().endswith(b"%%EOF")
    assert b"Secret Caller" not in r.content
    # another hospital's station, or a station id under the wrong hospital
    assert client.get(f"/api/hospitals/{s['h']}/stations/{s['st1']}/history.pdf", headers=s["stranger"]["h"]).status_code == 403
    other_station = world.station(s["other"])
    assert client.get(f"/api/hospitals/{s['h']}/stations/{other_station}/history.pdf", headers=s["staff"]["h"]).status_code == 404


def test_station_history_pdf_lists_trips_and_totals():
    from app.services.records import station_history_pdf
    rows = [{"request_id": 7, "completed_at": "2026-10-01T10:00:00+00:00", "incident_type": "trauma",
             "response_time_seconds": 480, "distance_km": 6.5, "amount": 662.5, "payment_status": "paid",
             "insurance_claim_status": None, "ambulance": "TN01AB0001"}]
    pdf = station_history_pdf("Adyar bay", "Apollo Adyar", "2026-10-01 to 2026-10-31", rows, generated_at="2026-10-25 10:00 IST")
    text = _pdf_text(pdf)
    assert "Adyar bay" in text and "Apollo Adyar" in text and "TN01AB0001" in text
    assert "662.50" in text and "Trips: 1" in text


def _pdf_text(pdf: bytes) -> str:
    """Text shown by an fpdf2 PDF: inflate each content stream and collect its `(...) Tj` strings."""
    import re
    import zlib
    out = []
    for raw in re.findall(rb"stream\r?\n(.*?)\r?\nendstream", pdf, re.S):
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            pass
        out += [m.decode("latin-1") for m in re.findall(rb"\((.*?)\) ?Tj", raw)]
    return " ".join(out)
