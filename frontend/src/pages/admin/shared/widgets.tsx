/** Shared dashboard widgets for the admin overview and the City Health Authority view. */
import { useMemo, useState, type ReactNode } from 'react';
import L from 'leaflet';
import { Marker } from 'react-leaflet';
import { AlertTriangle, Download, MapPinned, type LucideIcon } from 'lucide-react';
import { Badge, Button, Card, DataTable, EmptyState, ErrorState, SegmentedControl, Skeleton, type Column } from '../../../components/ui';
import { FitBounds, HospitalMarker, MapCanvas, RiskHeatLayer, Tooltip } from '../../../components/map';
import { useAsync } from '../../../hooks/useAsync';
import { get } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import type { Tone } from '../../../lib/status';
import { demographicsLine, fmtAge, fmtDistance, fmtNumber } from '../../../lib/format';
import type { HospitalBrief, RiskMap } from '../../../lib/types';
import { clampPct, csvName, downloadCsv, fmtPercent, rangeToDays, RANGE_ITEMS, toCsv, type CsvColumn, type RangeKey } from './logic';
import type { CoverageGap, DashHospital, DashStation, DashSummary } from './types';

/* ------------------------------------------------------------------ data */

export function useDashboard(range: RangeKey) {
  const days = rangeToDays(range);
  return useAsync(() => get<DashSummary>('/dashboard/summary', { days }), [days], 60000);
}

/* ------------------------------------------------------------------ chrome */

export function RangeControl({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  return <SegmentedControl ariaLabel="Date range" size="sm" items={RANGE_ITEMS} value={value} onChange={onChange} />;
}

/** Card with an h2 header row (title, subtitle, right action). */
export function Panel({ title, subtitle, icon: Icon, action, children, className, bodyClassName, id }: {
  title: ReactNode; subtitle?: ReactNode; icon?: LucideIcon; action?: ReactNode; children: ReactNode;
  className?: string; bodyClassName?: string; id?: string;
}) {
  return (
    <Card as="section" padding="none" className={cn('flex min-w-0 flex-col', className)} aria-labelledby={id ? `${id}-h` : undefined}>
      <div className="flex flex-wrap items-start gap-3 px-5 pb-3 pt-4">
        {Icon && (
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-canvas text-ink-700" aria-hidden><Icon size={18} /></span>
        )}
        <div className="min-w-0 flex-1">
          <h2 id={id ? `${id}-h` : undefined} className="text-base font-semibold text-ink-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <div className={cn('min-w-0 flex-1 px-5 pb-5', bodyClassName)}>{children}</div>
    </Card>
  );
}

export function ExportButton<T>({ rows, columns, name, disabled }: { rows: T[]; columns: CsvColumn<T>[]; name: string; disabled?: boolean }) {
  return (
    <Button size="sm" variant="secondary" icon={Download} disabled={disabled || rows.length === 0}
      onClick={() => downloadCsv(csvName(name), toCsv(rows, columns))}>
      Export CSV
    </Button>
  );
}

/** Full-page load error with retry, used when the summary request fails before any data arrived. */
export function PageError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Card padding="none">
      <ErrorState title="Couldn't load the dashboard" message={`${message}. Check your connection and try again.`}
        retrying={busy} onRetry={() => { setBusy(true); void Promise.resolve(onRetry()).finally(() => setBusy(false)); }} />
    </Card>
  );
}

/** Thin banner shown when a background refresh fails but older data is still on screen. */
export function StaleBanner({ message }: { message: string }) {
  return (
    <div role="status" className="mb-4 flex items-center gap-2 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning-fg">
      <AlertTriangle size={16} aria-hidden /> Showing the last loaded data — refresh failed: {message}
    </div>
  );
}

/* ------------------------------------------------------------------ inline utilisation bar */

export function UtilBar({ value, label }: { value: number | null | undefined; label?: string }) {
  const v = clampPct(value);
  const tone = v >= 85 ? 'bg-brand-500' : v >= 60 ? 'bg-warning' : 'bg-info';
  return (
    <div className="flex min-w-[112px] items-center gap-2 sm:gap-3">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-info-bg" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)} aria-label={label ?? 'Utilisation'}>
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.max(v, v > 0 ? 2 : 0)}%` }} />
      </div>
      <span className="w-12 text-right text-sm font-semibold tabular-nums text-ink-900">{fmtPercent(value, 'pct', v < 10 ? 1 : 0)}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ station + hospital tables */

export const STATION_CSV: CsvColumn<DashStation>[] = [
  { header: 'Station', value: (s) => s.name },
  { header: 'Utilisation %', value: (s) => s.utilisation_pct },
  { header: 'Ambulances', value: (s) => s.ambulances },
  { header: 'Available now', value: (s) => s.available },
  { header: 'Trips', value: (s) => s.trips },
];

const STATION_COLS: Column<DashStation>[] = [
  { key: 'name', header: 'Station', sortable: true, className: 'min-w-[150px]', cell: (s) => <span className="font-semibold">{s.name}</span> },
  { key: 'utilisation_pct', header: 'Utilisation', sortable: true, width: 'w-[40%]', cell: (s) => <UtilBar value={s.utilisation_pct} label={`${s.name} utilisation`} /> },
  {
    key: 'available', header: 'Available', sortable: true, align: 'right', accessor: (s) => s.available,
    cell: (s) => <span className={cn('tabular-nums', s.available === 0 && s.ambulances > 0 ? 'font-semibold text-danger-fg' : 'text-ink-900')}>{s.available}<span className="text-ink-500"> / {s.ambulances}</span></span>,
  },
  { key: 'trips', header: 'Trips', sortable: true, align: 'right', hideBelow: 'sm' },
];

export function StationTable({ data, loading, exportable, pageSize = 8 }: { data: DashStation[] | undefined; loading?: boolean; exportable?: boolean; pageSize?: number }) {
  return (
    <DataTable
      caption="Station utilisation"
      data={data ?? []}
      columns={STATION_COLS}
      rowKey={(s) => s.id}
      loading={loading}
      searchable
      searchPlaceholder="Search stations"
      pageSize={pageSize}
      initialSort={{ key: 'utilisation_pct', dir: 'desc' }}
      toolbar={exportable ? <ExportButton rows={data ?? []} columns={STATION_CSV} name="station-utilisation" /> : undefined}
      empty={<EmptyState compact title="No stations yet" description="Onboard a station to see its utilisation here." />}
      className="shadow-none"
    />
  );
}

export const HOSPITAL_CSV: CsvColumn<DashHospital>[] = [
  { header: 'Hospital', value: (h) => h.name },
  { header: 'Available beds', value: (h) => h.available_beds },
  { header: 'Total beds', value: (h) => h.total_beds },
  { header: 'Available ICU', value: (h) => h.available_icu },
  { header: 'Total ICU', value: (h) => h.total_icu },
  { header: 'Bed occupancy %', value: (h) => h.bed_occupancy_pct },
  { header: 'Trips received', value: (h) => h.trips_received },
  { header: 'Capacity age (min)', value: (h) => h.capacity_age_min },
  { header: 'Stale', value: (h) => (h.stale ? 'yes' : 'no') },
];

function Capacity({ avail, total }: { avail?: number | null; total?: number | null }) {
  if (avail === null || avail === undefined) return <span className="text-ink-500">--</span>;
  const low = total ? avail / total < 0.1 : avail === 0;
  return (
    <span className="tabular-nums">
      <span className={cn('font-semibold', avail === 0 ? 'text-danger-fg' : low ? 'text-warning-fg' : 'text-ink-900')}>{avail}</span>
      {total !== null && total !== undefined && <span className="text-ink-500"> / {total}</span>}
    </span>
  );
}

const HOSPITAL_COLS: Column<DashHospital>[] = [
  { key: 'name', header: 'Hospital', sortable: true, className: 'min-w-[220px]', cell: (h) => <span className="font-semibold">{h.name}</span> },
  { key: 'available_beds', header: 'Beds free', sortable: true, align: 'right', cell: (h) => <Capacity avail={h.available_beds} total={h.total_beds} /> },
  { key: 'available_icu', header: 'ICU free', sortable: true, align: 'right', cell: (h) => <Capacity avail={h.available_icu} total={h.total_icu} /> },
  { key: 'bed_occupancy_pct', header: 'Occupancy', sortable: true, hideBelow: 'md', cell: (h) => <UtilBar value={h.bed_occupancy_pct} label={`${h.name} bed occupancy`} /> },
  { key: 'trips_received', header: 'Trips', sortable: true, align: 'right', hideBelow: 'lg' },
  {
    key: 'capacity_age_min', header: 'Updated', sortable: true, hideBelow: 'sm',
    cell: (h) => (h.stale
      ? <Badge tone="warning" dot title="Capacity older than the freshness window — treated as unknown by dispatch">Stale · {fmtAge(h.capacity_age_min)}</Badge>
      : <span className="text-sm text-ink-700">{fmtAge(h.capacity_age_min)}</span>),
  },
];

export function HospitalTable({ data, loading, exportable, pageSize = 8 }: { data: DashHospital[] | undefined; loading?: boolean; exportable?: boolean; pageSize?: number }) {
  return (
    <DataTable
      caption="Hospital capacity"
      data={data ?? []}
      columns={HOSPITAL_COLS}
      rowKey={(h) => h.id}
      loading={loading}
      searchable
      searchPlaceholder="Search hospitals"
      pageSize={pageSize}
      initialSort={{ key: 'available_beds', dir: 'asc' }}
      toolbar={exportable ? <ExportButton rows={data ?? []} columns={HOSPITAL_CSV} name="hospital-capacity" /> : undefined}
      empty={<EmptyState compact title="No partner hospitals yet" />}
      className="shadow-none"
    />
  );
}

/* ------------------------------------------------------------------ coverage gaps */

export const gapName = (g: CoverageGap) => g.zone_label || `Zone ${String(g.zone_id)}`;

function riskTone(risk: number, max: number): Tone {
  const r = max > 0 ? risk / max : 0;
  return r >= 0.75 ? 'danger' : r >= 0.45 ? 'orange' : 'warning';
}
function riskLabel(risk: number, max: number) {
  const r = max > 0 ? risk / max : 0;
  return r >= 0.75 ? 'High risk' : r >= 0.45 ? 'Elevated' : 'Moderate';
}

export function CoverageGapList({ gaps, loading, onSelect, selected, limit = 10 }: {
  gaps: CoverageGap[] | undefined; loading?: boolean; onSelect?: (g: CoverageGap) => void; selected?: string | number | null; limit?: number;
}) {
  const max = Math.max(0, ...(gaps ?? []).map((g) => g.risk));
  if (loading && !gaps) {
    return <div className="space-y-2" role="status" aria-label="Loading coverage gaps">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  }
  if (!gaps?.length) {
    return <EmptyState compact icon={MapPinned} title="No coverage gaps" description="Every high-risk zone has an available ambulance nearby." />;
  }
  return (
    <ol className="divide-y divide-line/80" aria-label="Underserved localities, highest gap first">
      {gaps.slice(0, limit).map((g, i) => {
        const active = selected === g.zone_id;
        const body = (
          <>
            <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums',
              active ? 'bg-brand-500 text-white' : 'bg-brand-50 text-brand-600')} aria-hidden>{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-ink-900">{gapName(g)}</span>
              <span className="block text-xs text-ink-500">
                {g.nearest_ambulance_km === null || g.nearest_ambulance_km === undefined
                  ? 'No available ambulance' : `Nearest free ambulance ${fmtDistance(g.nearest_ambulance_km)}`}
              </span>
              {demographicsLine(g) && <span className="block text-xs text-ink-500">{demographicsLine(g)}</span>}
            </span>
            <Badge tone={riskTone(g.risk, max)} title={`Predicted demand risk ${fmtNumber(g.risk, 3)} (relative to the highest gap)`}>{riskLabel(g.risk, max)}</Badge>
          </>
        );
        return (
          <li key={String(g.zone_id)}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(g)} aria-pressed={active}
                className={cn('press flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500', active && 'bg-brand-50/60')}>
                {body}
              </button>
            ) : <div className="flex items-center gap-3 px-2 py-2.5">{body}</div>}
          </li>
        );
      })}
    </ol>
  );
}

function gapIcon(n: number, active: boolean) {
  const s = active ? 30 : 24;
  return L.divIcon({
    className: 'hads-marker',
    iconSize: [s, s],
    iconAnchor: [s / 2, s / 2],
    html: `<div style="width:${s}px;height:${s}px;border-radius:9999px;background:rgb(var(--brand-500));color:rgb(var(--surface));border:2px solid rgb(var(--surface));box-shadow:0 4px 10px rgba(16,24,40,.25);display:flex;align-items:center;justify-content:center;font:700 ${active ? 13 : 12}px/1 'Plus Jakarta Sans',system-ui,sans-serif">${n}</div>`,
  });
}

export function HeatLegend({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-md border border-line/70 bg-surface/95 px-3 py-2 text-xs shadow-card backdrop-blur', className)}>
      <p className="mb-1 font-semibold text-ink-900">Predicted demand risk</p>
      <div className="h-2 w-40 rounded-full"
        style={{ background: 'linear-gradient(to right, rgb(var(--success) / .5), rgb(var(--warning)), rgb(var(--orange)), rgb(var(--brand-600)))' }} aria-hidden />
      <div className="mt-1 flex justify-between text-ink-500"><span>Low</span><span>High</span></div>
      <p className="mt-1.5 flex items-center gap-1.5 text-ink-700">
        <span className="inline-block h-3 w-3 rounded-full border-2 border-surface bg-brand-500 shadow-card" aria-hidden /> Coverage gap (ranked)
      </p>
    </div>
  );
}

/**
 * Coverage map: heat of predicted risk (all zones when `zones` given, else the gaps) + numbered gap markers
 * (+ optional hospital markers). Parent sets the height.
 */
export function CoverageMap({ gaps, zones, hospitals, selected, onSelect, className, interactive = true, legend = true }: {
  gaps: CoverageGap[]; zones?: RiskMap['zones']; hospitals?: HospitalBrief[]; selected?: string | number | null;
  onSelect?: (g: CoverageGap) => void; className?: string; interactive?: boolean; legend?: boolean;
}) {
  const heat: { lat: number; lng: number; risk: number }[] = zones && zones.length ? zones : gaps;
  const points = useMemo(() => gaps.map((g) => [g.lat, g.lng] as [number, number]), [gaps]);
  const sel = gaps.find((g) => g.zone_id === selected);
  return (
    <div className={cn('relative overflow-hidden rounded-md border border-line/70', className)}>
      <MapCanvas zoom={11} ariaLabel="Coverage gap map" interactive={interactive} scrollWheelZoom={false}>
        <RiskHeatLayer zones={heat} radiusM={zones ? 2000 : 1800} opacity={0.65} />
        {hospitals?.map((h) => (
          <HospitalMarker key={h.id} position={[h.lat, h.lng]} name={h.name} beds={h.available_beds} icu={h.available_icu} stale={h.stale} />
        ))}
        {gaps.map((g, i) => (
          <Marker key={String(g.zone_id)} position={[g.lat, g.lng]} icon={gapIcon(i + 1, g.zone_id === selected)}
            zIndexOffset={g.zone_id === selected ? 1000 : 500} alt={`Gap ${i + 1}: ${gapName(g)}`}
            eventHandlers={onSelect ? { click: () => onSelect(g) } : undefined}>
            <Tooltip direction="top" offset={[0, -12]}>
              <span className="font-semibold">{gapName(g)}</span>
              {g.nearest_ambulance_km !== null && g.nearest_ambulance_km !== undefined && <> · nearest {fmtDistance(g.nearest_ambulance_km)}</>}
            </Tooltip>
          </Marker>
        ))}
        <FitBounds points={sel ? [[sel.lat, sel.lng]] : points} padding={32} maxZoom={sel ? 14 : 13} refitKey={selected} />
      </MapCanvas>
      {legend && <HeatLegend className="pointer-events-none absolute bottom-3 left-3 z-[1000]" />}
    </div>
  );
}
