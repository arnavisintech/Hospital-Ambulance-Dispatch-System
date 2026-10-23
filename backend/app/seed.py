"""Idempotent demo seed for the Chennai pilot (deterministic: fixed RNG seed). Completes in a few seconds."""
from __future__ import annotations

import logging
import random
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import audit, places
from .geo import haversine_km
from .models import (Ambulance, AmbulanceStatus, ClaimStatus, CrewProfile, DarkStation, EmergencyRequest, Hospital,
                     HospitalStaffProfile, IncidentHistory, IncidentType, PlatformSetting, RequestStatus, Role,
                     StationAssignment, TripRecord, User, utcnow)
from .security import hash_password
from .services import analytics, billing
from .synthetic import HOTSPOTS, generate_history, to_rows

log = logging.getLogger("hads.seed")
DEMO_PASSWORD = "Hads@1234"
SEED = 20240611

# One demo login per role (shown on the login page in demo mode only): role, label, email, hint
DEMO_ACCOUNTS = [
    ("requester", "Requester", "user@hads.in", "Request & track an ambulance"),
    ("crew", "Crew", "crew1@hads.in", "Accept trips and navigate"),
    ("hospital_staff", "Hospital", "staff1@hads.in", "Capacity and incoming patients"),
    ("controller", "Controller", "controller@hads.in", "Live dispatch board"),
    ("admin", "Admin", "admin@hads.in", "Onboarding and platform setup"),
    ("authority", "Authority", "authority@hads.in", "City oversight and KPIs"),
]

# Real Chennai partner hospitals (public names, approximate campus coordinates).
# name, address, lat, lng, beds, icu, specialists
HOSPITALS = [
    ("Rajiv Gandhi Government General Hospital", "EVR Periyar Salai, Park Town, Chennai 600003", 13.0801, 80.2771, 240, 44,
     {"trauma": 4, "cardiology": 2, "neurology": 2, "obstetrics": 2, "burns": 2, "toxicology": 1, "pulmonology": 1}),
    ("Apollo Hospitals, Greams Road", "21 Greams Lane, off Greams Road, Thousand Lights, Chennai 600006", 13.0630, 80.2512, 180, 36,
     {"cardiology": 4, "neurology": 2, "trauma": 2, "obstetrics": 1, "pulmonology": 2}),
    ("MIOT International", "4/112 Mount Poonamallee Road, Manapakkam, Chennai 600089", 13.0187, 80.1858, 160, 30,
     {"trauma": 3, "cardiology": 2, "neurology": 1, "burns": 1}),
    ("Fortis Malar Hospital, Adyar", "52 1st Main Road, Gandhi Nagar, Adyar, Chennai 600020", 13.0089, 80.2575, 120, 24,
     {"cardiology": 3, "neurology": 1, "obstetrics": 2}),
    ("Kauvery Hospital, Alwarpet", "81 TTK Road, Alwarpet, Chennai 600018", 13.0339, 80.2537, 110, 20,
     {"cardiology": 2, "neurology": 2, "obstetrics": 1, "pulmonology": 1}),
    ("SIMS Hospital, Vadapalani", "1 Jawaharlal Nehru Salai, Vadapalani, Chennai 600026", 13.0518, 80.2117, 150, 28,
     {"cardiology": 2, "trauma": 2, "neurology": 2, "obstetrics": 2}),
    ("Gleneagles Global Health City, Perumbakkam", "439 Cheran Nagar, Perumbakkam, Chennai 600100", 12.8999, 80.2059, 200, 40,
     {"trauma": 3, "cardiology": 3, "neurology": 2, "obstetrics": 1, "toxicology": 1}),
    ("Government Stanley Medical College Hospital", "Old Jail Road, Old Washermanpet, Chennai 600001", 13.1067, 80.2866, 190, 28,
     {"trauma": 3, "burns": 2, "cardiology": 1, "obstetrics": 1, "toxicology": 1}),
]
# Dark stations named by locality: name, lat, lng, partner hospital index, RTO code for the ambulance plates
STATIONS = [
    ("T. Nagar Station", 13.0418, 80.2341, 1, "TN-09"), ("Adyar Station", 13.0012, 80.2565, 3, "TN-07"),
    ("Anna Nagar Station", 13.0850, 80.2101, 5, "TN-02"), ("Velachery Station", 12.9815, 80.2180, 6, "TN-22"),
    ("Guindy Station", 13.0067, 80.2206, 2, "TN-22"), ("Porur Station", 13.0382, 80.1565, 2, "TN-10"),
    ("Perambur Station", 13.1187, 80.2335, 7, "TN-05"), ("Egmore Station", 13.0732, 80.2609, 0, "TN-01"),
    ("Tondiarpet Station", 13.1268, 80.2880, 7, "TN-04"), ("Mylapore Station", 13.0339, 80.2676, 4, "TN-06"),
    ("Koyambedu Station", 13.0694, 80.1948, 5, "TN-02"), ("Sholinganallur Station", 12.9010, 80.2279, 6, "TN-14"),
]
AMB_PER_STATION = [3, 2, 2, 3, 3, 2, 2, 3, 2, 2, 3, 3]  # = 30

# One crew login per ambulance: crew1@hads.in .. crew30@hads.in
CREW_NAMES = [
    "Murugan Selvaraj", "Karthik Raman", "Senthil Kumar", "Arun Prakash", "Vignesh Babu", "Lakshmi Narayanan",
    "Prakash Rajendran", "Divya Shankar", "Saravanan Pandian", "Balaji Venkatesan", "Ramesh Govindan", "Kavitha Murali",
    "Suresh Annamalai", "Dinesh Kannan", "Priya Dharshini", "Manikandan Velu", "Gopinath Subramani", "Revathi Sekar",
    "Ashok Thangaraj", "Naveen Chandrasekar", "Elango Perumal", "Sathish Kumar R", "Meena Ilango", "Rajkumar Durai",
    "Anand Natarajan", "Hariharan Mohan", "Deepa Ravichandran", "Vinoth Ganesan", "Sakthivel Muthu", "Jayanthi Arumugam",
]
STAFF_NAMES = ["Dr. S. Kalpana", "Dr. R. Vijay Anand", "Dr. Nithya Ramesh", "Dr. Arvind Swaminathan",
               "Dr. Shalini Iyer", "Dr. K. Manoj", "Dr. Bhavani Sridhar", "Dr. P. Rajasekaran"]


def seed_if_empty(db: Session, days: int = 90, historical_trips: int = 60, train: bool = True) -> bool:
    """Seed demo data when the DB has no hospitals/users. Returns True if it seeded."""
    if db.scalar(select(func.count(Hospital.id))) or db.scalar(select(func.count(User.id))):
        return False
    rng = random.Random(SEED)
    now = utcnow()
    pw = hash_password(DEMO_PASSWORD)  # one hash reused: bcrypt per user would take seconds

    hospitals = []
    for name, addr, lat, lng, beds, icu, spec in HOSPITALS:
        h = Hospital(name=name, address=addr, lat=lat, lng=lng, total_beds=beds, total_icu=icu,
                     available_beds=int(beds * rng.uniform(0.15, 0.4)), available_icu=max(1, int(icu * rng.uniform(0.1, 0.4))),
                     specialists=spec, capacity_updated_at=now, revenue_share_pct=70.0, partner_verified=True)
        db.add(h)
        hospitals.append(h)
    db.flush()

    stations = []
    for name, lat, lng, hi, _rto in STATIONS:
        s = DarkStation(hospital_id=hospitals[hi].id, name=name, address=places.reverse(lat, lng)["address"], lat=lat, lng=lng)
        db.add(s)
        stations.append(s)
    db.flush()

    ambulances = []
    n = 0
    for s, cnt, spec in zip(stations, AMB_PER_STATION, STATIONS):
        for _ in range(cnt):
            n += 1
            # parked at the station (within ~20 m) so the demo autopilot does not "drive home" on first start
            a = Ambulance(station_id=s.id, registration_number=f"{spec[4]}-AM-{4100 + n * 37 % 900}",
                          kind="ALS" if n % 3 == 0 else "BLS", status=AmbulanceStatus.available, staffed=True,
                          lat=s.lat + rng.uniform(-0.0002, 0.0002), lng=s.lng + rng.uniform(-0.0002, 0.0002),
                          location_updated_at=now)
            db.add(a)
            ambulances.append(a)
    db.flush()

    def user(name, email, role, phone=None):
        u = User(name=name, email=email, phone=phone, password_hash=pw, role=role, is_active=True)
        db.add(u)
        db.flush()
        return u

    admin = user("Karthikeyan Subramanian", "admin@hads.in", Role.admin, "9840000001")
    controller = user("Priya Venkatesh", "controller@hads.in", Role.controller, "9840000002")
    user("Dr. Meena Sundaram", "authority@hads.in", Role.authority, "9840000003")
    requester = user("Anitha Krishnan", "user@hads.in", Role.requester, "9000000001")
    for i, h in enumerate(hospitals, 1):
        u = user(STAFF_NAMES[(i - 1) % len(STAFF_NAMES)], f"staff{i}@hads.in", Role.hospital_staff, f"98402{i:05d}")
        db.add(HospitalStaffProfile(user_id=u.id, hospital_id=h.id))
    for i, a in enumerate(ambulances, 1):  # one crew account per ambulance
        u = user(CREW_NAMES[(i - 1) % len(CREW_NAMES)], f"crew{i}@hads.in", Role.crew, f"98401{i:05d}")
        db.add(CrewProfile(user_id=u.id, license_number=f"TN{(i % 22) + 1:02d} 2019{i:07d}", ambulance_id=a.id))
    for s in stations:
        db.add(StationAssignment(user_id=controller.id, station_id=s.id))
        db.add(StationAssignment(user_id=admin.id, station_id=s.id))

    for k, (dflt, *_rest) in billing.SETTING_DEFS.items():
        db.add(PlatformSetting(key=k, value={"value": dflt}))

    # 90 days of synthetic history
    df = generate_history(days=days, end=now, seed=SEED)
    db.bulk_insert_mappings(IncidentHistory, to_rows(df))
    db.flush()

    _historical_trips(db, rng, now, hospitals, ambulances, requester, df, historical_trips)
    from .services.trips import backfill_events
    backfill_events(db)  # status timelines for the historical trips
    audit.log(db, "seed.init", "system", None, None,
              {"hospitals": len(hospitals), "stations": len(stations), "ambulances": len(ambulances),
               "incident_history": int(len(df)), "historical_trips": historical_trips})
    db.commit()
    if train:
        m = analytics.train_model(db)
        log.info("seeded; initial model %s (mae=%s r2=%s)", m["model_version"], m["mae"], m["r2"])
    return True


def _historical_trips(db, rng, now, hospitals, ambulances, requester, df, count):
    if count <= 0:
        return
    # sample incident locations from the last 14 days of synthetic data (recent hotspots)
    recent = df.tail(max(count * 4, 200)).sample(n=count, random_state=SEED).sort_values("ts")
    n_cancel = max(2, count // 15)
    statuses = [RequestStatus.completed] * count
    claim_plan = ["pay", "claim_submitted", "claim_review", "claim_approved", "claim_settled", "claim_rejected"]
    for i, row in enumerate(recent.itertuples(index=False)):
        created = now - timedelta(days=rng.uniform(0.2, 14), minutes=rng.uniform(0, 600))
        itype = IncidentType(row.incident_type)
        sev = int(row.severity)
        amb = min(ambulances, key=lambda a: haversine_km(row.lat, row.lng, a.lat, a.lng) + rng.uniform(0, 2.5))
        hosp = min(hospitals, key=lambda h: haversine_km(row.lat, row.lng, h.lat, h.lng) + rng.uniform(0, 3))
        match_ms = int(rng.lognormvariate(5.3, 0.45))                 # ~200ms typical
        accept_s = rng.uniform(6, 32)
        drive_km = haversine_km(row.lat, row.lng, amb.lat, amb.lng) * 1.35
        resp_s = int(accept_s + drive_km / 28 * 3600 + rng.uniform(30, 90))
        to_hosp_km = haversine_km(row.lat, row.lng, hosp.lat, hosp.lng) * 1.35
        t_hosp = created + timedelta(seconds=resp_s + rng.uniform(240, 540) + to_hosp_km / 30 * 3600)
        t_hand = t_hosp + timedelta(seconds=rng.uniform(120, 420))
        cancelled = i < n_cancel
        req = EmergencyRequest(
            requester_id=requester.id, caller_name=requester.name, caller_phone=requester.phone,
            channel="ivr" if i % 7 == 0 else "app",
            lat=row.lat, lng=row.lng, address=places.reverse(row.lat, row.lng)["address"], incident_type=itype, severity=sev,
            status=RequestStatus.cancelled if cancelled else RequestStatus.completed,
            ambulance_id=None if cancelled else amb.id, destination_hospital_id=None if cancelled else hosp.id,
            created_at=created, dispatched_at=None if cancelled else created + timedelta(milliseconds=match_ms),
            accepted_at=None if cancelled else created + timedelta(seconds=accept_s),
            completed_at=None if cancelled else t_hand, match_duration_ms=match_ms, eta_seconds=resp_s)
        req._hads_no_events = True  # timeline is synthesized from the historical timestamps by backfill_events
        db.add(req)
        db.flush()
        if cancelled:
            continue
        trip = TripRecord(
            request_id=req.id, ambulance_id=amb.id, destination_hospital_id=hosp.id,
            dispatched_at=req.dispatched_at, arrived_scene_at=created + timedelta(seconds=resp_s), arrived_hospital_at=t_hosp,
            handover_time=t_hand, response_time_seconds=resp_s, distance_km=round(drive_km + to_hosp_km, 2),
            summary={"redirect_avoided": bool(rng.random() < 0.22), "seeded": True})
        db.add(trip)
        db.flush()
        bill = billing.create_bill_for_trip(db, trip)
        plan = claim_plan[i % len(claim_plan)] if i % 4 else "pending"
        if plan == "pay":
            billing.pay_bill(db, bill, "upi")
        elif plan.startswith("claim"):
            claim = billing.submit_claim(db, bill, rng.choice(["Star Health", "HDFC ERGO", "New India Assurance", "Niva Bupa"]),
                                         f"POL{rng.randint(100000, 999999)}")
            path = {"claim_submitted": [], "claim_review": ["under_review"],
                    "claim_approved": ["under_review", "approved"], "claim_settled": ["under_review", "approved", "settled"],
                    "claim_rejected": ["under_review", "rejected"]}[plan]
            for st in path:
                billing.update_claim_status(db, claim, ClaimStatus(st), "seeded")
        analytics.record_outcome(db, req, trip)
