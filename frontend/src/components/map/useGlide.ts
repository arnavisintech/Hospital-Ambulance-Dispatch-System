import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { bearingDeg, distanceM, planGlide, pointAlong } from '../../lib/geo';
import type { LatLng } from '../../lib/types';

export interface GlideOptions {
  /** Route polyline to follow between pings (so the marker turns corners with the road). */
  route?: LatLng[] | null;
  /**
   * Animation length in ms. Default: the measured interval between the last two pings (clamped 300-5000 ms),
   * so the marker is always moving and arrives just as the next ping lands. First ping: 1000 ms.
   */
  durationMs?: number;
  /** Teleport instead of gliding when a ping jumps further than this (default 3000 m). */
  maxJumpM?: number;
  /** Disable gliding (jump). Reduced-motion users always jump. */
  enabled?: boolean;
}

export interface GlideState {
  position: LatLng | null;
  /** Bearing of current movement in degrees (0 = north), or null before the first movement. */
  heading: number | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Pure frame computation used by the hook (exported for tests): position/heading at progress t of a ping-to-ping glide. */
export function glideFrame(from: LatLng, to: LatLng, t: number, route?: LatLng[] | null): GlideState {
  const path = planGlide(from, to, route);
  const { position, heading } = pointAlong(path, t);
  return { position, heading: heading ?? (distanceM(from, to) > 0.5 ? bearingDeg(from, to) : null) };
}

/**
 * Smoothly interpolate a marker between GPS pings with requestAnimationFrame, along the route polyline when the
 * pings lie on it. Honours prefers-reduced-motion (jumps). Returns the position to render + movement heading.
 */
export function useGlide(target: LatLng | null | undefined, opts: GlideOptions = {}): GlideState {
  const { route, durationMs, maxJumpM = 3000, enabled = true } = opts;
  const reduce = useReducedMotion();
  const [state, setState] = useState<GlideState>({ position: target ?? null, heading: null });
  const current = useRef<LatLng | null>(target ?? null);
  const heading = useRef<number | null>(null);
  const lastPingAt = useRef<number | null>(null);
  const routeRef = useRef(route);
  useEffect(() => { routeRef.current = route; });

  const lat = target?.[0], lng = target?.[1];
  useEffect(() => {
    if (lat === undefined || lng === undefined) return;
    const to: LatLng = [lat, lng];
    const from = current.current;
    const now = performance.now();
    const interval = lastPingAt.current === null ? 1000 : clamp(now - lastPingAt.current, 300, 5000);
    lastPingAt.current = now;

    const jump = () => {
      if (from && distanceM(from, to) > 0.5) heading.current = bearingDeg(from, to);
      current.current = to;
      setState({ position: to, heading: heading.current });
    };
    if (!from || !enabled || reduce || distanceM(from, to) > maxJumpM || distanceM(from, to) < 0.5) { jump(); return; }

    const duration = durationMs ?? interval;
    const path = planGlide(from, to, routeRef.current);
    let raf = 0;
    const start = now;
    const step = (ts: number) => {
      const t = clamp((ts - start) / duration, 0, 1);
      const f = pointAlong(path, t);
      current.current = f.position;
      if (f.heading !== null) heading.current = f.heading;
      setState({ position: f.position, heading: heading.current });
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [lat, lng, enabled, reduce, durationMs, maxJumpM]);

  return state;
}
