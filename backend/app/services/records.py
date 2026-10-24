"""Hospital trip records (UR2: search by date, station or patient/request ID) and the station history PDF (UR4).

A hospital's records are the trips its own ambulances ran plus the patients delivered to it. Caller identity and
contact details never appear here: hospitals identify a case by its request number.
A trip's station is the station its ambulance belongs to now (TripRecord keeps the ambulance, not the station).
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from fpdf import FPDF
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..models import Ambulance, BillingRecord, DarkStation, EmergencyRequest, Hospital, TripRecord

IST = timezone(timedelta(hours=5, minutes=30))  # dates typed by staff are local (Chennai) dates


def _iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return (dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)).isoformat()


def _day_start(d: date) -> datetime:
    return datetime.combine(d, time.min, tzinfo=IST).astimezone(timezone.utc)


def _base(hospital_id: int):
    own_stations = select(DarkStation.id).where(DarkStation.hospital_id == hospital_id)
    return (select(TripRecord, EmergencyRequest, Ambulance, DarkStation, Hospital, BillingRecord)
            .join(EmergencyRequest, EmergencyRequest.id == TripRecord.request_id)
            .outerjoin(Ambulance, Ambulance.id == TripRecord.ambulance_id)
            .outerjoin(DarkStation, DarkStation.id == Ambulance.station_id)
            .outerjoin(Hospital, Hospital.id == TripRecord.destination_hospital_id)
            .outerjoin(BillingRecord, BillingRecord.trip_id == TripRecord.id)
            .where(or_(TripRecord.destination_hospital_id == hospital_id, Ambulance.station_id.in_(own_stations))))


def _filtered(hospital_id: int, date_from: date | None, date_to: date | None, station_id: int | None,
              request_id: int | None):
    q = _base(hospital_id)
    if date_from:
        q = q.where(EmergencyRequest.created_at >= _day_start(date_from))
    if date_to:
        q = q.where(EmergencyRequest.created_at < _day_start(date_to + timedelta(days=1)))
    if station_id is not None:
        q = q.where(Ambulance.station_id == station_id)
    if request_id is not None:
        q = q.where(EmergencyRequest.id == request_id)
    return q


def _row(hospital_id: int, trip: TripRecord, req: EmergencyRequest, amb: Ambulance | None, st: DarkStation | None,
         dest: Hospital | None, bill: BillingRecord | None) -> dict:
    return {
        "request_id": req.id, "trip_id": trip.id, "created_at": _iso(req.created_at), "completed_at": _iso(req.completed_at),
        "status": req.status.value, "incident_type": req.incident_type.value, "severity": req.severity,
        "ambulance": amb.registration_number if amb else None, "station_id": st.id if st else None,
        "station_name": st.name if st else None, "destination_hospital": dest.name if dest else None,
        "delivered_here": trip.destination_hospital_id == hospital_id,
        "own_fleet": bool(st and st.hospital_id == hospital_id),
        "response_time_seconds": trip.response_time_seconds, "handover_time": _iso(trip.handover_time),
        "distance_km": trip.distance_km, "closed_manually": trip.closed_manually,
        "amount": float(bill.amount) if bill else None,
        "payment_status": bill.payment_status.value if bill else None,
        "insurance_claim_status": bill.insurance_claim_status if bill else None,
    }


def search(db: Session, hospital_id: int, *, date_from: date | None = None, date_to: date | None = None,
           station_id: int | None = None, request_id: int | None = None, limit: int = 50, offset: int = 0) -> dict:
    q = _filtered(hospital_id, date_from, date_to, station_id, request_id)
    total = db.scalar(select(func.count()).select_from(q.subquery()))
    rows = db.execute(q.order_by(EmergencyRequest.created_at.desc(), EmergencyRequest.id.desc())
                      .limit(limit).offset(offset)).all()
    return {"total": total, "limit": limit, "offset": offset,
            "items": [_row(hospital_id, *r) for r in rows]}


def station_rows(db: Session, hospital_id: int, station_id: int, date_from: date | None, date_to: date | None) -> list[dict]:
    q = _filtered(hospital_id, date_from, date_to, station_id, None)
    return [_row(hospital_id, *r) for r in db.execute(q.order_by(EmergencyRequest.created_at, EmergencyRequest.id)).all()]


# ---------------------------------------------------------------- PDF (UR4)
def _latin1(s: object) -> str:
    """Core PDF fonts are Latin-1; replace anything else instead of failing the export."""
    return str(s).encode("latin-1", "replace").decode("latin-1")


def _money(x: float | None) -> str:
    return "-" if x is None else f"{x:,.2f}"


_COLS = [("Request", 18), ("Date", 26), ("Ambulance", 28), ("Incident", 26), ("Response", 20), ("Km", 14),
         ("Fare (INR)", 24), ("Payment", 24)]


def station_history_pdf(station: str, hospital: str, period: str, rows: list[dict], generated_at: str) -> bytes:
    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_title(_latin1(f"HADS trip and billing history - {station}"))
    pdf.set_author("HADS")
    pdf.set_auto_page_break(True, margin=15)
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 15)
    pdf.cell(0, 8, _latin1(f"Trip and billing history - {station}"), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, _latin1(f"Hospital: {hospital}"), new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, _latin1(f"Period: {period}"), new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 6, _latin1(f"Generated: {generated_at}"), new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    def header():
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_fill_color(240, 240, 243)
        for title, w in _COLS:
            pdf.cell(w, 7, title, border=1, fill=True)
        pdf.ln()
        pdf.set_font("Helvetica", "", 9)

    header()
    for r in rows:
        if pdf.get_y() > pdf.h - 25:
            pdf.add_page()
            header()
        values = [f"#{r['request_id']}", (r.get("completed_at") or r.get("created_at") or "")[:10], r.get("ambulance") or "-",
                  r.get("incident_type") or "-",
                  f"{round(r['response_time_seconds'] / 60)} min" if r.get("response_time_seconds") else "-",
                  f"{r['distance_km']:.1f}" if r.get("distance_km") is not None else "-",
                  _money(r.get("amount")),
                  (r.get("insurance_claim_status") and f"claim {r['insurance_claim_status']}") or r.get("payment_status") or "-"]
        for (_, w), v in zip(_COLS, values):
            pdf.cell(w, 6, _latin1(v), border=1)
        pdf.ln()

    billed = [r["amount"] for r in rows if r.get("amount") is not None]
    times = [r["response_time_seconds"] for r in rows if r.get("response_time_seconds")]
    pdf.ln(3)
    pdf.set_font("Helvetica", "B", 10)
    summary = f"Trips: {len(rows)}    Billed: INR {_money(sum(billed) if billed else 0.0)}"
    if times:
        summary += f"    Average response: {round(sum(times) / len(times) / 60)} min"
    pdf.cell(0, 6, _latin1(summary), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 8)
    pdf.cell(0, 5, "Caller identity and contact details are not included in this export.", new_x="LMARGIN", new_y="NEXT")
    return bytes(pdf.output())
