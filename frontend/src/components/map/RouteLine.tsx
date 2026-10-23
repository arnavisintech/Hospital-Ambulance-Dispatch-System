import { useMemo } from 'react';
import { Polyline } from 'react-leaflet';
import { splitRoute } from '../../lib/geo';
import { token } from '../../lib/tokens';
import type { LatLng, RoutePhase } from '../../lib/types';

export interface RouteLineProps {
  positions: LatLng[];
  /** to_patient = brand red, to_hospital = info blue (DESIGN_SYSTEM). Default to_patient. */
  phase?: RoutePhase | null;
  /** Current vehicle position: the part of the route before it is drawn grey ("travelled"). */
  progressAt?: LatLng | null;
  /** Dashed preview style (e.g. candidate / alternative route). */
  dashed?: boolean;
  /** Line weight (casing = weight + 2). Default 4 → 6px white casing, per spec. */
  weight?: number;
}

/** Route polyline: white casing + coloured line, travelled part greyed. */
export function RouteLine({ positions, phase = 'to_patient', progressAt, dashed, weight = 4 }: RouteLineProps) {
  const [travelled, remaining] = useMemo(() => splitRoute(positions, progressAt), [positions, progressAt]);
  if (positions.length < 2) return null;
  const color = token(phase === 'to_hospital' ? 'info' : 'brand-500');
  const casing = { color: token('surface'), weight: weight + 2, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, interactive: false };
  const line = { weight, opacity: 1, lineCap: 'round' as const, lineJoin: 'round' as const, interactive: false, dashArray: dashed ? '1 9' : undefined };
  return (
    <>
      {travelled.length > 1 && (
        <>
          <Polyline positions={travelled} pathOptions={casing} />
          <Polyline positions={travelled} pathOptions={{ ...line, color: token('ink-400'), opacity: 0.7, dashArray: undefined }} />
        </>
      )}
      {remaining.length > 1 && (
        <>
          <Polyline positions={remaining} pathOptions={casing} />
          <Polyline positions={remaining} pathOptions={{ ...line, color }} />
        </>
      )}
    </>
  );
}
