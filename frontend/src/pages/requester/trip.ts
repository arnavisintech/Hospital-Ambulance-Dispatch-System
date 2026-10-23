/**
 * Pure trip-state logic shared by the requester tracking screen and the public family-share page.
 * Kept free of React so it can be unit-tested (src/test/trip.test.ts).
 */
import { fmtArrival, fmtEta } from '../../lib/format';
import { requestStatusMeta, type Tone } from '../../lib/status';
import type { LatLng, TimelineEvent, TrackingRoute, WsMessage } from '../../lib/types';

/* ------------------------------------------------------------------ phase of the screen */

export type TripStage = 'searching' | 'live' | 'completed' | 'cancelled';

/** Which top-level screen a request status belongs to. Unknown statuses are treated as live (degrade gracefully). */
export function tripStage(status: string): TripStage {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled' || status === 'failed') return 'cancelled';
  if (requestStatusMeta(status).searching) return 'searching';
  return 'live';
}

/** The requester may cancel until the patient is on board (backend: 409 for transporting/arrived/terminal). */
export function isCancellable(status: string): boolean {
  return !['transporting', 'arrived', 'completed', 'cancelled', 'failed'].includes(status);
}

/* ------------------------------------------------------------------ headline */

export interface Headline {
  title: string;
  subtitle: string;
  tone: Tone;
}

/** Remaining-leg ETA: live route first, then the tracking / request ETA. */
export function pickEta(...candidates: (number | null | undefined)[]): number | null {
  for (const c of candidates) if (typeof c === 'number' && Number.isFinite(c) && c >= 0) return c;
  return null;
}

/**
 * Big sheet headline for the current status, e.g. "Arriving in 4 min", "Reached you",
 * "On the way to Apollo Greams Road".
 */
export function tripHeadline(status: string, eta: number | null, hospitalName?: string | null): Headline {
  const m = requestStatusMeta(status);
  const hosp = hospitalName || 'the hospital';
  switch (status) {
    case 'received':
    case 'matching':
      return { title: 'Finding the nearest ambulance…', subtitle: 'Matching by real driving time', tone: m.tone };
    case 'offered':
      return { title: 'Ambulance found', subtitle: 'Waiting for the crew to confirm', tone: m.tone };
    case 'awaiting_manual':
      return { title: 'Our control room is on it', subtitle: 'A dispatcher is assigning an ambulance now', tone: m.tone };
    case 'accepted':
      return { title: fmtArrival(eta), subtitle: 'Ambulance assigned and getting ready', tone: 'info' };
    case 'en_route':
      return { title: fmtArrival(eta), subtitle: 'Ambulance is on the way to you', tone: 'info' };
    case 'on_scene':
      return { title: 'Reached you', subtitle: 'The crew is with the patient', tone: 'violet' };
    case 'transporting':
      return { title: `On the way to ${hosp}`, subtitle: eta !== null ? `Reaching in ${fmtEta(eta)}` : 'Heading to hospital', tone: 'orange' };
    case 'arrived':
      return { title: `Reached ${hosp}`, subtitle: 'Handing over to the hospital team', tone: 'teal' };
    case 'completed':
      return { title: 'Trip complete', subtitle: `Patient handed over at ${hosp}`, tone: 'success' };
    case 'cancelled':
      return { title: 'Request cancelled', subtitle: 'No ambulance is coming for this request', tone: 'muted' };
    case 'failed':
      return { title: "We couldn't complete this request", subtitle: 'Please call 108 if you still need help', tone: 'muted' };
    default:
      return { title: m.headline, subtitle: '', tone: m.tone };
  }
}

/* ------------------------------------------------------------------ live overlay from WebSocket */

/** Fields a WS push may update between REST fetches; merged over the fetched payload. */
export interface LiveOverlay {
  ambulance?: { lat: number; lng: number; heading?: number | null };
  eta?: number | null;
  route?: TrackingRoute | null;
  status?: string;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Fold a WebSocket message into the overlay. Returns the new overlay and whether a full REST refetch is needed
 * (status changes, destination confirmed, trip closed…).
 */
export function applyLiveEvent(prev: LiveOverlay, msg: WsMessage): { overlay: LiveOverlay; refetch: boolean } {
  const d = (msg.data ?? {}) as Record<string, unknown>;
  switch (msg.type) {
    case 'ambulance.location': {
      if (!num(d.lat) || !num(d.lng)) return { overlay: prev, refetch: false };
      const next: LiveOverlay = { ...prev, ambulance: { lat: d.lat, lng: d.lng, heading: num(d.heading_deg) ? d.heading_deg : prev.ambulance?.heading ?? null } };
      if (num(d.eta_seconds)) {
        next.eta = d.eta_seconds;
        if (prev.route) next.route = { ...prev.route, eta_seconds: d.eta_seconds };
      }
      return { overlay: next, refetch: false };
    }
    case 'request.route': {
      const poly = Array.isArray(d.polyline) ? (d.polyline as LatLng[]) : null;
      if (!poly) return { overlay: prev, refetch: true };
      const route: TrackingRoute = {
        phase: (d.phase as TrackingRoute['phase']) ?? null,
        polyline: poly,
        distance_km: num(d.distance_km) ? d.distance_km : 0,
        eta_seconds: num(d.eta_seconds) ? d.eta_seconds : 0,
      };
      return { overlay: { ...prev, route, eta: num(d.eta_seconds) ? d.eta_seconds : prev.eta }, refetch: false };
    }
    case 'request.status':
      return { overlay: { ...prev, status: typeof d.status === 'string' ? d.status : prev.status }, refetch: true };
    case 'subscribed':
    case 'pong':
      return { overlay: prev, refetch: false };
    default:
      // destination.confirmed, trip.closed, dispatch.escalated and anything new: just reload.
      return { overlay: prev, refetch: true };
  }
}

/* ------------------------------------------------------------------ completed summary */

const ts = (iso?: string | null) => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

/** First time a status was reached according to the timeline. */
export function reachedAt(timeline: TimelineEvent[] | undefined, status: string): string | null {
  const evs = (timeline ?? []).filter((e) => e.status === status).sort((a, b) => (ts(a.at) ?? 0) - (ts(b.at) ?? 0));
  return evs[0]?.at ?? null;
}

export interface TripTimes {
  requestedAt: string | null;
  assignedAt: string | null;
  reachedPatientAt: string | null;
  pickedUpAt: string | null;
  atHospitalAt: string | null;
  completedAt: string | null;
  /** Request → ambulance at the patient (the headline "response time"), seconds. */
  responseS: number | null;
  /** Request → handover, seconds. */
  totalS: number | null;
}

export function tripTimes(req: { created_at: string; accepted_at?: string | null; completed_at?: string | null }, timeline?: TimelineEvent[]): TripTimes {
  const requestedAt = req.created_at ?? reachedAt(timeline, 'received');
  const assignedAt = req.accepted_at ?? reachedAt(timeline, 'accepted');
  const reachedPatientAt = reachedAt(timeline, 'on_scene');
  const completedAt = req.completed_at ?? reachedAt(timeline, 'completed');
  const diff = (a: string | null, b: string | null) => {
    const x = ts(a), y = ts(b);
    return x !== null && y !== null && y >= x ? Math.round((y - x) / 1000) : null;
  };
  return {
    requestedAt,
    assignedAt,
    reachedPatientAt,
    pickedUpAt: reachedAt(timeline, 'transporting'),
    atHospitalAt: reachedAt(timeline, 'arrived'),
    completedAt,
    responseS: diff(requestedAt, reachedPatientAt),
    totalS: diff(requestedAt, completedAt),
  };
}

/** "UPI" / "Card" / "Cash" → backend method (letters/underscore/space only). */
export const PAY_METHODS = [
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
  { value: 'cash', label: 'Cash' },
] as const;
