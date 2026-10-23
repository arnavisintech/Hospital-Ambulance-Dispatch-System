import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useMap } from 'react-leaflet';
import type { LatLng } from '../../lib/types';
import { useMapInsets } from './MapCanvas';

export interface FitBoundsProps {
  points: (LatLng | null | undefined)[];
  /** Extra padding in px per side. Defaults to MapInsetsContext (sheet peek etc. from MobileAppLayout). */
  insets?: { top?: number; right?: number; bottom?: number; left?: number };
  /** Uniform padding added to insets. Default 48. */
  padding?: number;
  maxZoom?: number;
  /** Fit only the first time points are available (don't fight the user's panning). Default false. */
  once?: boolean;
  /** Change this to force a re-fit (e.g. recenter button). */
  refitKey?: unknown;
  animate?: boolean;
}

/** Fit the map to points whenever the set of points changes (rounded to ~10 m to ignore GPS jitter). */
export function FitBounds({ points, insets, padding = 48, maxZoom = 16, once = false, refitKey, animate = true }: FitBoundsProps) {
  const map = useMap();
  const done = useRef(false);
  const valid = points.filter((p): p is LatLng => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const key = valid.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('|');
  const ctx = useMapInsets();
  const { top = 0, right = 0, bottom = 0, left = 0 } = { ...ctx, ...insets };

  useEffect(() => {
    if (valid.length === 0 || (once && done.current)) return;
    done.current = true;
    const opts = { paddingTopLeft: L.point(left + padding, top + padding), paddingBottomRight: L.point(right + padding, bottom + padding), maxZoom, animate };
    if (valid.length === 1) map.setView(valid[0], Math.min(maxZoom, Math.max(map.getZoom(), 15)), { animate });
    else map.fitBounds(L.latLngBounds(valid), opts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refitKey, map, top, right, bottom, left, padding, maxZoom]);
  return null;
}
