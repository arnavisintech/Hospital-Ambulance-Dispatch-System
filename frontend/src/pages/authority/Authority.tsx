import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, ArrowRight, Building2, CheckCircle2, Eye, Hospital, MapPinned, MinusCircle, RefreshCw, ShieldCheck, Timer, XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Badge, IconButton, PageHeader, Skeleton } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { get } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtClock, fmtNumber } from '../../lib/format';
import type { HospitalBrief, RiskMap } from '../../lib/types';
import { IncidentBars, ResponseTrendChart } from '../admin/shared/charts';
import { KpiGrid, useRange } from '../admin/shared/kpis';
import { fmtMs, fmtPercent, rangeLabel, type CsvColumn } from '../admin/shared/logic';
import type { AuditVerify, CoverageGap, DashSummary } from '../admin/shared/types';
import {
  CoverageGapList, CoverageMap, ExportButton, gapName, HospitalTable, PageError, Panel, RangeControl, StaleBanner, StationTable,
  useDashboard,
} from '../admin/shared/widgets';

type Verdict = 'met' | 'missed' | 'unknown';
const VERDICT: Record<Verdict, { label: string; tone: 'success' | 'danger' | 'muted'; icon: LucideIcon }> = {
  met: { label: 'Met', tone: 'success', icon: CheckCircle2 },
  missed: { label: 'Not met', tone: 'danger', icon: XCircle },
  unknown: { label: 'No data', tone: 'muted', icon: MinusCircle },
};

/** NFR compliance thresholds used on this view (UI-defined; the backend reports the raw figures). */
export const NFR_THRESHOLDS = { matchWithinPct: 95, freshCapacityPct: 90 };

export function complianceRows(d: DashSummary | null, verify: AuditVerify | null, verifyError: boolean) {
  const target = d?.sla?.nfr1_target_s ?? 8;
  const within = d?.sla?.within_target_pct;
  const avgMs = d?.kpis.avg_match_ms;
  const hospitals = d?.hospitals ?? [];
  const fresh = hospitals.length ? (100 * hospitals.filter((h) => !h.stale).length) / hospitals.length : null;
  const v = (ok: boolean | null): Verdict => (ok === null ? 'unknown' : ok ? 'met' : 'missed');
  const num = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
  return [
    {
      key: 'audit', title: 'Audit trail integrity (NFR7)',
      detail: verify ? (verify.ok ? `Hash chain intact · ${fmtNumber(verify.checked)} entries verified` : `Chain broken at entry #${verify.broken_at}`)
        : verifyError ? 'Verification unavailable' : 'Verifying…',
      verdict: v(verify ? verify.ok : null),
    },
    {
      key: 'nfr1', title: `Ambulance matched within ${target} s (NFR1)`,
      detail: num(within) ? `${fmtPercent(within, 'pct', 1)} of requests · target ≥ ${NFR_THRESHOLDS.matchWithinPct}%` : 'No dispatches in this period',
      verdict: v(num(within) ? within >= NFR_THRESHOLDS.matchWithinPct : null),
    },
    {
      key: 'match', title: 'Average match time',
      detail: num(avgMs) ? `${fmtMs(avgMs)} · target ≤ ${target} s` : 'No dispatches in this period',
      verdict: v(num(avgMs) ? avgMs <= target * 1000 : null),
    },
    {
      key: 'capacity', title: 'Hospital capacity kept fresh',
      detail: fresh !== null ? `${fmtPercent(fresh, 'pct', 0)} of hospitals updated in window · target ≥ ${NFR_THRESHOLDS.freshCapacityPct}%` : 'No partner hospitals',
      verdict: v(fresh !== null ? fresh >= NFR_THRESHOLDS.freshCapacityPct : null),
    },
  ];
}

function ComplianceCard({ d, loading }: { d: DashSummary | null; loading: boolean }) {
  const verify = useAsync(() => get<AuditVerify>('/audit/verify'), [], 300000);
  const rows = complianceRows(d, verify.data, !!verify.error);
  const met = rows.filter((r) => r.verdict === 'met').length;
  return (
    <Panel id="compliance" title="Compliance" subtitle={`${met} of ${rows.length} targets met`} icon={ShieldCheck}
      action={<Link to="/authority/audit" className="inline-flex items-center gap-1 text-sm font-semibold text-info-fg hover:underline">Audit log <ArrowRight size={14} aria-hidden /></Link>}>
      {loading && !d ? (
        <div className="space-y-3" role="status" aria-label="Loading compliance">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : (
        <ul className="divide-y divide-line/80">
          {rows.map((r) => {
            const m = VERDICT[r.verdict];
            const Icon = m.icon;
            return (
              <li key={r.key} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <Icon size={20} aria-hidden className={cn('mt-0.5 shrink-0', r.verdict === 'met' ? 'text-success' : r.verdict === 'missed' ? 'text-brand-500' : 'text-ink-400')} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-ink-900">{r.title}</p>
                  <p className="text-sm text-ink-500">{r.detail}</p>
                </div>
                <Badge tone={m.tone}>{m.label}</Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

const GAP_CSV: CsvColumn<CoverageGap>[] = [
  { header: 'Zone', value: (g) => g.zone_id },
  { header: 'Locality', value: (g) => gapName(g) },
  { header: 'Latitude', value: (g) => g.lat },
  { header: 'Longitude', value: (g) => g.lng },
  { header: 'Risk', value: (g) => g.risk },
  { header: 'Nearest free ambulance (km)', value: (g) => g.nearest_ambulance_km },
  { header: 'Households', value: (g) => g.households },
  { header: 'Aged 60+ (%)', value: (g) => (g.senior_share == null ? null : Math.round(g.senior_share * 1000) / 10) },
];

export default function Authority() {
  const [range, setRange] = useRange();
  const dash = useDashboard(range);
  const d = dash.data;
  const risk = useAsync(() => get<RiskMap>('/analytics/risk-map'), [], 300000);
  const hospitals = useAsync(() => get<HospitalBrief[]>('/hospitals'), [], 120000);
  const [gap, setGap] = useState<string | number | null>(null);
  const gaps = d?.coverage_gaps ?? [];
  const toggleGap = (g: CoverageGap) => setGap((c) => (c === g.zone_id ? null : g.zone_id));

  return (
    <div>
      <PageHeader
        title="City health overview"
        subtitle={<span className="inline-flex flex-wrap items-center gap-2">
          <Badge tone="info" icon={Eye}>Read-only</Badge>
          <span>{rangeLabel(range)}{d?.generated_at && <> · Updated {fmtClock(d.generated_at)}</>}</span>
        </span>}
        actions={<>
          <RangeControl value={range} onChange={setRange} />
          <IconButton label="Refresh" icon={RefreshCw} variant="secondary" onClick={() => { void dash.reload(); void risk.reload(); void hospitals.reload(); }} />
        </>}
      />
      {dash.error && !d ? <PageError message={dash.error} onRetry={() => void dash.reload()} /> : (
        <div className="space-y-6" aria-busy={dash.loading}>
          {dash.error && d && <StaleBanner message={dash.error} />}
          <KpiGrid d={d} loading={dash.loading} />

          <div className="grid gap-6 lg:grid-cols-3">
            <Panel id="a-trend" className="lg:col-span-2" title="Response time trend" subtitle="Daily average, request to ambulance on scene" icon={Timer}>
              <ResponseTrendChart data={d?.response_by_day} loading={dash.loading} />
            </Panel>
            <ComplianceCard d={d} loading={dash.loading} />
          </div>

          <Panel id="a-map" title="Coverage gaps" icon={MapPinned}
            subtitle={<>Predicted demand risk for {risk.data ? `${String(risk.data.hour).padStart(2, '0')}:00` : 'this hour'} and the localities furthest from a free ambulance</>}
            action={<ExportButton rows={gaps} columns={GAP_CSV} name="coverage-gaps" />}
            bodyClassName="px-0 pb-0">
            <div className="grid border-t border-line lg:grid-cols-[minmax(0,1fr)_360px]">
              <div className="h-[360px] sm:h-[460px]">
                {dash.loading && !d ? <Skeleton className="h-full w-full" rounded="sm" /> : (
                  <CoverageMap gaps={gaps} zones={risk.data?.zones} hospitals={hospitals.data ?? undefined} selected={gap} onSelect={toggleGap}
                    className="h-full rounded-none border-0" />
                )}
              </div>
              <div className="max-h-[460px] overflow-y-auto border-t border-line p-3 scrollbar-thin lg:border-l lg:border-t-0">
                <h3 className="px-2 pb-2 pt-1 text-xs font-bold uppercase tracking-wide text-ink-500">Top {Math.min(10, gaps.length) || 10} underserved localities</h3>
                <CoverageGapList gaps={d?.coverage_gaps} loading={dash.loading} selected={gap} onSelect={toggleGap} limit={10} />
              </div>
            </div>
          </Panel>

          <div className="grid gap-6 lg:grid-cols-3">
            <Panel id="a-inc" title="Incidents by type" subtitle={rangeLabel(range)} icon={Activity}>
              <IncidentBars data={d?.by_incident} loading={dash.loading} />
            </Panel>
            <Panel id="a-stations" className="lg:col-span-2" title="Station utilisation" subtitle="Share of ambulance-hours spent on trips" icon={Building2} bodyClassName="px-0 pb-0">
              <StationTable data={d?.stations} loading={dash.loading && !d} exportable />
            </Panel>
          </div>

          <Panel id="a-hospitals" title="Hospital capacity" subtitle="Live beds and ICU across partner hospitals" icon={Hospital} bodyClassName="px-0 pb-0">
            <HospitalTable data={d?.hospitals} loading={dash.loading && !d} exportable pageSize={10} />
          </Panel>
        </div>
      )}
    </div>
  );
}
