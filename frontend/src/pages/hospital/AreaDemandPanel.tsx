import { TrendingUp } from 'lucide-react';
import { Card, CardHeader, EmptyState, ErrorState, Skeleton, Sparkline } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { get } from '../../lib/api';
import { demographicsLine } from '../../lib/format';

interface AreaZone {
  zone_id: string; zone_label: string; distance_km: number; expected_demand: number; risk: number;
  households: number | null; senior_share: number | null;
}
interface HourDemand { hour: number; expected_demand: number }
interface Area {
  hospital_id: number; hour: number; radius_km: number; model_version: string | null;
  demographics_source: string; zones: AreaZone[]; by_hour: HourDemand[];
}

export function busiestHour(byHour: HourDemand[]): HourDemand | null {
  return byHour.reduce<HourDemand | null>((best, x) => (!best || x.expected_demand > best.expected_demand ? x : best), null);
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** Predicted emergency demand around this hospital (hospital analytics): plan staffing and beds ahead. */
export function AreaDemandPanel({ hid }: { hid: number }) {
  const area = useAsync(() => get<Area>(`/analytics/hospitals/${hid}/area`, { radius_km: 5 }), [hid], 15 * 60000);
  const a = area.data;
  const peak = a ? busiestHour(a.by_hour) : null;
  return (
    <Card as="section" aria-labelledby="area-h">
      <CardHeader as="h2" title={<span id="area-h">Demand around you</span>}
        subtitle={a ? `Predicted emergencies within ${a.radius_km} km · ${hh(a.hour)} now` : 'Predicted emergencies nearby'} icon={TrendingUp} />
      {area.loading && !a ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : area.error && !a ? (
        <ErrorState compact message={area.error} onRetry={() => void area.reload()} />
      ) : !a || !a.zones.length ? (
        <EmptyState compact icon={TrendingUp} title="No forecast yet" description="The demand model has not produced a forecast for your area." />
      ) : (
        <div className="space-y-3">
          {peak && (
            <div className="flex items-center gap-3">
              <p className="flex-1 text-sm text-ink-700">Calls nearby today: <strong className="text-ink-900">busiest around {hh(peak.hour)}</strong></p>
              <Sparkline data={a.by_hour.map((x) => x.expected_demand)} tone="info" width={96} height={28} />
            </div>
          )}
          <ul className="divide-y divide-line/70">
            {a.zones.slice(0, 5).map((z) => (
              <li key={z.zone_id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-900">{z.zone_label}</p>
                  <p className="text-xs text-ink-500">{z.distance_km} km{demographicsLine(z) ? ` · ${demographicsLine(z)}` : ''}</p>
                </div>
                <span className="text-sm font-bold tabular-nums text-ink-900" title="Expected emergencies this hour">{z.expected_demand.toFixed(2)}/h</span>
              </li>
            ))}
          </ul>
          {a.demographics_source === 'synthetic' && (
            <p className="text-xs text-ink-500">Population figures are a synthetic estimate until census data is imported.</p>
          )}
        </div>
      )}
    </Card>
  );
}
