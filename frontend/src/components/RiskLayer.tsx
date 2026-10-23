// Legacy circle-based risk layer. New code: <RiskHeatLayer> from components/map.
import { Circle, Tooltip } from 'react-leaflet';
import { token } from '../lib/tokens';
import type { RiskZone } from '../lib/types';

export function riskColor(norm: number): string {
  if (norm >= 0.75) return token('brand-600');
  if (norm >= 0.5) return token('orange');
  if (norm >= 0.25) return token('warning');
  return token('success');
}

export function RiskLayer({ zones, radiusM = 700 }: { zones: RiskZone[]; radiusM?: number }) {
  const max = Math.max(1, ...zones.map((z) => z.risk));
  return (
    <>
      {zones.map((z) => {
        const n = z.risk / max;
        return (
          <Circle key={String(z.zone_id)} center={[z.lat, z.lng]} radius={radiusM}
            pathOptions={{ color: riskColor(n), fillColor: riskColor(n), fillOpacity: 0.15 + 0.35 * n, weight: 1 }}>
            <Tooltip>{z.zone_label ?? `Zone ${String(z.zone_id)}`} - risk {z.risk.toFixed(2)} - demand {z.expected_demand.toFixed(1)}</Tooltip>
          </Circle>
        );
      })}
    </>
  );
}
