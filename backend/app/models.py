"""Persistent entities of HADS (derived from the Experiment 5 class diagram / Experiment 8 ER diagram).

DispatchEngine, PredictiveAnalyticsEngine, CapacityMatchingEngine and INotificationService are
processing components (see app/services/ and app/events.py), not tables.
Role tables of the ER diagram are collapsed into User.role plus small profile tables where a role
carries extra keys (crew -> ambulance, hospital staff -> hospital).
"""
import enum
from datetime import datetime, timezone

from sqlalchemy import (JSON, Boolean, DateTime, Enum, Float, ForeignKey, Integer, Numeric, String, Text,
                        UniqueConstraint, event, inspect)
from sqlalchemy.orm import Mapped, Session, mapped_column, relationship

from .crypto import EncryptedText
from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _enum(e):
    return Enum(e, native_enum=False, length=32, values_callable=lambda x: [m.value for m in x])


class Role(str, enum.Enum):
    requester = "requester"
    crew = "crew"
    hospital_staff = "hospital_staff"
    controller = "controller"
    admin = "admin"
    authority = "authority"  # City Health Authority


class AmbulanceStatus(str, enum.Enum):
    available = "available"
    assigned = "assigned"          # offered / accepted, heading to patient not yet confirmed
    en_route = "en_route"          # driving to the incident
    on_scene = "on_scene"
    transporting = "transporting"  # driving to hospital
    offline = "offline"
    maintenance = "maintenance"


class IncidentType(str, enum.Enum):
    cardiac = "cardiac"
    trauma = "trauma"
    stroke = "stroke"
    respiratory = "respiratory"
    maternity = "maternity"
    burns = "burns"
    poisoning = "poisoning"
    other = "other"


class RequestStatus(str, enum.Enum):
    received = "received"              # UC-1 done, queued for matching
    matching = "matching"              # UC-2 running
    awaiting_manual = "awaiting_manual"  # UC-2 A1: needs controller override
    offered = "offered"                # ambulance chosen, waiting for crew accept
    accepted = "accepted"              # crew accepted
    en_route = "en_route"              # crew heading to patient
    on_scene = "on_scene"
    transporting = "transporting"      # heading to destination hospital
    arrived = "arrived"                # crew marked arrival at hospital
    completed = "completed"            # handover logged, trip closed
    cancelled = "cancelled"
    failed = "failed"


ACTIVE_STATUSES = [s.value for s in RequestStatus if s.value not in ("completed", "cancelled", "failed")]


class AttemptStatus(str, enum.Enum):
    offered = "offered"
    accepted = "accepted"
    rejected = "rejected"
    timeout = "timeout"
    cancelled = "cancelled"


class PaymentStatus(str, enum.Enum):
    pending = "pending"
    paid = "paid"
    insurance_pending = "insurance_pending"
    waived = "waived"


class ClaimStatus(str, enum.Enum):
    submitted = "submitted"
    under_review = "under_review"
    approved = "approved"
    rejected = "rejected"
    settled = "settled"


class RebalanceStatus(str, enum.Enum):
    pending = "pending"
    accepted = "accepted"
    dismissed = "dismissed"


class User(Base):
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(20), unique=True, nullable=True)
    email: Mapped[str | None] = mapped_column(String(160), unique=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[Role] = mapped_column(_enum(Role), index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    token_version: Mapped[int] = mapped_column(Integer, default=0)  # bump to revoke every issued token
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    consented_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)  # DPDP notice accepted
    erased_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)     # DPDP erasure


class Hospital(Base):
    __tablename__ = "hospitals"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160), unique=True)
    address: Mapped[str] = mapped_column(String(255), default="")
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    partner_verified: Mapped[bool] = mapped_column(Boolean, default=True)  # STRQ2 (onboarding starts it False)
    registration_number: Mapped[str | None] = mapped_column(String(40), unique=True, nullable=True)  # clinical est. reg.
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    verified_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    total_beds: Mapped[int] = mapped_column(Integer, default=0)
    available_beds: Mapped[int] = mapped_column(Integer, default=0)
    total_icu: Mapped[int] = mapped_column(Integer, default=0)
    available_icu: Mapped[int] = mapped_column(Integer, default=0)
    # on-duty specialists by speciality key, e.g. {"cardiology": 2, "trauma": 1, "neurology": 0}
    specialists: Mapped[dict] = mapped_column(JSON, default=dict)
    capacity_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revenue_share_pct: Mapped[float] = mapped_column(Float, default=70.0)
    stations: Mapped[list["DarkStation"]] = relationship(back_populates="hospital", cascade="all, delete-orphan")


class HospitalStaffProfile(Base):
    __tablename__ = "hospital_staff_profiles"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    hospital_id: Mapped[int] = mapped_column(ForeignKey("hospitals.id"))


class DarkStation(Base):
    __tablename__ = "dark_stations"
    id: Mapped[int] = mapped_column(primary_key=True)
    hospital_id: Mapped[int] = mapped_column(ForeignKey("hospitals.id"))
    name: Mapped[str] = mapped_column(String(160))
    address: Mapped[str] = mapped_column(String(255), default="")
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    hospital: Mapped[Hospital] = relationship(back_populates="stations")
    ambulances: Mapped[list["Ambulance"]] = relationship(back_populates="station")


class StationAssignment(Base):
    """Many-to-many: controllers / admins <-> stations they oversee / onboarded."""
    __tablename__ = "station_assignments"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    station_id: Mapped[int] = mapped_column(ForeignKey("dark_stations.id"), primary_key=True)


class Ambulance(Base):
    __tablename__ = "ambulances"
    id: Mapped[int] = mapped_column(primary_key=True)
    station_id: Mapped[int] = mapped_column(ForeignKey("dark_stations.id"), index=True)  # current home station
    registration_number: Mapped[str] = mapped_column(String(32), unique=True)
    kind: Mapped[str] = mapped_column(String(8), default="BLS")  # BLS | ALS
    status: Mapped[AmbulanceStatus] = mapped_column(_enum(AmbulanceStatus), default=AmbulanceStatus.available, index=True)
    lat: Mapped[float | None] = mapped_column(Float, nullable=True)
    lng: Mapped[float | None] = mapped_column(Float, nullable=True)
    location_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    staffed: Mapped[bool] = mapped_column(Boolean, default=True)  # crew on shift
    station: Mapped[DarkStation] = relationship(back_populates="ambulances")


class CrewProfile(Base):
    __tablename__ = "crew_profiles"
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), primary_key=True)
    license_number: Mapped[str] = mapped_column(String(40))
    ambulance_id: Mapped[int | None] = mapped_column(ForeignKey("ambulances.id"), nullable=True)


class AmbulanceLocation(Base):
    """GPS history (time series). Latest point is mirrored on Ambulance.lat/lng."""
    __tablename__ = "ambulance_locations"
    id: Mapped[int] = mapped_column(primary_key=True)
    ambulance_id: Mapped[int] = mapped_column(ForeignKey("ambulances.id"), index=True)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)


class EmergencyRequest(Base):
    __tablename__ = "emergency_requests"
    id: Mapped[int] = mapped_column(primary_key=True)
    client_uuid: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)  # idempotent retry (UC-1 E1)
    requester_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    caller_name: Mapped[str | None] = mapped_column(EncryptedText, nullable=True)   # PII: encrypted at rest (NFR3)
    caller_phone: Mapped[str | None] = mapped_column(EncryptedText, nullable=True)
    channel: Mapped[str] = mapped_column(String(8), default="app")  # app | ivr
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    address: Mapped[str | None] = mapped_column(EncryptedText, nullable=True)
    incident_type: Mapped[IncidentType] = mapped_column(_enum(IncidentType), default=IncidentType.other)
    severity: Mapped[int] = mapped_column(Integer, default=3)  # 1 (minor) .. 5 (critical)
    # child | adult | senior | elderly | unknown. Clinical hand-off info and demand-model input ONLY: never used in
    # ambulance or hospital ranking (STRQ1, see tests/test_fairness.py).
    patient_age_group: Mapped[str] = mapped_column(String(10), default="unknown")
    notes: Mapped[str | None] = mapped_column(EncryptedText, nullable=True)
    status: Mapped[RequestStatus] = mapped_column(_enum(RequestStatus), default=RequestStatus.received, index=True)
    ambulance_id: Mapped[int | None] = mapped_column(ForeignKey("ambulances.id"), nullable=True)
    destination_hospital_id: Mapped[int | None] = mapped_column(ForeignKey("hospitals.id"), nullable=True)
    eta_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)  # to patient, then to hospital
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)  # ambulance confirmed
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    match_duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)  # NFR1 evidence
    ambulance = relationship("Ambulance")
    destination_hospital = relationship("Hospital")
    requester = relationship("User")


class DispatchAttempt(Base):
    __tablename__ = "dispatch_attempts"
    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("emergency_requests.id"), index=True)
    ambulance_id: Mapped[int] = mapped_column(ForeignKey("ambulances.id"))
    rank: Mapped[int] = mapped_column(Integer, default=1)
    eta_seconds: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[AttemptStatus] = mapped_column(_enum(AttemptStatus), default=AttemptStatus.offered)
    offered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    responded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TripRecord(Base):
    __tablename__ = "trip_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("emergency_requests.id"), unique=True)
    ambulance_id: Mapped[int | None] = mapped_column(ForeignKey("ambulances.id"), nullable=True)
    destination_hospital_id: Mapped[int | None] = mapped_column(ForeignKey("hospitals.id"), nullable=True)
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    arrived_scene_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    arrived_hospital_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    handover_time: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    handover_confirmed_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    response_time_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)  # request -> on scene
    distance_km: Mapped[float | None] = mapped_column(Float, nullable=True)
    closed_manually: Mapped[bool] = mapped_column(Boolean, default=False)  # UC-4 E1
    summary: Mapped[dict] = mapped_column(JSON, default=dict)
    request = relationship("EmergencyRequest")


class BillingRecord(Base):
    __tablename__ = "billing_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    trip_id: Mapped[int] = mapped_column(ForeignKey("trip_records.id"), unique=True)
    base_fare: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    distance_charge: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    surcharge: Mapped[float] = mapped_column(Numeric(10, 2), default=0)  # ALS etc.
    amount: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    hospital_share: Mapped[float] = mapped_column(Numeric(10, 2), default=0)  # revenue share (default 70%)
    platform_share: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    payment_status: Mapped[PaymentStatus] = mapped_column(_enum(PaymentStatus), default=PaymentStatus.pending)
    insurance_claim_status: Mapped[str | None] = mapped_column(String(20), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    trip = relationship("TripRecord")


class InsuranceClaim(Base):
    __tablename__ = "insurance_claims"
    id: Mapped[int] = mapped_column(primary_key=True)
    bill_id: Mapped[int] = mapped_column(ForeignKey("billing_records.id"), unique=True)
    insurer: Mapped[str] = mapped_column(String(120))
    policy_number: Mapped[str] = mapped_column(String(60))
    amount_claimed: Mapped[float] = mapped_column(Numeric(10, 2), default=0)
    status: Mapped[ClaimStatus] = mapped_column(_enum(ClaimStatus), default=ClaimStatus.submitted)
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    remarks: Mapped[str | None] = mapped_column(Text, nullable=True)


class AuditLog(Base):
    """Append-only, hash-chained (NFR7). Never updated or deleted by application code."""
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    action: Mapped[str] = mapped_column(String(64), index=True)  # e.g. dispatch.assign, capacity.query, trip.handover
    entity: Mapped[str] = mapped_column(String(48))
    entity_id: Mapped[str | None] = mapped_column(String(48), nullable=True)
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    prev_hash: Mapped[str] = mapped_column(String(64), default="")
    hash: Mapped[str] = mapped_column(String(64), default="")


class IncidentHistory(Base):
    """Historical + live incident observations feeding the predictive engine (FR3, FR8)."""
    __tablename__ = "incident_history"
    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    zone_id: Mapped[str] = mapped_column(String(16), index=True)
    incident_type: Mapped[str] = mapped_column(String(24), default="other")
    severity: Mapped[int] = mapped_column(Integer, default=3)
    traffic_index: Mapped[float] = mapped_column(Float, default=0.5)  # 0 free .. 1 gridlock
    response_time_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    source: Mapped[str] = mapped_column(String(12), default="synthetic")  # synthetic | live
    patient_age_group: Mapped[str] = mapped_column(String(10), default="unknown")  # child|adult|senior|elderly|unknown


class ZoneRisk(Base):
    """Output of the predictive engine: expected demand per zone for a given hour."""
    __tablename__ = "zone_risk"
    __table_args__ = (UniqueConstraint("generated_at", "zone_id", "hour"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    zone_id: Mapped[str] = mapped_column(String(16), index=True)
    hour: Mapped[int] = mapped_column(Integer)  # 0..23 hour-of-day the prediction is for
    expected_demand: Mapped[float] = mapped_column(Float)  # expected incidents / hour
    risk: Mapped[float] = mapped_column(Float)  # normalised 0..1
    model_version: Mapped[str] = mapped_column(String(32), default="v0")


class ZoneDemographics(Base):
    """Residences and age groups per grid zone: the demand model's population features (seniors need more care).
    source = "synthetic" (built-in Chennai estimate) or "import" (real data loaded from CSV by an admin)."""
    __tablename__ = "zone_demographics"
    zone_id: Mapped[str] = mapped_column(String(16), primary_key=True)
    households: Mapped[int] = mapped_column(Integer, default=0)
    pop_0_14: Mapped[int] = mapped_column(Integer, default=0)
    pop_15_59: Mapped[int] = mapped_column(Integer, default=0)
    pop_60_74: Mapped[int] = mapped_column(Integer, default=0)
    pop_75_plus: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String(12), default="synthetic")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    @property
    def population(self) -> int:
        return self.pop_0_14 + self.pop_15_59 + self.pop_60_74 + self.pop_75_plus

    @property
    def seniors(self) -> int:
        return self.pop_60_74 + self.pop_75_plus

    @property
    def senior_share(self) -> float:
        return self.seniors / self.population if self.population else 0.0


class ModelMetric(Base):
    """Prediction-accuracy history (FR11 'prediction accuracy')."""
    __tablename__ = "model_metrics"
    id: Mapped[int] = mapped_column(primary_key=True)
    trained_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    model_version: Mapped[str] = mapped_column(String(32))
    mae: Mapped[float] = mapped_column(Float)
    r2: Mapped[float] = mapped_column(Float)
    n_train: Mapped[int] = mapped_column(Integer)
    n_live: Mapped[int] = mapped_column(Integer, default=0)  # live incidents folded in (FR8)


class RebalanceRecommendation(Base):
    __tablename__ = "rebalance_recommendations"
    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    ambulance_id: Mapped[int] = mapped_column(ForeignKey("ambulances.id"))
    from_station_id: Mapped[int] = mapped_column(ForeignKey("dark_stations.id"))
    to_station_id: Mapped[int] = mapped_column(ForeignKey("dark_stations.id"))
    reason: Mapped[str] = mapped_column(String(255), default="")
    expected_gain_seconds: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[RebalanceStatus] = mapped_column(_enum(RebalanceStatus), default=RebalanceStatus.pending)
    decided_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)


class PlatformSetting(Base):
    __tablename__ = "platform_settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)


class RequestEvent(Base):
    """Status timeline (v2 section 3): one row per request state transition, written automatically on flush."""
    __tablename__ = "request_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("emergency_requests.id"), index=True)
    status: Mapped[str] = mapped_column(String(32))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    note: Mapped[str | None] = mapped_column(String(120), nullable=True)
    request = relationship("EmergencyRequest")


class Notification(Base):
    """In-app notification (WBS 4.5). Pushed on websocket topic user:{id}; unread rows are fetched on reconnect."""
    __tablename__ = "notifications"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    type: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(String(255), default="")
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ShareLink(Base):
    """Family share link (v2 section 4). token = '<random id>.<hmac>'; one link per request (idempotent)."""
    __tablename__ = "share_links"
    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("emergency_requests.id"), unique=True)
    token: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    created_by: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


# ---------------------------------------------------------------- timeline capture
# Every EmergencyRequest.status change is persisted as a RequestEvent in the same flush, so no code path
# (state machine, manual override, closure, seed) can change a status without leaving a timeline entry.
# Set `req._hads_actor = (user_id, note)` before the flush to attribute the change; `req._hads_no_events = True`
# disables capture for bulk/backfilled rows (the seed writes its own historical timeline).
def _status_value(v) -> str:
    return v.value if hasattr(v, "value") else str(v)


@event.listens_for(Session, "before_flush")
def _capture_status_events(session, flush_context, instances) -> None:
    for obj in list(session.new) + list(session.dirty):
        if not isinstance(obj, EmergencyRequest) or obj.__dict__.get("_hads_no_events"):
            continue
        actor, note = obj.__dict__.pop("_hads_actor", (None, None))
        if obj in session.new:
            status = obj.status or RequestStatus.received
            session.add(RequestEvent(request=obj, status=_status_value(status), at=obj.created_at or utcnow(),
                                     actor_user_id=actor, note=note))
            continue
        hist = inspect(obj).attrs.status.history
        if hist.added and (not hist.deleted or _status_value(hist.added[0]) != _status_value(hist.deleted[0])):
            session.add(RequestEvent(request=obj, status=_status_value(hist.added[0]), at=utcnow(),
                                     actor_user_id=actor, note=note))
