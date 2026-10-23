/** Pure helpers for the hospital desk (tested in capacity.test.ts). */
import type { RequestOut } from '../../lib/types';
import type { Tone } from '../../lib/status';

/** Occupancy (0..1) from available / total; null when total unknown. */
export function occupancy(available?: number | null, total?: number | null): number | null {
  if (typeof total !== 'number' || total <= 0 || typeof available !== 'number') return null;
  return Math.min(1, Math.max(0, 1 - available / total));
}

/**
 * Gauge colour by occupancy: < 70 % success, 70–<90 % warning, >= 90 % danger (or nothing free).
 * Unknown → muted.
 */
export function occupancyTone(available?: number | null, total?: number | null): Tone {
  const o = occupancy(available, total);
  if (o === null) return 'muted';
  if (o >= 0.9 || (available ?? 0) <= 0) return 'danger';
  if (o >= 0.7) return 'warning';
  return 'success';
}

/** Normalise `specialists` (v2 dict name→count; legacy list/string) into a name→count map. */
export function specialistsMap(s: unknown): Record<string, number> {
  if (s && typeof s === 'object' && !Array.isArray(s)) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
      const n = Number(v);
      out[k] = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
    }
    return out;
  }
  if (Array.isArray(s)) return Object.fromEntries(s.filter((x) => typeof x === 'string' && x).map((k) => [k, 1]));
  if (typeof s === 'string' && s.trim()) return Object.fromEntries(s.split(',').map((x) => x.trim()).filter(Boolean).map((k) => [k, 1]));
  return {};
}

export interface CapacityDraft { beds: number; icu: number; specialists: Record<string, number> }

/** Human-readable change list for the save confirmation / audit note: ["Beds 12 → 10", …]. */
export function capacityDiff(before: CapacityDraft, after: CapacityDraft, label: (k: string) => string = (k) => k): string[] {
  const out: string[] = [];
  if (before.beds !== after.beds) out.push(`Beds ${before.beds} → ${after.beds}`);
  if (before.icu !== after.icu) out.push(`ICU ${before.icu} → ${after.icu}`);
  const keys = new Set([...Object.keys(before.specialists), ...Object.keys(after.specialists)]);
  keys.forEach((k) => {
    const a = before.specialists[k] ?? 0, b = after.specialists[k] ?? 0;
    if (a !== b) out.push(`${label(k)} ${a} → ${b}`);
  });
  return out;
}

/** Normalised incoming patient (v2 item or bare v1 RequestOut). */
export interface Incoming {
  request: RequestOut;
  eta_seconds: number | null;
  ambulance: { registration_number: string; kind?: string } | null;
  crew: { name: string; phone?: string | null; initials?: string } | null;
  reserved: 'bed' | 'icu' | null;
  acknowledged: boolean;
}

export function normalizeIncoming(x: unknown): Incoming | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const req = (o.request && typeof o.request === 'object' ? o.request : o) as RequestOut;
  if (typeof req.id !== 'number') return null;
  const amb = (o.ambulance ?? req.ambulance ?? null) as Incoming['ambulance'];
  const eta = typeof o.eta_seconds === 'number' ? o.eta_seconds : typeof req.eta_seconds === 'number' ? req.eta_seconds : null;
  return {
    request: req,
    eta_seconds: eta,
    ambulance: amb && amb.registration_number ? amb : null,
    crew: (o.crew as Incoming['crew']) ?? null,
    reserved: o.reserved === 'bed' || o.reserved === 'icu' ? o.reserved : null,
    acknowledged: o.acknowledged === true,
  };
}

export function normalizeIncomingList(x: unknown): Incoming[] {
  const arr = Array.isArray(x) ? x : x && typeof x === 'object' && Array.isArray((x as { items?: unknown }).items) ? (x as { items: unknown[] }).items : [];
  return arr.map(normalizeIncoming).filter((i): i is Incoming => !!i);
}

/** Arrived first (needs handover), then soonest ETA (unknown last), then most severe. */
export function sortIncoming(list: Incoming[]): Incoming[] {
  const rank = (i: Incoming) => (i.request.status === 'arrived' ? -1 : i.eta_seconds ?? Number.MAX_SAFE_INTEGER);
  return list.slice().sort((a, b) => (rank(a) - rank(b)) || (b.request.severity - a.request.severity) || (a.request.id - b.request.id));
}

/** Remaining seconds from an ETA snapshot taken at `at` (ms). */
export const etaRemaining = (eta: number | null, at: number, now: number): number | null =>
  eta === null ? null : Math.max(0, eta - (now - at) / 1000);
