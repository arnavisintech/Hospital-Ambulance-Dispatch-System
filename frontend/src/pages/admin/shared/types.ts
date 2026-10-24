/**
 * Response shapes used by the admin / authority consoles, matching backend routers (dashboard, admin, billing,
 * audit, analytics). Every field the backend may omit or null is optional/nullable so v1 and v2 servers both work.
 */
import type { Role } from '../../../lib/types';

export interface DashKpis {
  avg_response_s?: number | null;
  p90_response_s?: number | null;
  avg_match_ms?: number | null;
  requests_total?: number | null;
  completed?: number | null;
  /** 0..1 */
  completion_rate?: number | null;
  avg_handover_s?: number | null;
  /** 0..100 */
  fleet_utilisation_pct?: number | null;
  /** 0..100 (v2) */
  fleet_busy_now_pct?: number | null;
  redirect_avoided?: number | null;
  avg_rating?: number | null;
  ratings_count?: number | null;
}

export interface DashStation { id: number; name: string; utilisation_pct: number; ambulances: number; available: number; trips: number }

export interface DashHospital {
  id: number; name: string;
  available_beds?: number | null; total_beds?: number | null; available_icu?: number | null; total_icu?: number | null;
  bed_occupancy_pct?: number | null; trips_received?: number | null; capacity_age_min?: number | null; stale?: boolean;
}

export interface CoverageGap {
  zone_id: string | number; lat: number; lng: number; risk: number;
  nearest_ambulance_km?: number | null; zone_label?: string | null;
  households?: number | null; senior_share?: number | null;
}

export interface DashSummary {
  days?: number;
  generated_at?: string;
  kpis: DashKpis;
  response_by_day: { date: string; avg_s: number | null; count: number }[];
  by_incident: { type: string; count: number }[];
  stations: DashStation[];
  hospitals: DashHospital[];
  prediction?: { mae?: number | null; r2?: number | null; model_version?: string | null } | null;
  coverage_gaps: CoverageGap[];
  sla?: { nfr1_target_s?: number | null; within_target_pct?: number | null } | null;
}

export interface ModelInfo {
  model_version: string | null; mae: number | null; r2: number | null; n_train?: number; n_live?: number;
  trained_at: string | null; history?: { model_version: string; mae: number | null; r2: number | null; trained_at: string }[];
}

export interface AdminHospital {
  id: number; name: string; address?: string | null; lat: number; lng: number;
  total_beds?: number; available_beds?: number; total_icu?: number; available_icu?: number;
  /** Backend: {"cardiology": 3, ...}; older servers may send a list or string. */
  specialists?: Record<string, number> | string[] | string | null;
  revenue_share_pct?: number | null; partner_verified?: boolean; stations?: number | null; is_active?: boolean;
  registration_number?: string | null; verified_at?: string | null;
}

export interface AdminStation {
  id: number; hospital_id: number; hospital_name?: string | null; name: string; address?: string | null;
  lat: number; lng: number; is_active?: boolean; ambulances?: number; available?: number;
}

export interface AdminUser {
  id: number; name: string; email?: string | null; phone?: string | null; role: Role; is_active?: boolean;
  created_at?: string | null; hospital_id?: number | null; ambulance_id?: number | null; license_number?: string | null;
}

export interface Claim {
  id: number; bill_id?: number; insurer?: string; policy_number?: string; amount_claimed?: number;
  status?: string; remarks?: string | null; submitted_at?: string | null; updated_at?: string | null;
}

export interface Bill {
  id: number; trip_id: number; request_id: number | null; hospital_id?: number | null;
  amount: number; base_fare: number; distance_charge: number; surcharge: number;
  hospital_share: number; platform_share: number; payment_status: string;
  insurance_claim_status?: string | null; created_at?: string | null; claim?: Claim | null;
}

export interface AuditItem {
  id: number; ts?: string; user_id?: number | null; action: string; entity?: string | null;
  entity_id?: string | number | null; details?: unknown; prev_hash?: string | null; hash?: string | null;
}
export interface AuditPage { total: number; limit: number; offset: number; items: AuditItem[] }
export interface AuditVerify { ok: boolean; checked: number; broken_at: number | null }
