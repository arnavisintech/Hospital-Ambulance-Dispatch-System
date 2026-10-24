/** Display formatting. Pure functions; `now` params exist for deterministic tests. Pair numbers with `tabular-nums`. */

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** ETA chip text: "<1 min", "4 min", "1 h 5 min", "--" when unknown. Rounds UP (never promise too early). */
export function fmtEta(sec?: number | null): string {
  if (!isNum(sec) || sec < 0) return '--';
  if (sec < 60) return '<1 min';
  const m = Math.ceil(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** Consumer headline: "Arriving in 4 min", "Arriving now" (< 45 s), "Arriving soon" when ETA unknown. */
export function fmtArrival(sec?: number | null, verb = 'Arriving'): string {
  if (!isNum(sec) || sec < 0) return `${verb} soon`;
  if (sec < 45) return `${verb} now`;
  return `${verb} in ${fmtEta(sec)}`;
}

/** Elapsed duration for KPIs/timers: "45 s", "6 min 20 s", "1 h 4 min". */
export function fmtDuration(sec?: number | null): string {
  if (!isNum(sec) || sec < 0) return '--';
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60;
    return r ? `${m} min ${r} s` : `${m} min`;
  }
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}
/** @deprecated legacy alias */
export const fmtDur = fmtDuration;

/** Stopwatch "04:07" / "1:02:09" for live timers. */
export function fmtClockTimer(sec?: number | null): string {
  if (!isNum(sec) || sec < 0) return '--:--';
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = String(m).padStart(2, '0'), ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const parse = (iso?: string | number | Date | null): number | null => {
  if (iso === null || iso === undefined || iso === '') return null;
  const t = iso instanceof Date ? iso.getTime() : new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * Relative time: "just now", "2 min ago", "3 h ago", "Yesterday", "4 d ago", then "12 Oct" (same year) / "12 Oct 2025".
 * Future times: "in 5 min".
 */
export function fmtRelative(iso?: string | number | Date | null, now: number = Date.now()): string {
  const t = parse(iso);
  if (t === null) return '--';
  const diff = Math.round((now - t) / 1000);
  if (diff < 0) {
    const f = -diff;
    if (f < 45) return 'in a moment';
    if (f < 3600) return `in ${Math.round(f / 60)} min`;
    if (f < 86400) return `in ${Math.round(f / 3600)} h`;
    return fmtDate(t);
  }
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 172800) return 'Yesterday';
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)} d ago`;
  return fmtDate(t, now);
}

/** "12 Oct" (current year) or "12 Oct 2025". */
export function fmtDate(iso?: string | number | Date | null, now: number = Date.now()): string {
  const t = parse(iso);
  if (t === null) return '--';
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** Wall-clock time "4:05 pm". */
export function fmtClock(iso?: string | number | Date | null): string {
  const t = parse(iso);
  if (t === null) return '--';
  return new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
}

/** Full timestamp "12 Oct, 4:05 pm". */
export function fmtTime(iso?: string | number | Date | null): string {
  const t = parse(iso);
  if (t === null) return '--';
  return `${fmtDate(t)}, ${fmtClock(t)}`;
}

/** Minutes since an ISO timestamp (null if missing). */
export function ageMin(iso?: string | null, now: number = Date.now()): number | null {
  const t = parse(iso);
  return t === null ? null : Math.max(0, (now - t) / 60000);
}

/** "just now" / "5 min ago" from an age in minutes. */
export function fmtAge(min?: number | null): string {
  if (!isNum(min)) return 'never';
  if (min < 1) return 'just now';
  if (min < 60) return `${Math.round(min)} min ago`;
  if (min < 1440) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** "₹1,25,000" / "₹1,250.5" (Indian digit grouping). */
export function fmtMoney(n?: number | null): string {
  if (!isNum(n)) return '--';
  return INR.format(n).replace(/\s/g, ''); // \s also covers NBSP / narrow NBSP from Intl
}

/** Distance from km: "850 m", "4.2 km", "12 km". */
export function fmtDistance(km?: number | null): string {
  if (!isNum(km) || km < 0) return '--';
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  if (km < 10) return `${(Math.round(km * 10) / 10).toFixed(1)} km`;
  return `${Math.round(km)} km`;
}
/** Distance from metres. */
export const fmtMeters = (m?: number | null) => fmtDistance(isNum(m) ? m / 1000 : null);

/** Integer with Indian grouping "1,25,000". */
export function fmtNumber(n?: number | null, maxFrac = 0): string {
  return isNum(n) ? n.toLocaleString('en-IN', { maximumFractionDigits: maxFrac }) : '--';
}

/** Percent: accepts a 0..1 ratio or 0..100 value. "87.5%". */
/** Format a percentage. Scale is explicit: guessing from magnitude mis-reads small values (0.8% vs 80%). */
export function pct(n?: number | null, digits = 1, scale: 'ratio' | 'percent' = 'ratio'): string {
  if (!isNum(n)) return '--';
  return `${(scale === 'ratio' ? n * 100 : n).toFixed(digits)}%`;
}

/** "awaiting_manual" -> "Awaiting Manual". */
export function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Initials for avatars: "Priya Raman" -> "PR", "admin@hads.in" -> "A". */
export function initials(name?: string | null): string {
  const clean = (name ?? '').replace(/@.*/, '').trim();
  if (!clean) return '?';
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Indian phone display "+91 98400 12345" (best effort; leaves other formats untouched). */
export function fmtPhone(p?: string | null): string {
  if (!p) return '--';
  const d = p.replace(/\D/g, '');
  const local = d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 10 ? d : null;
  return local ? `+91 ${local.slice(0, 5)} ${local.slice(5)}` : p;
}

// Back-compat: geo helpers used to live here.
export { CHENNAI, haversineKm } from './geo';

/** 0..1 share as a whole percent ("14%"); "-" when unknown. */
export function fmtShare(x?: number | null): string {
  return x === null || x === undefined || Number.isNaN(x) ? '-' : `${Math.round(x * 100)}%`;
}

/** "4,210 households · 14% aged 60+" for a zone with demographics, otherwise null. */
export function demographicsLine(z: { households?: number | null; senior_share?: number | null }): string | null {
  if (!z.households) return null;
  return `${fmtNumber(z.households)} households · ${fmtShare(z.senior_share)} aged 60+`;
}
