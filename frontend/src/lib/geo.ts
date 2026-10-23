import type { LatLng } from './types';

export const CHENNAI: LatLng = [13.0827, 80.2707];

const RAD = Math.PI / 180;

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = (b[0] - a[0]) * RAD, dLng = (b[1] - a[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
export const distanceM = (a: LatLng, b: LatLng) => haversineKm(a, b) * 1000;

/** Initial bearing a -> b in degrees, 0 = north, clockwise, [0, 360). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const φ1 = a[0] * RAD, φ2 = b[0] * RAD, Δλ = (b[1] - a[1]) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Linear interpolation between two coordinates (fine at city scale). */
export function lerpLatLng(a: LatLng, b: LatLng, t: number): LatLng {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Shortest signed angular difference b - a in degrees, in (-180, 180]. */
export function angleDelta(a: number, b: number): number {
  const d = ((b - a) % 360 + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/* ------------------------------------------------------------------ polyline projection */

export interface PolylineProjection {
  /** Segment index i (segment = line[i] -> line[i+1]). */
  index: number;
  /** Position along that segment, 0..1. */
  t: number;
  point: LatLng;
  /** Distance from the query point to the polyline, metres. */
  distM: number;
  /** Distance from the polyline start to the projected point, metres. */
  alongM: number;
}

/** Project a point onto a polyline using a local equirectangular plane (accurate to < 1% within a city). */
export function projectOnPolyline(p: LatLng, line: LatLng[]): PolylineProjection | null {
  if (line.length === 0) return null;
  if (line.length === 1) return { index: 0, t: 0, point: line[0], distM: distanceM(p, line[0]), alongM: 0 };
  const kx = Math.cos(p[0] * RAD) * 111320, ky = 110540;
  const toXY = (q: LatLng): [number, number] => [(q[1] - p[1]) * kx, (q[0] - p[0]) * ky];
  let best: PolylineProjection | null = null;
  let along = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = toXY(line[i]), [bx, by] = toXY(line[i + 1]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const px = ax + dx * t, py = ay + dy * t;
    const d = Math.hypot(px, py);
    const segLen = Math.sqrt(len2);
    if (!best || d < best.distM - 1e-9) {
      best = { index: i, t, point: lerpLatLng(line[i], line[i + 1], t), distM: d, alongM: along + segLen * t };
    }
    along += segLen;
  }
  return best;
}

/** Total length of a path in metres. */
export function pathLengthM(path: LatLng[]): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += distanceM(path[i - 1], path[i]);
  return s;
}

/**
 * Plan the path a marker should glide along from `from` to `to`.
 * If both points lie within `snapM` of `route` and `to` is not behind `from`, the path follows the route's
 * intermediate vertices (so the marker turns corners with the road); otherwise it is a straight segment.
 */
export function planGlide(from: LatLng, to: LatLng, route?: LatLng[] | null, snapM = 60): LatLng[] {
  if (!route || route.length < 2) return [from, to];
  const pf = projectOnPolyline(from, route), pt = projectOnPolyline(to, route);
  if (!pf || !pt || pf.distM > snapM || pt.distM > snapM || pt.alongM < pf.alongM - 5) return [from, to];
  const mid = route.slice(pf.index + 1, pt.index + 1);
  return [from, ...mid, to];
}

/** Position + heading at fraction `t` (0..1) of the path's length. */
export function pointAlong(path: LatLng[], t: number): { position: LatLng; heading: number | null } {
  if (path.length === 0) throw new Error('empty path');
  if (path.length === 1) return { position: path[0], heading: null };
  const total = pathLengthM(path);
  if (total === 0) return { position: path[path.length - 1], heading: null };
  let target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < path.length; i++) {
    const seg = distanceM(path[i - 1], path[i]);
    if (target <= seg || i === path.length - 1) {
      const f = seg === 0 ? 1 : Math.min(1, target / seg);
      return { position: lerpLatLng(path[i - 1], path[i], f), heading: seg === 0 ? null : bearingDeg(path[i - 1], path[i]) };
    }
    target -= seg;
  }
  return { position: path[path.length - 1], heading: null };
}

/** Split a route at the point nearest `at`: [travelled, remaining] (both include the split point). */
export function splitRoute(route: LatLng[], at?: LatLng | null): [LatLng[], LatLng[]] {
  if (!at || route.length < 2) return [[], route];
  const p = projectOnPolyline(at, route);
  if (!p) return [[], route];
  return [[...route.slice(0, p.index + 1), p.point], [p.point, ...route.slice(p.index + 1)]];
}

/** Insert interpolated points so consecutive vertices are at most `stepM` metres apart. */
export function densify(poly: LatLng[], stepM = 150): LatLng[] {
  if (poly.length < 2) return poly.slice();
  const out: LatLng[] = [poly[0]];
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    const dM = haversineKm(a, b) * 1000;
    const n = Math.max(1, Math.ceil(dM / stepM));
    for (let k = 1; k <= n; k++) {
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
  }
  return out;
}

/** Next valid status for the crew forward-only trip state machine, or null when finished. */
export const TRIP_FLOW = ['accepted', 'en_route', 'on_scene', 'transporting', 'arrived'] as const;
export function nextTripStatus(current: string): 'en_route' | 'on_scene' | 'transporting' | 'arrived' | null {
  const i = TRIP_FLOW.indexOf(current as (typeof TRIP_FLOW)[number]);
  if (i < 0 || i >= TRIP_FLOW.length - 1) return null;
  return TRIP_FLOW[i + 1] as 'en_route' | 'on_scene' | 'transporting' | 'arrived';
}
