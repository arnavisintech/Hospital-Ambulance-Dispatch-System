export type Role = 'requester' | 'crew' | 'hospital_staff' | 'controller' | 'admin' | 'authority';

export interface User {
  id: number;
  name: string;
  phone?: string | null;
  email?: string | null;
  role: Role;
  hospital_id?: number | null;
  ambulance_id?: number | null;
  is_active?: boolean;
  must_change_password?: boolean;
}

export interface TokenResponse { token: string; user: User }

export type LatLng = [number, number];

export const INCIDENT_TYPES = [
  'cardiac', 'accident', 'stroke', 'respiratory', 'maternity', 'trauma', 'burns', 'poisoning', 'other',
] as const;

export type RequestStatus = string;

export const STATUS_TIMELINE = [
  'received', 'offered', 'accepted', 'en_route', 'on_scene', 'transporting', 'arrived', 'completed',
] as const;

export interface Attempt { ambulance_id: number; registration_number: string; rank: number; status: string; eta_seconds: number | null }

export interface RequestOut {
  id: number;
  status: RequestStatus;
  incident_type: string;
  severity: number;
  lat: number;
  lng: number;
  address?: string | null;
  notes?: string | null;
  channel?: string;
  requester_id?: number | null;
  caller_name?: string | null;
  caller_phone?: string | null;
  ambulance?: { id: number; registration_number: string; kind?: string } | null;
  destination_hospital?: { id: number; name: string; lat: number; lng: number } | null;
  eta_seconds?: number | null;
  created_at: string;
  dispatched_at?: string | null;
  accepted_at?: string | null;
  completed_at?: string | null;
  match_duration_ms?: number | null;
  attempts?: Attempt[];
  /** v2: every status transition with timestamp. */
  timeline?: TimelineEvent[];
  /** v2: nearest gazetteer locality, e.g. "T. Nagar". */
  zone_label?: string | null;
  /** v2 (crew pending_offer only). */
  offered_at?: string | null;
  offer_expires_at?: string | null;
  distance_km?: number | null;
}

export interface CreateRequestBody {
  client_uuid?: string;
  lat: number;
  lng: number;
  address?: string;
  incident_type: string;
  severity: number;
  notes?: string;
  caller_name?: string;
  caller_phone?: string;
  channel?: string;
  patient_age_group?: 'child' | 'adult' | 'senior' | 'elderly' | 'unknown';
}

/* ---------------------------------------------------------------- v2 tracking (API_CONTRACT_V2 §2) */

export type RoutePhase = 'to_patient' | 'to_hospital';
export interface TimelineEvent { status: string; at: string; note?: string | null }

/** Remaining leg from the ambulance's current position. */
export interface TrackingRoute { phase: RoutePhase | null; polyline: LatLng[]; distance_km: number; eta_seconds: number }
export interface CrewContact { name: string; phone?: string | null; initials: string }
export interface ShareLink { token: string; url: string }
export interface BillSummary { id: number; amount: number; payment_status: string; insurance_claim_status?: string | null }
export interface Feedback { rating: number; comment?: string | null }

export interface TrackingAmbulance {
  id: number; registration_number: string; lat: number; lng: number; status: string; updated_at?: string;
  kind?: string; heading_deg?: number | null;
}
export interface TrackingHospital {
  id: number; name: string; lat: number; lng: number;
  address?: string | null; available_beds?: number | null; available_icu?: number | null;
  reserved?: 'bed' | 'icu' | null; phone?: string | null;
}

export interface Tracking {
  request: RequestOut;
  ambulance: TrackingAmbulance | null;
  hospital: TrackingHospital | null;
  eta_seconds: number | null;
  path: LatLng[];
  // v2 (optional until the backend upgrade lands)
  route?: TrackingRoute | null;
  crew?: CrewContact | null;
  timeline?: TimelineEvent[];
  share?: ShareLink | null;
  bill?: BillSummary | null;
  feedback?: Feedback | null;
}

/** `GET /public/track/{token}` — family share page (no auth, no PII). */
export interface PublicTracking {
  status: string;
  timeline: TimelineEvent[];
  ambulance: { registration_number: string; lat: number; lng: number; heading_deg?: number | null } | null;
  eta_seconds: number | null;
  route: TrackingRoute | null;
  hospital: { name: string; lat: number; lng: number } | null;
  patient_area: { lat: number; lng: number; label?: string | null } | string | null;
}

export interface FeedbackBody { rating: number; comment?: string }

/* ---------------------------------------------------------------- crew route (v2 §1) */

export interface Maneuver { type: string; modifier?: string | null }
export interface RouteStep {
  instruction: string; lat: number; lng: number; distance_m: number;
  // v2
  name?: string | null; maneuver?: Maneuver | null; duration_s?: number | null;
}
export interface RouteOut {
  phase: RoutePhase; steps: RouteStep[]; polyline: LatLng[]; distance_km: number; eta_seconds: number;
  bearing_deg?: number | null;
}

export interface AmbulanceBrief {
  id: number; registration_number: string; kind?: string; status: string;
  lat?: number | null; lng?: number | null; station_id?: number | null; station_name?: string | null; location_age_s?: number | null;
  // v2 (controller board)
  heading_deg?: number | null; crew_name?: string | null; request_id?: number | null;
}
export interface StationBrief { id: number; name: string; lat: number; lng: number; address?: string; is_active?: boolean; hospital_id?: number }
export interface HospitalBrief {
  id: number; name: string; lat: number; lng: number; address?: string;
  available_beds?: number; total_beds?: number; available_icu?: number; total_icu?: number;
  /** Backend sends on-duty counts by speciality, e.g. {"cardiology": 2}. */
  specialists?: Record<string, number> | null; capacity_age_min?: number | null; capacity_updated_at?: string | null; stale?: boolean;
}

export interface CrewStatsToday { trips: number; distance_km: number; online_minutes: number }

export interface CrewMe {
  ambulance: AmbulanceBrief | null;
  station: StationBrief | null;
  /** v2: carries offered_at, offer_expires_at, distance_km, eta_seconds, zone_label. */
  pending_offer: RequestOut | null;
  active_trip: RequestOut | null;
  // v2
  stats_today?: CrewStatsToday | null;
  crew?: { name: string; initials: string } | null;
}

/** `GET /hospitals/{id}/incoming` item (v2 §7). */
export interface IncomingItem {
  request: RequestOut;
  eta_seconds: number | null;
  ambulance: { registration_number: string; kind?: string } | null;
  crew: { name: string; phone?: string | null } | null;
  reserved: 'bed' | 'icu' | null;
}

export interface Board {
  requests: RequestOut[];
  ambulances: AmbulanceBrief[];
  stations: StationBrief[];
  hospitals: HospitalBrief[];
  escalations: number[];
}

export interface Candidate {
  ambulance_id: number; registration_number?: string; kind?: string; eta_seconds?: number | null; rank?: number;
  distance_km?: number | null; station_name?: string; status?: string; [k: string]: unknown;
}

export interface RiskZone {
  zone_id: string | number; lat: number; lng: number; expected_demand: number; risk: number; zone_label?: string | null;
  households?: number | null; seniors?: number | null; senior_share?: number | null;
}
export interface RiskMap { hour: number; generated_at: string; model_version: string; demographics_source?: string | null; zones: RiskZone[] }

export interface Recommendation {
  id: number; status: string; [k: string]: unknown;
}

export interface Billing {
  id: number; trip_id: number; request_id: number; amount: number; base_fare: number; distance_charge: number;
  surcharge: number; hospital_share: number; platform_share: number; payment_status: string;
  insurance_claim_status?: string | null;
  claim?: { id: number; insurer?: string; policy_number?: string; status?: string; remarks?: string } | null;
}

export interface Dashboard {
  kpis: {
    avg_response_s: number; p90_response_s: number; avg_match_ms: number; requests_total: number; completed: number;
    completion_rate: number; avg_handover_s: number; fleet_utilisation_pct: number; redirect_avoided: number;
    /** v2 */
    avg_rating?: number | null;
  };
  response_by_day: { date: string; avg_s: number; count: number }[];
  by_incident: { type: string; count: number }[];
  stations: { id: number; name: string; utilisation_pct: number; ambulances: number; available: number; trips: number }[];
  hospitals: Record<string, unknown>[];
  prediction: { mae: number; r2: number; model_version: string };
  coverage_gaps: { zone_id: string | number; lat: number; lng: number; risk: number; nearest_ambulance_km: number; zone_label?: string | null }[];
  sla: { nfr1_target_s: number; within_target_pct: number };
}

export interface AuditEntry {
  id: number; action: string; entity?: string; entity_id?: string | number | null; actor_id?: number | null;
  actor_role?: string | null; created_at?: string; ts?: string; hash?: string; [k: string]: unknown;
}

export interface WsMessage<T = unknown> { type: string; data: T; ts?: string }

/* ---------------------------------------------------------------- places (v2 §8) */

/** `GET /geo/reverse?lat&lng` */
export interface ReversePlace { label: string; locality?: string | null; address?: string | null }
/** `GET /geo/search?q=` item */
export interface PlaceResult { label: string; lat: number; lng: number }

/* ---------------------------------------------------------------- client config (GET /public/config) */

export interface DemoAccount { role: Role; label: string; email: string; hint: string }
export interface ClientConfig { demo_mode: boolean; demo_password: string | null; demo_accounts: DemoAccount[] }
