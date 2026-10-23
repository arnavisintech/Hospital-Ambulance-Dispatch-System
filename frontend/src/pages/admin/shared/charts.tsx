/**
 * Recharts building blocks for the admin / authority dashboards (dataviz rules: one hue per single series,
 * hairline solid grid, 2px lines, <=24px bars with 4px rounded data-ends, ink text, hover tooltips, and a
 * screen-reader text summary for every chart).
 */
import { useMemo, type ReactElement } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { BarChart3, LineChart as LineIcon } from 'lucide-react';
import { EmptyState, Skeleton } from '../../../components/ui';
import { fmtDate } from '../../../lib/format';
import { incidentMeta } from '../../../lib/status';
import { token } from '../../../lib/tokens';
import { fmtDurShort, fmtTick, minuteTicks } from './logic';

const AXIS = { fontSize: 12, fill: token('ink-500') };

interface TipPayload { value?: unknown; payload?: Record<string, unknown> }

/** Card-styled tooltip; recharts clones this element and injects active/payload/label. */
function ChartTip({ active, payload, render }: {
  active?: boolean; payload?: readonly TipPayload[]; label?: unknown;
  render: (row: Record<string, unknown>) => { title: string; lines: [string, string][] };
}) {
  if (!active || !payload?.length || !payload[0].payload) return null;
  const { title, lines } = render(payload[0].payload);
  return (
    <div className="min-w-[160px] rounded-md border border-line/70 bg-surface px-3 py-2 text-sm shadow-raised">
      <p className="mb-1 font-semibold text-ink-900">{title}</p>
      {lines.map(([k, v]) => (
        <p key={k} className="flex items-center justify-between gap-4 text-ink-700">
          <span>{k}</span><span className="font-semibold tabular-nums text-ink-900">{v}</span>
        </p>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 260 }: { height?: number }) {
  return (
    <div className="flex items-end gap-2 px-1" style={{ height }} role="status" aria-label="Loading chart">
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex-1" style={{ height: `${30 + ((i * 37) % 60)}%` }}>
          <Skeleton className="h-full w-full" rounded="sm" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ response time trend */

export interface TrendPoint { date: string; avg_s: number | null; count: number }

/** Plain-language summary for screen readers (and the source of the visible caption). */
export function trendSummary(data: TrendPoint[]): string {
  const pts = data.filter((d) => d.avg_s !== null && Number.isFinite(d.avg_s));
  if (!pts.length) return 'No response-time data in this period.';
  const avg = pts.reduce((s, d) => s + (d.avg_s ?? 0) * d.count, 0) / Math.max(1, pts.reduce((s, d) => s + d.count, 0));
  const best = pts.reduce((a, b) => ((b.avg_s ?? 0) < (a.avg_s ?? 0) ? b : a));
  const worst = pts.reduce((a, b) => ((b.avg_s ?? 0) > (a.avg_s ?? 0) ? b : a));
  return `Average response ${fmtDurShort(avg)} across ${pts.length} day${pts.length > 1 ? 's' : ''}. `
    + `Fastest ${fmtDurShort(best.avg_s)} on ${fmtDate(best.date)}, slowest ${fmtDurShort(worst.avg_s)} on ${fmtDate(worst.date)}.`;
}

/** Trip-weighted mean of daily averages. */
export function weightedAvg(data: TrendPoint[]): number | null {
  const pts = data.filter((d) => d.avg_s !== null);
  const n = pts.reduce((s, d) => s + d.count, 0);
  return n ? pts.reduce((s, d) => s + (d.avg_s ?? 0) * d.count, 0) / n : null;
}

export function ResponseTrendChart({ data, loading, height = 280 }: { data: TrendPoint[] | undefined; loading?: boolean; height?: number }) {
  const pts = useMemo(() => (data ?? []).filter((d) => d.avg_s !== null), [data]);
  const avg = useMemo(() => weightedAvg(pts), [pts]);
  if (loading && !data) return <ChartSkeleton height={height} />;
  if (pts.length === 0) {
    return <EmptyState compact icon={LineIcon} title="No completed trips yet" description="Response times appear here once trips are closed in this period." />;
  }
  const color = token('info');
  const ticks = minuteTicks(Math.max(...pts.map((p) => p.avg_s ?? 0)));
  return (
    <figure className="m-0">
      <figcaption className="sr-only">{trendSummary(pts)}</figcaption>
      {avg !== null && (
        <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-ink-500" aria-hidden>
          <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-4 rounded-full bg-info" />Daily average</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t-2 border-dashed border-ink-400" />Period average <b className="font-semibold text-ink-700">{fmtDurShort(avg)}</b></span>
        </div>
      )}
      <div style={{ height }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={pts} margin={{ top: 16, right: 16, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="trendFill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.16} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke={token('chart-grid')} />
            <XAxis dataKey="date" tick={AXIS} tickLine={false} axisLine={{ stroke: token('line') }} tickFormatter={(d: string) => fmtDate(d)} minTickGap={24} />
            <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} ticks={ticks} domain={[0, ticks[ticks.length - 1]]} tickFormatter={fmtTick} />
            <Tooltip
              cursor={{ stroke: token('line-strong'), strokeWidth: 1 }}
              content={<ChartTip render={(r) => ({
                title: fmtDate(String(r.date)),
                lines: [['Avg response', fmtDurShort(r.avg_s as number)], ['Trips', String(r.count)]],
              })} /> as ReactElement}
            />
            {avg !== null && <ReferenceLine y={avg} stroke={token('ink-400')} strokeDasharray="4 4" />}
            <Area type="monotone" dataKey="avg_s" stroke={color} strokeWidth={2} fill="url(#trendFill)"
              dot={pts.length <= 14 ? { r: 3.5, fill: color, stroke: token('surface'), strokeWidth: 2 } : false}
              activeDot={{ r: 5, fill: color, stroke: token('surface'), strokeWidth: 2 }} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

/* ------------------------------------------------------------------ incidents by type */

export function incidentSummary(data: { type: string; count: number }[]): string {
  if (!data.length) return 'No incidents in this period.';
  const total = data.reduce((s, d) => s + d.count, 0);
  const sorted = [...data].sort((a, b) => b.count - a.count);
  return `${total} incidents across ${data.length} types. `
    + sorted.slice(0, 3).map((d) => `${incidentMeta(d.type).short} ${d.count} (${Math.round((100 * d.count) / total)}%)`).join(', ') + '.';
}

export function IncidentBars({ data, loading }: { data: { type: string; count: number }[] | undefined; loading?: boolean }) {
  const rows = useMemo(() => {
    const total = (data ?? []).reduce((s, d) => s + d.count, 0) || 1;
    return [...(data ?? [])].sort((a, b) => b.count - a.count)
      .map((d) => ({ ...d, label: incidentMeta(d.type).short, share: (100 * d.count) / total }));
  }, [data]);
  if (loading && !data) return <ChartSkeleton height={260} />;
  if (!rows.length) return <EmptyState compact icon={BarChart3} title="No incidents in this period" />;
  const h = Math.max(160, rows.length * 34 + 16);
  return (
    <figure className="m-0">
      <figcaption className="sr-only">{incidentSummary(data ?? [])}</figcaption>
      <div style={{ height: h }} aria-hidden>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }} barCategoryGap={8}>
            <CartesianGrid horizontal={false} stroke={token('chart-grid')} />
            <XAxis type="number" hide domain={[0, 'dataMax']} />
            <YAxis type="category" dataKey="label" tick={{ ...AXIS, fill: token('ink-700') }} tickLine={false} axisLine={false} width={84} />
            <Tooltip
              cursor={{ fill: token('canvas') }}
              content={<ChartTip render={(r) => ({
                title: incidentMeta(String(r.type)).label,
                lines: [['Incidents', String(r.count)], ['Share', `${(r.share as number).toFixed(1)}%`]],
              })} /> as ReactElement}
            />
            <Bar dataKey="count" fill={token('info')} radius={[0, 4, 4, 0]} maxBarSize={20} isAnimationActive={false}>
              <LabelList dataKey="count" position="right" fill={token('ink-700')} fontSize={12} fontWeight={600} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
