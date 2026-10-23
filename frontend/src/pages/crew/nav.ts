/**
 * Pure crew navigation logic: maneuver → icon/text, next-maneuver selection along the route, and the
 * forward-only status action for the slide button. Tested in src/test/crewNav.test.ts.
 */
import {
  ArrowUp, ArrowUpLeft, ArrowUpRight, CornerUpLeft, CornerUpRight, Flag, Merge, Navigation2, RotateCw, Split, Undo2,
  type LucideIcon,
} from 'lucide-react';
import { projectOnPolyline } from '../../lib/geo';
import type { LatLng, Maneuver, RouteStep } from '../../lib/types';
import type { Tone } from '../../lib/status';

/** Lucide icon for an OSRM maneuver {type, modifier}. Unknown → straight arrow. */
export function maneuverIcon(m?: Maneuver | null): LucideIcon {
  const type = (m?.type ?? '').toLowerCase();
  const mod = (m?.modifier ?? '').toLowerCase();
  if (type === 'arrive') return Flag;
  if (type === 'depart') return Navigation2;
  if (type.includes('roundabout') || type === 'rotary') return RotateCw;
  if (type === 'merge') return Merge;
  if (type === 'fork' && !mod.includes('left') && !mod.includes('right')) return Split;
  switch (mod) {
    case 'uturn': return Undo2;
    case 'sharp left':
    case 'left': return CornerUpLeft;
    case 'sharp right':
    case 'right': return CornerUpRight;
    case 'slight left': return ArrowUpLeft;
    case 'slight right': return ArrowUpRight;
    default: return ArrowUp;
  }
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Short spoken/visible verb phrase, e.g. "Turn left", "Keep slightly right", "Arrive". */
export function maneuverText(m?: Maneuver | null): string {
  const type = (m?.type ?? '').toLowerCase();
  const mod = (m?.modifier ?? '').toLowerCase();
  if (type === 'arrive') return 'Arrive';
  if (type === 'depart') return 'Head out';
  if (type.includes('roundabout') || type === 'rotary') return 'At the roundabout, take the exit';
  if (mod === 'uturn') return 'Make a U-turn';
  if (type === 'merge') return mod ? `Merge ${mod.replace('slight ', '')}` : 'Merge';
  if (type === 'fork' || type === 'on ramp' || type === 'off ramp') return mod ? `Keep ${mod.replace('slight ', '')}` : 'Keep straight';
  if (!mod || mod === 'straight') return 'Continue straight';
  if (mod.startsWith('slight')) return `Bear ${mod.replace('slight ', '')}`;
  if (mod.startsWith('sharp')) return cap(`sharp ${mod.replace('sharp ', '')}`);
  return `Turn ${mod}`;
}

export interface NextManeuver {
  step: RouteStep;
  index: number;
  /** Metres from the vehicle to the maneuver point along the route. */
  distanceM: number;
}

/**
 * The next maneuver ahead of `pos` on the route. Each step's (lat,lng) is its maneuver point; we project both
 * the vehicle and the steps onto the polyline and pick the first step strictly ahead (> 15 m). Falls back to
 * the step's own distance when there is no polyline. A 'depart' at the route start is never "ahead", so it is
 * naturally skipped.
 */
export function nextManeuver(steps: RouteStep[] | undefined, polyline: LatLng[] | undefined, pos: LatLng | null): NextManeuver | null {
  if (!steps || steps.length === 0) return null;
  const line = polyline && polyline.length >= 2 ? polyline : null;
  const here = pos && line ? projectOnPolyline(pos, line) : null;
  const hereAlong = here?.alongM ?? 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (line) {
      const p = projectOnPolyline([s.lat, s.lng], line);
      const along = p?.alongM ?? 0;
      if (along - hereAlong > 15 || i === steps.length - 1) {
        return { step: s, index: i, distanceM: Math.max(0, along - hereAlong) };
      }
    } else if (s.maneuver?.type !== 'depart' || i === steps.length - 1) {
      return { step: s, index: i, distanceM: steps[i - 1]?.distance_m ?? s.distance_m ?? 0 };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ status flow */

export type TripAction = 'en_route' | 'on_scene' | 'transporting' | 'arrived';

export interface CrewActionMeta {
  next: TripAction;
  label: string;
  confirmed: string;
  tone: Extract<Tone, 'info' | 'violet' | 'orange' | 'teal'>;
}

const FLOW: Record<string, CrewActionMeta> = {
  accepted: { next: 'en_route', label: 'Slide to start trip', confirmed: 'Trip started', tone: 'info' },
  en_route: { next: 'on_scene', label: 'Slide · Reached patient', confirmed: 'Reached patient', tone: 'violet' },
  on_scene: { next: 'transporting', label: 'Slide · Patient picked up', confirmed: 'Patient on board', tone: 'orange' },
  transporting: { next: 'arrived', label: 'Slide · Reached hospital', confirmed: 'At hospital', tone: 'teal' },
};

/** Forward-only next action for the crew slide button; null once at hospital (handover is the hospital's). */
export function crewAction(status: string): CrewActionMeta | null {
  return FLOW[status] ?? null;
}

/** Which leg the crew is driving. */
export function crewPhase(status: string): 'to_patient' | 'to_hospital' {
  return status === 'transporting' || status === 'arrived' ? 'to_hospital' : 'to_patient';
}

/** Offer window in seconds from offered_at → offer_expires_at (fallback 30 s). */
export function offerWindowS(offeredAt?: string | null, expiresAt?: string | null, fallback = 30): number {
  const a = offeredAt ? new Date(offeredAt).getTime() : NaN;
  const b = expiresAt ? new Date(expiresAt).getTime() : NaN;
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) return Math.round((b - a) / 1000);
  return fallback;
}
