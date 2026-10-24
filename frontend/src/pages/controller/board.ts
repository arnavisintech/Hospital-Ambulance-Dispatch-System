/**
 * Pure state logic for the dispatch console: WS event reducer, sorting, KPIs.
 * Kept free of React so it can be unit-tested (src/pages/controller/board.test.ts).
 */
import { requestStatusMeta } from '../../lib/status';
import type { AmbulanceBrief, Board, HospitalBrief, LatLng, RequestOut, RoutePhase, StationBrief, TrackingRoute, WsMessage } from '../../lib/types';

/** Board station as returned by GET /controller/board (adds per-station fleet counts). */
export interface BoardStation extends StationBrief { ambulances?: number; available?: number }

/** Board plus live route legs keyed by request id (from GET tracking + WS `request.route`). */
export interface LiveBoard {
  board: Board;
  routes: Record<number, TrackingRoute>;
}

export const TERMINAL = new Set(['completed', 'cancelled', 'failed']);

/** Statuses for which the unit is driving a leg we draw on the map. */
export const ROUTED = new Set(['accepted', 'en_route', 'transporting']);

export const isTerminal = (s: string) => TERMINAL.has(s);

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface ReduceResult {
  state: LiveBoard;
  /** Event referenced something we don't know (new request etc.) — refetch the board. */
  reload: boolean;
  /** Request id that just escalated (for alerts). */
  escalated?: number;
}

function patchRequest(b: Board, id: number, fn: (r: RequestOut) => RequestOut): Board | null {
  const i = b.requests.findIndex((r) => r.id === id);
  if (i < 0) return null;
  const requests = b.requests.slice();
  requests[i] = fn(requests[i]);
  return { ...b, requests };
}

function dropRequest(s: LiveBoard, id: number): LiveBoard {
  const routes = { ...s.routes };
  delete routes[id];
  return {
    board: { ...s.board, requests: s.board.requests.filter((r) => r.id !== id), escalations: s.board.escalations.filter((e) => e !== id) },
    routes,
  };
}

/** Apply one WS message from the `controller` topic. Unknown message types are ignored. */
export function reduceBoard(state: LiveBoard, msg: WsMessage): ReduceResult {
  const d = (msg.data ?? {}) as Record<string, unknown>;
  const b = state.board;
  const reqId = num(d.request_id);

  switch (msg.type) {
    case 'ambulance.location': {
      const id = num(d.ambulance_id), lat = num(d.lat), lng = num(d.lng);
      if (id === undefined || lat === undefined || lng === undefined) return { state, reload: false };
      const i = b.ambulances.findIndex((a) => a.id === id);
      if (i < 0) return { state, reload: true };
      const ambulances = b.ambulances.slice();
      const prev = ambulances[i];
      ambulances[i] = {
        ...prev, lat, lng, location_age_s: 0,
        heading_deg: num(d.heading_deg) ?? prev.heading_deg,
        status: typeof d.status === 'string' ? d.status : prev.status,
        request_id: reqId ?? prev.request_id,
      };
      let board: Board = { ...b, ambulances };
      const eta = num(d.eta_seconds);
      if (reqId !== undefined && eta !== undefined) board = patchRequest(board, reqId, (r) => ({ ...r, eta_seconds: eta })) ?? board;
      return { state: { ...state, board }, reload: false };
    }

    case 'ambulance.status': { // hospital staff took a unit out of / back into service
      const id = num(d.ambulance_id);
      const i = id === undefined ? -1 : b.ambulances.findIndex((a) => a.id === id);
      if (i < 0 || typeof d.status !== 'string') return { state, reload: true };
      const ambulances = b.ambulances.slice();
      ambulances[i] = { ...ambulances[i], status: d.status };
      return { state: { ...state, board: { ...b, ambulances } }, reload: false };
    }

    case 'request.status': {
      if (reqId === undefined) return { state, reload: true };
      const status = typeof d.status === 'string' ? d.status : undefined;
      if (status && isTerminal(status)) return { state: dropRequest(state, reqId), reload: false };
      const known = b.requests.some((r) => r.id === reqId);
      if (!known) return { state, reload: true };
      const ambId = num(d.ambulance_id);
      const assignedChanged = ambId !== undefined && b.requests.find((r) => r.id === reqId)?.ambulance?.id !== ambId;
      const hospChanged = num(d.destination_hospital_id) !== undefined
        && b.requests.find((r) => r.id === reqId)?.destination_hospital?.id !== num(d.destination_hospital_id);
      let board = patchRequest(b, reqId, (r) => ({
        ...r,
        status: status ?? r.status,
        eta_seconds: d.eta_seconds === null ? null : num(d.eta_seconds) ?? r.eta_seconds,
        timeline: status && status !== r.status ? [...(r.timeline ?? []), { status, at: msg.ts ?? new Date().toISOString() }] : r.timeline,
      }))!;
      const escalations = status === 'awaiting_manual'
        ? (board.escalations.includes(reqId) ? board.escalations : [...board.escalations, reqId])
        : board.escalations.filter((e) => e !== reqId);
      board = { ...board, escalations };
      // Newly assigned unit / hospital: fetch the authoritative row (registration number, names).
      return { state: { ...state, board }, reload: assignedChanged || hospChanged };
    }

    case 'dispatch.escalated': {
      if (reqId === undefined) return { state, reload: true };
      const known = b.requests.some((r) => r.id === reqId);
      const board0 = known ? patchRequest(b, reqId, (r) => ({ ...r, status: 'awaiting_manual' }))! : b;
      const board = { ...board0, escalations: board0.escalations.includes(reqId) ? board0.escalations : [...board0.escalations, reqId] };
      return { state: { ...state, board }, reload: !known, escalated: reqId };
    }

    case 'request.route': {
      if (reqId === undefined || !Array.isArray(d.polyline)) return { state, reload: false };
      const route: TrackingRoute = {
        phase: (d.phase as RoutePhase | null) ?? null,
        polyline: d.polyline as LatLng[],
        distance_km: num(d.distance_km) ?? 0,
        eta_seconds: num(d.eta_seconds) ?? 0,
      };
      const eta = num(d.eta_seconds);
      const board = eta !== undefined ? patchRequest(b, reqId, (r) => ({ ...r, eta_seconds: eta })) ?? b : b;
      return { state: { board, routes: { ...state.routes, [reqId]: route } }, reload: false };
    }

    case 'capacity.updated': {
      const id = num(d.id);
      if (id === undefined) return { state, reload: false };
      const hospitals = b.hospitals.map((h): HospitalBrief => h.id !== id ? h : {
        ...h,
        available_beds: num(d.available_beds) ?? h.available_beds,
        available_icu: num(d.available_icu) ?? h.available_icu,
        total_beds: num(d.total_beds) ?? h.total_beds,
        total_icu: num(d.total_icu) ?? h.total_icu,
        stale: typeof d.stale === 'boolean' ? d.stale : false,
        capacity_age_min: 0,
        capacity_updated_at: typeof d.capacity_updated_at === 'string' ? d.capacity_updated_at : h.capacity_updated_at,
      });
      return { state: { ...state, board: { ...b, hospitals } }, reload: false };
    }

    case 'trip.closed':
      return reqId === undefined ? { state, reload: true } : { state: dropRequest(state, reqId), reload: true };

    case 'request.created':
    case 'destination.confirmed':
      return { state, reload: true };

    default:
      return { state, reload: false };
  }
}

/* ------------------------------------------------------------------ sorting & selectors */

const ts = (iso?: string | null) => { const t = iso ? new Date(iso).getTime() : NaN; return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t; };

/** Escalation queue order: most severe first, then the longest waiting (oldest) first, then id. */
export function sortEscalations(list: RequestOut[]): RequestOut[] {
  return list.slice().sort((a, b) => (b.severity - a.severity) || (ts(a.created_at) - ts(b.created_at)) || (a.id - b.id));
}

/**
 * Active list order: escalations pinned on top, then requests still being matched, then live trips;
 * within a group most severe first, then oldest.
 */
export function sortActive(list: RequestOut[], escalations: number[]): RequestOut[] {
  const esc = new Set(escalations);
  const group = (r: RequestOut) => (esc.has(r.id) || r.status === 'awaiting_manual' ? 0 : requestStatusMeta(r.status).searching ? 1 : 2);
  return list.slice().sort((a, b) => (group(a) - group(b)) || (b.severity - a.severity) || (ts(a.created_at) - ts(b.created_at)) || (a.id - b.id));
}

/** Requests in the escalation queue (falls back to status when `escalations` lags). */
export function escalatedRequests(b: Board): RequestOut[] {
  const ids = new Set(b.escalations);
  return sortEscalations(b.requests.filter((r) => ids.has(r.id) || r.status === 'awaiting_manual'));
}

export interface Kpis { active: number; available: number; fleet: number; avgMatchMs: number | null; escalations: number }

export function boardKpis(b: Board): Kpis {
  const online = b.ambulances.filter((a) => !['offline', 'maintenance'].includes(a.status));
  const matched = b.requests.map((r) => r.match_duration_ms).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return {
    active: b.requests.length,
    available: b.ambulances.filter((a) => a.status === 'available').length,
    fleet: online.length,
    avgMatchMs: matched.length ? Math.round(matched.reduce((s, v) => s + v, 0) / matched.length) : null,
    escalations: escalatedRequests(b).length,
  };
}

/** Seconds since the request was created (age timer). */
export function ageSeconds(r: Pick<RequestOut, 'created_at'>, now: number): number | null {
  const t = new Date(r.created_at).getTime();
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / 1000);
}

/** The board ambulance serving a request (by request.ambulance.id, else ambulance.request_id). */
export function ambulanceFor(b: Board, r: RequestOut): AmbulanceBrief | undefined {
  return b.ambulances.find((a) => (r.ambulance?.id !== undefined ? a.id === r.ambulance.id : a.request_id === r.id));
}

/** Fleet filter buckets. */
export type FleetFilter = 'all' | 'available' | 'busy' | 'offline';
export function fleetBucket(status: string): Exclude<FleetFilter, 'all'> {
  if (status === 'available' || status === 'returning') return 'available';
  if (status === 'offline' || status === 'maintenance') return 'offline';
  return 'busy';
}

/** GPS fix older than this is flagged in the fleet list. */
export const STALE_FIX_S = 180;
