import { useSearchParams } from 'react-router-dom';
import { Activity, Ambulance, Hospital, Route, Star, Target, Timer, Zap } from 'lucide-react';
import { StatCard } from '../../../components/ui';
import { fmtNumber } from '../../../lib/format';
import { useIsPhone } from '../../../hooks/useMediaQuery';
import { fmtDurShort, fmtMs, fmtPercent, type RangeKey } from './logic';
import type { DashSummary } from './types';

/** Range from `?range=` (24h | 7d | 30d), default 7d; kept in the URL so views are shareable. */
export function useRange(): [RangeKey, (r: RangeKey) => void] {
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('range');
  const range: RangeKey = raw === '24h' || raw === '30d' ? raw : '7d';
  return [range, (r) => setSp((p) => { const n = new URLSearchParams(p); n.set('range', r); return n; }, { replace: true })];
}

export function KpiGrid({ d, loading, admin }: { d: DashSummary | null; loading: boolean; admin?: boolean }) {
  const k = d?.kpis ?? {};
  const targetS = d?.sla?.nfr1_target_s ?? 8;
  const within = d?.sla?.within_target_pct;
  const matchOk = k.avg_match_ms !== null && k.avg_match_ms !== undefined ? k.avg_match_ms <= targetS * 1000 : null;
  const trend = (d?.response_by_day ?? []).filter((x) => x.avg_s !== null).map((x) => x.avg_s as number);
  const counts = (d?.response_by_day ?? []).map((x) => x.count);
  const busy = k.fleet_busy_now_pct;
  const L = loading && !d;
  const phone = useIsPhone();
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      <StatCard loading={L} label="Avg response time" icon={Timer} tone="info" value={fmtDurShort(k.avg_response_s)}
        sparkline={trend.length > 1 && !phone ? trend : undefined} hint={`p90 ${fmtDurShort(k.p90_response_s)} · request to on scene`} />
      <StatCard loading={L} label="Avg match time" icon={Zap} tone={matchOk === false ? 'danger' : 'success'} value={fmtMs(k.avg_match_ms)}
        hint={<>Target {targetS} s (NFR1){within !== null && within !== undefined ? <> · <b className="font-semibold text-ink-700">{fmtPercent(within, 'pct', 0)}</b> within</> : null}</>} />
      <StatCard loading={L} label="Requests" icon={Activity} tone="violet" value={fmtNumber(k.requests_total)}
        sparkline={counts.length > 1 && !phone ? counts : undefined}
        hint={`${fmtNumber(k.completed)} completed · ${fmtPercent(k.completion_rate, 'ratio', 0)}`} />
      <StatCard loading={L} label="Avg handover" icon={Hospital} tone="teal" value={fmtDurShort(k.avg_handover_s)} hint="Arrival at hospital to handover" />
      <StatCard loading={L} label="Fleet utilisation" icon={Ambulance} tone="orange" value={fmtPercent(k.fleet_utilisation_pct, 'pct', 1)}
        hint={busy !== null && busy !== undefined ? `${fmtPercent(busy, 'pct', 0)} of fleet busy right now` : 'Share of ambulance-hours on trips'} />
      <StatCard loading={L} label="Redirects avoided" icon={Route} tone="success" value={fmtNumber(k.redirect_avoided)}
        hint="Trips where the first hospital had a confirmed bed" />
      <StatCard loading={L} label="Avg rating" icon={Star} tone="warning"
        value={k.avg_rating ? <>{k.avg_rating.toFixed(1)}<span className="text-lg font-bold text-ink-500"> / 5</span></> : '--'}
        hint={k.avg_rating ? `${fmtNumber(k.ratings_count ?? 0)} rating${k.ratings_count === 1 ? '' : 's'} from requesters` : 'No ratings in this period'} />
      <StatCard loading={L} label={admin ? 'Within match target' : 'NFR1 compliance'} icon={Target} tone={within !== null && within !== undefined && within < 95 ? 'danger' : 'success'}
        value={fmtPercent(within, 'pct', 1)} hint={`Matches completed in ≤ ${targetS} s`} />
    </div>
  );
}

