import { useState } from 'react';
import { Activity, BrainCircuit, Building2, Gauge, Hospital, MapPinned, RefreshCw, Timer } from 'lucide-react';
import { Badge, Button, IconButton, PageHeader, Skeleton, Sparkline, useToast } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { get, post } from '../../lib/api';
import { fmtClock, fmtNumber, fmtRelative } from '../../lib/format';
import { IncidentBars, ResponseTrendChart } from './shared/charts';
import { KpiGrid, useRange } from './shared/kpis';
import { rangeLabel } from './shared/logic';
import type { ModelInfo } from './shared/types';
import {
  CoverageGapList, CoverageMap, HospitalTable, PageError, Panel, RangeControl, StaleBanner, StationTable, useDashboard,
} from './shared/widgets';

function ModelCard() {
  const model = useAsync(() => get<ModelInfo>('/analytics/model'), []);
  const { success, error } = useToast();
  const [busy, setBusy] = useState(false);
  const m = model.data;
  const hist = (m?.history ?? []).slice().reverse().map((h) => h.mae).filter((x): x is number => typeof x === 'number');

  const retrain = async () => {
    setBusy(true);
    try {
      const r = await post<{ model_version: string; mae: number | null; r2: number | null; train_seconds?: number }>('/analytics/retrain');
      success(`MAE ${r.mae?.toFixed(3) ?? '--'} · R² ${r.r2?.toFixed(3) ?? '--'}${r.train_seconds ? ` · ${r.train_seconds}s` : ''}`, { title: `Model ${r.model_version} trained` });
      await model.reload();
    } catch (e) { error(e, { title: "Couldn't retrain the model" }); } finally { setBusy(false); }
  };

  return (
    <Panel id="model" title="Prediction model" subtitle="Hourly demand per zone (FR3)" icon={BrainCircuit}
      action={<Button size="sm" variant="secondary" icon={RefreshCw} loading={busy} onClick={() => void retrain()}>{busy ? 'Training…' : 'Retrain'}</Button>}>
      {model.loading && !m ? (
        <div className="space-y-3" role="status" aria-label="Loading model"><Skeleton className="h-16 w-full" /><Skeleton className="h-4 w-2/3" /></div>
      ) : model.error && !m ? (
        <p className="text-sm text-ink-500" role="alert">Couldn't load model metrics. <button className="font-semibold text-info-fg underline" onClick={() => void model.reload()}>Retry</button></p>
      ) : !m?.model_version ? (
        <p className="text-sm text-ink-500">No model trained yet. Retrain to build one from incident history.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3">
            <div className="rounded-md bg-canvas p-3">
              <dt className="text-xs font-medium text-ink-500" title="Mean absolute error — lower is better">MAE</dt>
              <dd className="mt-1 flex items-end justify-between gap-2">
                <span className="text-2xl font-extrabold text-ink-900">{m.mae?.toFixed(3) ?? '--'}</span>
                {hist.length > 1 && <Sparkline data={hist} tone="info" width={64} height={24} />}
              </dd>
            </div>
            <div className="rounded-md bg-canvas p-3">
              <dt className="text-xs font-medium text-ink-500" title="Coefficient of determination — closer to 1 is better">R²</dt>
              <dd className="mt-1 text-2xl font-extrabold text-ink-900">{m.r2?.toFixed(3) ?? '--'}</dd>
            </div>
          </dl>
          <dl className="mt-4 space-y-2 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-ink-500">Version</dt><dd className="font-mono text-xs font-semibold text-ink-900">{m.model_version}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-500">Trained</dt><dd className="text-ink-900">{m.trained_at ? <time dateTime={m.trained_at} title={m.trained_at}>{fmtRelative(m.trained_at)}</time> : '--'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-500">Training rows</dt><dd className="tabular-nums text-ink-900">{fmtNumber(m.n_train)}{m.n_live ? <span className="text-ink-500"> · {fmtNumber(m.n_live)} live</span> : null}</dd></div>
          </dl>
          {(m.history?.length ?? 0) > 1 && (
            <div className="mt-5">
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-ink-500">Recent runs</h3>
              <table className="w-full text-sm">
                <caption className="sr-only">Recent model training runs</caption>
                <thead><tr className="text-left text-xs text-ink-500"><th scope="col" className="pb-1 font-medium">Trained</th><th scope="col" className="pb-1 text-right font-medium">MAE</th><th scope="col" className="pb-1 text-right font-medium">R²</th></tr></thead>
                <tbody>
                  {m.history!.slice(0, 5).map((h, i) => (
                    <tr key={`${h.model_version}-${i}`} className="border-t border-line/70">
                      <td className="py-1.5 text-ink-700">{fmtRelative(h.trained_at)}</td>
                      <td className="py-1.5 text-right tabular-nums text-ink-900">{h.mae?.toFixed(3) ?? '--'}</td>
                      <td className="py-1.5 text-right tabular-nums text-ink-900">{h.r2?.toFixed(3) ?? '--'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

export default function AdminDashboard() {
  const [range, setRange] = useRange();
  const dash = useDashboard(range);
  const d = dash.data;
  const [gap, setGap] = useState<string | number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => { setRefreshing(true); await dash.reload(); setRefreshing(false); };

  return (
    <div>
      <PageHeader
        title="Operations overview"
        subtitle={<>{rangeLabel(range)}{d?.generated_at && <> · Updated {fmtClock(d.generated_at)}</>}</>}
        actions={<>
          <RangeControl value={range} onChange={setRange} />
          <IconButton label="Refresh dashboard" icon={RefreshCw} variant="secondary" onClick={() => void refresh()} className={refreshing ? '[&_svg]:animate-spin' : undefined} />
        </>}
      />
      {dash.error && !d ? <PageError message={dash.error} onRetry={() => void dash.reload()} /> : (
        <div className="space-y-6" aria-busy={dash.loading}>
          {dash.error && d && <StaleBanner message={dash.error} />}
          <KpiGrid d={d} loading={dash.loading} admin />

          <div className="grid gap-6 lg:grid-cols-3">
            <Panel id="trend" className="lg:col-span-2" title="Response time trend" subtitle="Daily average, request to ambulance on scene" icon={Timer}>
              <ResponseTrendChart data={d?.response_by_day} loading={dash.loading} />
            </Panel>
            <Panel id="incidents" title="Incidents by type" subtitle={rangeLabel(range)} icon={Activity}>
              <IncidentBars data={d?.by_incident} loading={dash.loading} />
            </Panel>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Panel id="stations" className="lg:col-span-2" title="Station utilisation" subtitle="Share of ambulance-hours spent on trips" icon={Building2} bodyClassName="px-0 pb-0">
              <StationTable data={d?.stations} loading={dash.loading && !d} />
            </Panel>
            <Panel id="gaps" title="Coverage gaps" icon={MapPinned}
              subtitle="High-risk zones far from a free ambulance"
              action={d?.coverage_gaps?.length ? <Badge tone="danger">{d.coverage_gaps.length}</Badge> : undefined}>
              {(d?.coverage_gaps?.length ?? 0) > 0 && (
                <CoverageMap gaps={d!.coverage_gaps} selected={gap} onSelect={(g) => setGap((c) => (c === g.zone_id ? null : g.zone_id))}
                  className="mb-3 h-52" legend={false} />
              )}
              <CoverageGapList gaps={d?.coverage_gaps} loading={dash.loading} selected={gap} limit={5}
                onSelect={(g) => setGap((c) => (c === g.zone_id ? null : g.zone_id))} />
            </Panel>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Panel id="hospitals" className="lg:col-span-2" title="Hospital capacity" subtitle="Live beds and ICU across partner hospitals" icon={Hospital} bodyClassName="px-0 pb-0">
              <HospitalTable data={d?.hospitals} loading={dash.loading && !d} pageSize={8} />
            </Panel>
            <ModelCard />
          </div>
          <p className="flex items-center gap-1.5 text-xs text-ink-500"><Gauge size={14} aria-hidden /> Figures refresh every minute. Utilisation and response times include completed trips only.</p>
        </div>
      )}
    </div>
  );
}
