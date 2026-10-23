/**
 * Pure, testable logic for the admin + authority consoles: date ranges, percent scaling, CSV export,
 * bulk fleet parsing (FR12), insurance-claim transitions (FR10) and platform-setting validation.
 * No React, no DOM (except `downloadCsv`).
 */

/* ------------------------------------------------------------------ date range */

export type RangeKey = '24h' | '7d' | '30d';

export const RANGE_ITEMS: { value: RangeKey; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

const RANGE_DAYS: Record<RangeKey, number> = { '24h': 1, '7d': 7, '30d': 30 };

/** `GET /dashboard/summary?days=` value for a range control key. Unknown keys fall back to 7. */
export function rangeToDays(r: string): number {
  return RANGE_DAYS[r as RangeKey] ?? 7;
}

export function rangeLabel(r: string): string {
  return r === '24h' ? 'Last 24 hours' : `Last ${rangeToDays(r)} days`;
}

/* ------------------------------------------------------------------ numbers */

const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Percent with an explicit scale (unlike lib/format `pct`, which guesses and turns 0.8 % into 80 %).
 * `ratio` = 0..1, `pct` = 0..100.
 */
export function fmtPercent(n: number | null | undefined, scale: 'ratio' | 'pct', digits = 1): string {
  if (!isNum(n)) return '--';
  const v = scale === 'ratio' ? n * 100 : n;
  return `${v.toFixed(digits)}%`;
}

/** Percentage (0..100) clamped for bar widths. */
export const clampPct = (n: number | null | undefined) => (isNum(n) ? Math.max(0, Math.min(100, n)) : 0);

/** "540 ms" / "1.2 s". */
export function fmtMs(ms: number | null | undefined): string {
  if (!isNum(ms)) return '--';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

/** Compact duration for KPI tiles: "7m 40s", "45s", "1h 4m". */
export function fmtDurShort(sec: number | null | undefined): string {
  if (!isNum(sec) || sec < 0) return '--';
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

const INR0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const INR2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Rupees: whole amounts without paise ("₹1,025"), otherwise always two decimals ("₹612.50"); `whole` rounds. */
export function fmtRupees(n: number | null | undefined, whole = false): string {
  if (!isNum(n)) return '--';
  const f = whole || Number.isInteger(Math.round(n * 100) / 100) ? INR0 : INR2;
  return f.format(whole ? Math.round(n) : n).replace(/\s/g, '');
}

/** Billing/claim status tones (lib/status generic map has no entry for these). */
export const BILLING_TONE: Record<string, 'success' | 'warning' | 'info' | 'danger' | 'muted' | 'violet'> = {
  paid: 'success', pending: 'warning', insurance_pending: 'info', waived: 'muted',
  submitted: 'info', under_review: 'violet', approved: 'success', settled: 'success', rejected: 'danger',
};

/** Clean minute ticks (0, 2m, 4m …) covering `max` seconds; 4–6 ticks. */
export function minuteTicks(maxS: number): number[] {
  const steps = [30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((st) => maxS / st <= 5) ?? 3600;
  const top = Math.max(step, Math.ceil((maxS * 1.1) / step) * step);
  return Array.from({ length: top / step + 1 }, (_, i) => i * step);
}
export const fmtTick = (s: number) => (s === 0 ? '0' : s < 60 ? `${s}s` : s % 60 ? `${(s / 60).toFixed(1)}m` : s >= 3600 && s % 3600 === 0 ? `${s / 3600}h` : `${s / 60}m`);

/* ------------------------------------------------------------------ CSV export */

export interface CsvColumn<T> { header: string; value: (row: T) => unknown }

/** RFC 4180 field escaping; also neutralises spreadsheet formula injection (=, +, -, @ at the start of text). */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => csvEscape(c.header)).join(',');
  const body = rows.map((r) => columns.map((c) => csvEscape(c.value(r))).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

/** Trigger a browser download (UTF-8 BOM so Excel opens ₹ and non-ASCII names correctly). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "stations-2026-10-14.csv" */
export const csvName = (base: string, now = new Date()) => `${base}-${now.toISOString().slice(0, 10)}.csv`;

/* ------------------------------------------------------------------ bulk fleet entry (FR12) */

/** Mirrors backend `onboarding.REG_RE` after normalisation (upper-case, single spaces). */
export const REG_RE = /^[A-Z0-9][A-Z0-9 -]{3,30}[A-Z0-9]$/;
export const MAX_BULK = 200;

export function normaliseReg(s: string): string {
  return s.trim().toUpperCase().replace(/\s+/g, ' ');
}

export interface FleetRow {
  /** 1-based source line number. */
  line: number;
  registration_number: string;
  kind: 'BLS' | 'ALS';
  staffed: boolean;
  errors: string[];
}

export interface FleetParse {
  rows: FleetRow[];
  valid: FleetRow[];
  invalidCount: number;
  /** Problems with the paste as a whole (e.g. too many rows). */
  errors: string[];
}

const TRUE = new Set(['', 'y', 'yes', 'true', '1', 'staffed']);
const FALSE = new Set(['n', 'no', 'false', '0', 'unstaffed']);

/**
 * Parse pasted fleet rows: one ambulance per line, `registration, kind, staffed` separated by comma, tab or
 * semicolon. kind defaults to BLS, staffed to yes. Blank lines and `#` comments are ignored, as is a header row.
 * `existing` = registration numbers already in the fleet (normalised) for duplicate detection.
 */
export function parseFleetText(text: string, existing: Iterable<string> = []): FleetParse {
  const known = new Set([...existing].map(normaliseReg));
  const seen = new Map<string, number>();
  const rows: FleetRow[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cells = line.split(/\t|;|,/).map((c) => c.trim());
    // Header row like "registration, kind, staffed" / "Reg no, type".
    if (rows.length === 0 && /^(registration|reg\.?\s*no\.?|reg)$/i.test(cells[0])) return;
    const errors: string[] = [];
    const reg = normaliseReg(cells[0] ?? '');
    if (!reg) errors.push('Registration number is missing');
    else if (!REG_RE.test(reg)) errors.push('Use 5–32 letters, digits, spaces or hyphens');

    const kindRaw = (cells[1] ?? '').toUpperCase();
    let kind: 'BLS' | 'ALS' = 'BLS';
    if (kindRaw === 'ALS' || kindRaw === 'ADVANCED') kind = 'ALS';
    else if (kindRaw && kindRaw !== 'BLS' && kindRaw !== 'BASIC') errors.push(`Type “${cells[1]}” must be BLS or ALS`);

    const stRaw = (cells[2] ?? '').toLowerCase();
    let staffed = true;
    if (FALSE.has(stRaw)) staffed = false;
    else if (!TRUE.has(stRaw)) errors.push(`Staffed “${cells[2]}” must be yes or no`);

    if (cells.length > 3 && cells.slice(3).some(Boolean)) errors.push('Too many columns (expected registration, type, staffed)');

    if (reg) {
      if (known.has(reg)) errors.push('Already registered');
      const first = seen.get(reg);
      if (first !== undefined) errors.push(`Duplicate of line ${first}`);
      else seen.set(reg, i + 1);
    }
    rows.push({ line: i + 1, registration_number: reg, kind, staffed, errors });
  });
  const errors: string[] = [];
  if (rows.length > MAX_BULK) errors.push(`At most ${MAX_BULK} ambulances per batch — split the list.`);
  const valid = rows.filter((r) => r.errors.length === 0);
  return { rows, valid, invalidCount: rows.length - valid.length, errors };
}

/* ------------------------------------------------------------------ insurance claims (FR10) */

export const CLAIM_STATUSES = ['submitted', 'under_review', 'approved', 'rejected', 'settled'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/** Mirrors backend `billing.CLAIM_TRANSITIONS`. */
export const CLAIM_TRANSITIONS: Record<ClaimStatus, ClaimStatus[]> = {
  submitted: ['under_review', 'rejected'],
  under_review: ['approved', 'rejected'],
  approved: ['settled'],
  rejected: [],
  settled: [],
};

export function allowedClaimTransitions(status: string | null | undefined): ClaimStatus[] {
  return CLAIM_TRANSITIONS[(status ?? '') as ClaimStatus] ?? [];
}

export const canTransitionClaim = (from: string | null | undefined, to: string) =>
  allowedClaimTransitions(from).includes(to as ClaimStatus);

export const isClaimTerminal = (status: string | null | undefined) =>
  CLAIM_STATUSES.includes(status as ClaimStatus) && allowedClaimTransitions(status).length === 0;

/** Claims still waiting on an admin decision. */
export const isClaimPending = (status: string | null | undefined) => status === 'submitted' || status === 'under_review';

export const CLAIM_ACTION_LABEL: Record<ClaimStatus, string> = {
  submitted: 'Submit',
  under_review: 'Start review',
  approved: 'Approve',
  rejected: 'Reject',
  settled: 'Mark settled',
};

export type StepState = 'done' | 'current' | 'upcoming' | 'rejected';

/**
 * Happy-path claim steps with state for a timeline. A rejected claim shows the steps it reached as done and a
 * final "Rejected" step.
 */
export function claimSteps(status: string | null | undefined): { key: ClaimStatus; state: StepState }[] {
  const path: ClaimStatus[] = ['submitted', 'under_review', 'approved', 'settled'];
  if (status === 'rejected') {
    // We can't know whether it was rejected before or after review; show submission done + rejection.
    return [{ key: 'submitted', state: 'done' }, { key: 'rejected', state: 'rejected' }];
  }
  const idx = path.indexOf(status as ClaimStatus);
  return path.map((key, i) => ({
    key,
    state: idx < 0 ? 'upcoming' : i < idx || (i === idx && i === path.length - 1) ? 'done' : i === idx ? 'current' : 'upcoming',
  }));
}

/* ------------------------------------------------------------------ platform settings */

export type SettingGroup = 'fares' | 'dispatch' | 'model';

export interface SettingDef {
  key: string;
  label: string;
  group: SettingGroup;
  min: number;
  max: number;
  integer: boolean;
  /** Prefix (₹) or suffix unit shown in the input. */
  unit?: string;
  prefix?: string;
  help: string;
}

/** Mirrors backend `billing.SETTING_DEFS` ranges/types. Unknown server keys are still editable generically. */
export const SETTING_DEFS: SettingDef[] = [
  { key: 'base_fare', label: 'Base fare', group: 'fares', min: 0, max: 100000, integer: false, prefix: '₹', help: 'Flat charge for every completed trip.' },
  { key: 'per_km_rate', label: 'Per-km rate', group: 'fares', min: 0, max: 10000, integer: false, prefix: '₹', unit: '/km', help: 'Charged on routed trip distance.' },
  { key: 'als_surcharge', label: 'ALS surcharge', group: 'fares', min: 0, max: 100000, integer: false, prefix: '₹', help: 'Added when an Advanced Life Support unit is dispatched.' },
  { key: 'revenue_share_pct', label: 'Hospital revenue share', group: 'fares', min: 0, max: 100, integer: false, unit: '%', help: 'Default share of each fare paid to the partner hospital. Hospitals can override it.' },
  { key: 'dispatch_target_s', label: 'Match target (NFR1)', group: 'dispatch', min: 1, max: 120, integer: true, unit: 's', help: 'Time allowed to find and rank the nearest ambulance. Drives the SLA KPI.' },
  { key: 'crew_ack_timeout_s', label: 'Crew acknowledgement timeout', group: 'dispatch', min: 5, max: 600, integer: true, unit: 's', help: 'An offer not accepted in this time is re-offered to the next ambulance.' },
  { key: 'capacity_stale_min', label: 'Capacity freshness window', group: 'dispatch', min: 1, max: 1440, integer: true, unit: 'min', help: 'Hospital capacity older than this is treated as unknown and deprioritised.' },
  { key: 'rebalance_max_moves', label: 'Max rebalancing moves', group: 'model', min: 1, max: 20, integer: true, help: 'Upper bound on station moves suggested per rebalancing run.' },
  { key: 'analytics_retrain_interval_min', label: 'Model refresh interval', group: 'model', min: 1, max: 10080, integer: true, unit: 'min', help: 'How often the demand model retrains on new incidents.' },
];

export const SETTING_GROUPS: { key: SettingGroup; title: string; description: string }[] = [
  { key: 'fares', title: 'Fares & revenue share', description: 'How trips are billed and how revenue is split with hospitals (FR10).' },
  { key: 'dispatch', title: 'Dispatch timing', description: 'Targets and timeouts used by the dispatch engine.' },
  { key: 'model', title: 'Prediction & rebalancing', description: 'Demand-model refresh and fleet rebalancing limits.' },
];

export function settingDef(key: string): SettingDef {
  return SETTING_DEFS.find((d) => d.key === key)
    ?? { key, label: key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), group: 'model', min: -Infinity, max: Infinity, integer: false, help: '' };
}

/** Validation message for a raw input string, or null when valid. */
export function validateSetting(def: SettingDef, raw: string): string | null {
  const s = raw.trim();
  if (!s) return 'Required';
  if (!/^-?\d+(\.\d+)?$/.test(s)) return 'Enter a number';
  const n = Number(s);
  if (def.integer && !Number.isInteger(n)) return 'Enter a whole number';
  if (n < def.min || n > def.max) {
    if (Number.isFinite(def.min) && Number.isFinite(def.max)) return `Must be between ${def.min} and ${def.max}`;
    return n < def.min ? `Must be at least ${def.min}` : `Must be at most ${def.max}`;
  }
  return null;
}

/** Keys whose draft value differs numerically from the saved value. */
export function changedSettings(saved: Record<string, unknown>, draft: Record<string, string>): string[] {
  return Object.keys(draft).filter((k) => {
    const d = draft[k].trim();
    return d === '' ? true : Number(d) !== Number(saved[k]);
  });
}

/* ------------------------------------------------------------------ partner verification (STRQ2) */

/** Unverified partners are never routed to and cannot update capacity until an admin verifies them. */
export function partnerStatus(h: { partner_verified?: boolean }): { label: string; tone: 'success' | 'warning'; verified: boolean } {
  return h.partner_verified
    ? { label: 'Verified', tone: 'success', verified: true }
    : { label: 'Pending verification', tone: 'warning', verified: false };
}
