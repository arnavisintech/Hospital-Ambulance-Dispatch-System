/**
 * Single source of truth for status / severity / incident presentation (docs/DESIGN_SYSTEM.md).
 * Status is ALWAYS communicated with colour + icon + label — use <StatusPill> / <SeverityBadge> or these helpers.
 */
import {
  AlertTriangle, Ambulance, Baby, BellRing, Bone, Brain, Car, CheckCheck, CheckCircle, CircleHelp, Clock, Flag,
  Flame, FlaskConical, HeartPulse, Hospital, MapPin, PowerOff, Radar, Undo2, Wind, Wrench, XCircle,
  type LucideIcon,
} from 'lucide-react';

/* --------------------------------------------------------------------------------------------- */
/* Tones                                                                                         */
/* --------------------------------------------------------------------------------------------- */

export type Tone = 'neutral' | 'muted' | 'brand' | 'success' | 'info' | 'warning' | 'danger' | 'violet' | 'orange' | 'teal' | 'critical';

export interface ToneClasses {
  /** Soft pill/badge: tinted background + accessible text colour. */
  soft: string;
  /** Solid fill with white (or ink) text. */
  solid: string;
  /** Text colour only (>= 4.5:1 on white). */
  text: string;
  /** Background for a small status dot / icon fill. */
  dot: string;
  /** Tinted background only. */
  bg: string;
  /** Border colour matching the tone. */
  border: string;
  /** CSS colour expression for raw SVG / Leaflet HTML (uses CSS variables, never hex). */
  css: string;
}

// Literal class strings so Tailwind's JIT picks them up.
export const TONES: Record<Tone, ToneClasses> = {
  neutral: { soft: 'bg-ink-900/[.06] text-ink-700', solid: 'bg-ink-700 text-white', text: 'text-ink-700', dot: 'bg-ink-500', bg: 'bg-canvas', border: 'border-line-strong', css: 'rgb(var(--ink-500))' },
  muted: { soft: 'bg-ink-900/[.05] text-ink-500', solid: 'bg-ink-400 text-white', text: 'text-ink-500', dot: 'bg-ink-400', bg: 'bg-canvas', border: 'border-line', css: 'rgb(var(--ink-400))' },
  brand: { soft: 'bg-brand-50 text-brand-600', solid: 'bg-brand-500 text-white', text: 'text-brand-600', dot: 'bg-brand-500', bg: 'bg-brand-50', border: 'border-brand-200', css: 'rgb(var(--brand-500))' },
  danger: { soft: 'bg-danger-bg text-danger-fg', solid: 'bg-danger text-white', text: 'text-danger-fg', dot: 'bg-danger', bg: 'bg-danger-bg', border: 'border-brand-200', css: 'rgb(var(--brand-500))' },
  critical: { soft: 'bg-brand-100 text-brand-700', solid: 'bg-brand-700 text-white', text: 'text-brand-700', dot: 'bg-brand-700', bg: 'bg-brand-100', border: 'border-brand-400', css: 'rgb(var(--brand-700))' },
  success: { soft: 'bg-success-bg text-success-fg', solid: 'bg-success text-white', text: 'text-success-fg', dot: 'bg-success', bg: 'bg-success-bg', border: 'border-success/30', css: 'rgb(var(--success))' },
  info: { soft: 'bg-info-bg text-info-fg', solid: 'bg-info text-white', text: 'text-info-fg', dot: 'bg-info', bg: 'bg-info-bg', border: 'border-info/30', css: 'rgb(var(--info))' },
  warning: { soft: 'bg-warning-bg text-warning-fg', solid: 'bg-warning text-white', text: 'text-warning-fg', dot: 'bg-warning', bg: 'bg-warning-bg', border: 'border-warning/30', css: 'rgb(var(--warning))' },
  violet: { soft: 'bg-violet-bg text-violet-fg', solid: 'bg-violet text-white', text: 'text-violet-fg', dot: 'bg-violet', bg: 'bg-violet-bg', border: 'border-violet/30', css: 'rgb(var(--violet))' },
  orange: { soft: 'bg-orange-bg text-orange-fg', solid: 'bg-orange text-white', text: 'text-orange-fg', dot: 'bg-orange', bg: 'bg-orange-bg', border: 'border-orange/30', css: 'rgb(var(--orange))' },
  teal: { soft: 'bg-teal-bg text-teal-fg', solid: 'bg-teal text-white', text: 'text-teal-fg', dot: 'bg-teal', bg: 'bg-teal-bg', border: 'border-teal/30', css: 'rgb(var(--teal))' },
};

export const toneClasses = (t: Tone): ToneClasses => TONES[t] ?? TONES.neutral;

/* --------------------------------------------------------------------------------------------- */
/* Request status                                                                                */
/* --------------------------------------------------------------------------------------------- */

export const REQUEST_STATUSES = [
  'received', 'matching', 'awaiting_manual', 'offered', 'accepted', 'en_route', 'on_scene', 'transporting', 'arrived',
  'completed', 'cancelled', 'failed',
] as const;
export type RequestStatusKey = (typeof REQUEST_STATUSES)[number];

export interface StatusMeta {
  key: string;
  /** Short operational label, e.g. "En route". */
  label: string;
  /** Calm consumer headline for the requester / family share page, e.g. "Ambulance on the way". */
  headline: string;
  tone: Tone;
  icon: LucideIcon;
  /** Index into PROGRESS_STEPS of the latest reached step: -1 = not yet assigned, 4 = all done. */
  progress: number;
  /** True for statuses after which nothing else happens. */
  terminal: boolean;
  /** True while we are still looking for an ambulance (show PulseRadar). */
  searching: boolean;
}

const R = (
  key: RequestStatusKey, label: string, headline: string, tone: Tone, icon: LucideIcon, progress: number,
  extra: Partial<Pick<StatusMeta, 'terminal' | 'searching'>> = {},
): StatusMeta => ({ key, label, headline, tone, icon, progress, terminal: false, searching: false, ...extra });

export const REQUEST_STATUS: Record<RequestStatusKey, StatusMeta> = {
  received: R('received', 'Received', 'Request received', 'neutral', Clock, -1, { searching: true }),
  matching: R('matching', 'Matching', 'Finding the nearest ambulance…', 'neutral', Radar, -1, { searching: true }),
  awaiting_manual: R('awaiting_manual', 'Needs manual dispatch', 'Our control room is assigning an ambulance', 'danger', AlertTriangle, -1, { searching: true }),
  offered: R('offered', 'Offered', 'Ambulance found — confirming crew', 'warning', BellRing, -1, { searching: true }),
  accepted: R('accepted', 'Accepted', 'Ambulance assigned', 'info', CheckCircle, 0),
  en_route: R('en_route', 'En route', 'Ambulance on the way', 'info', Ambulance, 1),
  on_scene: R('on_scene', 'On scene', 'Ambulance has arrived', 'violet', MapPin, 1),
  transporting: R('transporting', 'Transporting', 'On the way to hospital', 'orange', Hospital, 2),
  arrived: R('arrived', 'At hospital', 'Arrived at hospital', 'teal', Flag, 3),
  completed: R('completed', 'Completed', 'Handover complete', 'success', CheckCheck, 4, { terminal: true }),
  cancelled: R('cancelled', 'Cancelled', 'Request cancelled', 'muted', XCircle, -1, { terminal: true }),
  failed: R('failed', 'Failed', "We couldn't complete this request", 'muted', XCircle, -1, { terminal: true }),
};

/** Look up a request status; unknown values degrade gracefully to a neutral title-cased pill. */
export function requestStatusMeta(status: string | null | undefined): StatusMeta {
  const s = (status ?? '') as RequestStatusKey;
  return REQUEST_STATUS[s] ?? R(s, humanize(status ?? 'unknown'), humanize(status ?? 'unknown'), 'neutral', CircleHelp, -1);
}

/** ProgressSteps labels (requester tracker): Assigned → On the way → Picked up → At hospital. */
export const PROGRESS_STEPS = ['Assigned', 'On the way', 'Picked up', 'At hospital'] as const;

/** Latest reached ProgressSteps index for a request status (-1 none yet, 4 = everything done). */
export function progressIndex(status: string | null | undefined): number {
  return requestStatusMeta(status).progress;
}

/** Active (non-terminal) requests that are past matching. */
export const isLiveTrip = (status: string) => {
  const m = requestStatusMeta(status);
  return !m.terminal && m.progress >= 0;
};

/** The status order used by timelines (happy path). */
export const STATUS_ORDER: RequestStatusKey[] = ['received', 'matching', 'offered', 'accepted', 'en_route', 'on_scene', 'transporting', 'arrived', 'completed'];

/* --------------------------------------------------------------------------------------------- */
/* Ambulance status                                                                              */
/* --------------------------------------------------------------------------------------------- */

export const AMBULANCE_STATUSES = ['available', 'assigned', 'en_route', 'on_scene', 'transporting', 'returning', 'offline', 'maintenance'] as const;
export type AmbulanceStatusKey = (typeof AMBULANCE_STATUSES)[number];

export interface AmbulanceStatusMeta { key: string; label: string; tone: Tone; icon: LucideIcon; /** Counts as in service. */ online: boolean }

export const AMBULANCE_STATUS: Record<AmbulanceStatusKey, AmbulanceStatusMeta> = {
  available: { key: 'available', label: 'Available', tone: 'success', icon: CheckCircle, online: true },
  assigned: { key: 'assigned', label: 'Assigned', tone: 'warning', icon: BellRing, online: true },
  en_route: { key: 'en_route', label: 'En route', tone: 'info', icon: Ambulance, online: true },
  on_scene: { key: 'on_scene', label: 'On scene', tone: 'violet', icon: MapPin, online: true },
  transporting: { key: 'transporting', label: 'Transporting', tone: 'orange', icon: Hospital, online: true },
  returning: { key: 'returning', label: 'Returning', tone: 'success', icon: Undo2, online: true },
  offline: { key: 'offline', label: 'Offline', tone: 'muted', icon: PowerOff, online: false },
  maintenance: { key: 'maintenance', label: 'Maintenance', tone: 'muted', icon: Wrench, online: false },
};

const AMB_ALIASES: Record<string, AmbulanceStatusKey> = { busy: 'transporting', dispatched: 'assigned', accepted: 'assigned', offered: 'assigned', arrived: 'transporting' };

export function ambulanceStatusMeta(status: string | null | undefined): AmbulanceStatusMeta {
  const s = (status ?? '') as AmbulanceStatusKey;
  return AMBULANCE_STATUS[s] ?? AMBULANCE_STATUS[AMB_ALIASES[s] ?? 'offline'] ?? AMBULANCE_STATUS.offline;
}

/* --------------------------------------------------------------------------------------------- */
/* Generic statuses (billing, claims, accounts, rebalance…)                                      */
/* --------------------------------------------------------------------------------------------- */

const GENERIC: Record<string, { label?: string; tone: Tone }> = {
  pending: { tone: 'warning' }, unpaid: { tone: 'warning' }, paid: { tone: 'success' }, approved: { tone: 'success' },
  verified: { tone: 'success' }, submitted: { tone: 'info' }, rejected: { tone: 'danger' }, active: { tone: 'success' },
  inactive: { tone: 'muted' }, accepted: { tone: 'success' }, dismissed: { tone: 'muted' }, none: { label: 'None', tone: 'muted' },
  settled: { tone: 'success' }, under_review: { tone: 'info' },
  insurance_pending: { label: 'Insurance pending', tone: 'warning' }, waived: { tone: 'muted' }, failed: { tone: 'danger' }, live: { tone: 'success' }, stale: { tone: 'warning' },
};

export function genericStatusMeta(status: string | null | undefined): { label: string; tone: Tone } {
  const s = (status ?? '').toLowerCase();
  const g = GENERIC[s];
  return { label: g?.label ?? humanize(s || 'unknown'), tone: g?.tone ?? 'neutral' };
}

/* --------------------------------------------------------------------------------------------- */
/* Severity                                                                                      */
/* --------------------------------------------------------------------------------------------- */

export interface SeverityMeta { level: 1 | 2 | 3 | 4 | 5; label: string; tone: Tone; description: string }

export const SEVERITY: Record<1 | 2 | 3 | 4 | 5, SeverityMeta> = {
  1: { level: 1, label: 'Mild', tone: 'success', description: 'Conscious, stable, minor injury' },
  2: { level: 2, label: 'Moderate', tone: 'warning', description: 'Needs care soon, not worsening' },
  3: { level: 3, label: 'Serious', tone: 'orange', description: 'Significant pain, bleeding or distress' },
  4: { level: 4, label: 'Critical', tone: 'danger', description: 'Breathing trouble, chest pain, unresponsive' },
  5: { level: 5, label: 'Life-threatening', tone: 'critical', description: 'Not breathing, no pulse, heavy bleeding' },
};

/** Clamp + look up. Never show bare severity numbers to the public — use `.label`. */
export function severityMeta(sev: number | null | undefined): SeverityMeta {
  const n = Math.min(5, Math.max(1, Math.round(Number(sev) || 1))) as 1 | 2 | 3 | 4 | 5;
  return SEVERITY[n];
}

/* --------------------------------------------------------------------------------------------- */
/* Incident types                                                                                */
/* --------------------------------------------------------------------------------------------- */

export const INCIDENT_KEYS = ['cardiac', 'accident', 'stroke', 'respiratory', 'maternity', 'trauma', 'burns', 'poisoning', 'other'] as const;
export type IncidentKey = (typeof INCIDENT_KEYS)[number];

export interface IncidentMeta { key: string; label: string; short: string; icon: LucideIcon; hint: string }

export const INCIDENT: Record<IncidentKey, IncidentMeta> = {
  cardiac: { key: 'cardiac', label: 'Heart / chest pain', short: 'Cardiac', icon: HeartPulse, hint: 'Chest pain, collapse, palpitations' },
  accident: { key: 'accident', label: 'Road accident', short: 'Accident', icon: Car, hint: 'Vehicle collision, pedestrian hit' },
  stroke: { key: 'stroke', label: 'Stroke', short: 'Stroke', icon: Brain, hint: 'Face drooping, arm weakness, slurred speech' },
  respiratory: { key: 'respiratory', label: 'Breathing difficulty', short: 'Breathing', icon: Wind, hint: 'Shortness of breath, choking, asthma' },
  maternity: { key: 'maternity', label: 'Pregnancy / labour', short: 'Maternity', icon: Baby, hint: 'Labour pains, pregnancy complication' },
  trauma: { key: 'trauma', label: 'Injury / fall', short: 'Injury', icon: Bone, hint: 'Fall, fracture, deep cut' },
  burns: { key: 'burns', label: 'Burns', short: 'Burns', icon: Flame, hint: 'Fire, scald, electrical or chemical burn' },
  poisoning: { key: 'poisoning', label: 'Poisoning / overdose', short: 'Poisoning', icon: FlaskConical, hint: 'Swallowed something harmful, bite, overdose' },
  other: { key: 'other', label: 'Something else', short: 'Other', icon: CircleHelp, hint: 'Any other medical emergency' },
};

export function incidentMeta(type: string | null | undefined): IncidentMeta {
  return INCIDENT[(type ?? 'other') as IncidentKey] ?? { ...INCIDENT.other, key: type ?? 'other', label: humanize(type ?? 'other'), short: humanize(type ?? 'other') };
}

/* --------------------------------------------------------------------------------------------- */

/** "awaiting_manual" -> "Awaiting manual". */
export function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
