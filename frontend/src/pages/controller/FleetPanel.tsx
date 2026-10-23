import { useMemo, useState } from 'react';
import { Ambulance, Search, SignalLow } from 'lucide-react';
import { EmptyState, Input, SegmentedControl, StatusPill } from '../../components/ui';
import { cn } from '../../lib/cn';
import { fmtDuration } from '../../lib/format';
import { ambulanceStatusMeta, toneClasses } from '../../lib/status';
import type { AmbulanceBrief, Board } from '../../lib/types';
import { STALE_FIX_S, fleetBucket, type FleetFilter } from './board';

/** Fleet tab: every ambulance with status, crew, station and GPS freshness. Click → fly the map to it. */
export function FleetPanel({ board, onLocate }: { board: Board; onLocate: (a: AmbulanceBrief) => void }) {
  const [filter, setFilter] = useState<FleetFilter>('all');
  const [q, setQ] = useState('');
  const counts = useMemo(() => {
    const c = { all: board.ambulances.length, available: 0, busy: 0, offline: 0 };
    board.ambulances.forEach((a) => { c[fleetBucket(a.status)]++; });
    return c;
  }, [board.ambulances]);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return board.ambulances
      .filter((a) => filter === 'all' || fleetBucket(a.status) === filter)
      .filter((a) => !needle || [a.registration_number, a.station_name, a.crew_name].some((s) => s?.toLowerCase().includes(needle)))
      .sort((a, b) => ['busy', 'available', 'offline'].indexOf(fleetBucket(a.status)) - ['busy', 'available', 'offline'].indexOf(fleetBucket(b.status))
        || a.registration_number.localeCompare(b.registration_number));
  }, [board.ambulances, filter, q]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-line/70 p-3">
        <SegmentedControl
          ariaLabel="Filter fleet" size="sm" fullWidth value={filter} onChange={setFilter}
          items={[
            { value: 'all', label: 'All', badge: counts.all },
            { value: 'available', label: 'Free', badge: counts.available },
            { value: 'busy', label: 'Busy', badge: counts.busy },
            { value: 'offline', label: 'Off', badge: counts.offline },
          ]}
        />
        <Input icon={Search} placeholder="Search unit, station or crew" aria-label="Search fleet" value={q} onChange={(e) => setQ(e.target.value)} className="h-10 text-sm" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
        {list.length === 0 ? (
          <EmptyState compact icon={Ambulance} title="No ambulances match" description="Try another filter or search." />
        ) : (
          <ul className="space-y-1.5">
            {list.map((a) => {
              const m = ambulanceStatusMeta(a.status);
              const stale = a.location_age_s != null && a.location_age_s > STALE_FIX_S && m.online;
              const hasPos = a.lat != null && a.lng != null;
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    disabled={!hasPos}
                    onClick={() => onLocate(a)}
                    className="press flex w-full items-center gap-3 rounded-lg border border-line/70 bg-surface px-3 py-2.5 text-left shadow-card transition-shadow hover:shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-60"
                  >
                    <span className={cn('relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md', toneClasses(m.tone).soft)} aria-hidden>
                      <Ambulance size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-sm font-bold text-ink-900">
                        {a.registration_number}
                        {a.kind && <span className="rounded-sm bg-canvas px-1 py-px text-[11px] font-semibold text-ink-700">{a.kind}</span>}
                      </p>
                      <p className="truncate text-xs font-medium text-ink-500">
                        {[a.station_name, a.crew_name].filter(Boolean).join(' · ') || '—'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <StatusPill status={a.status} kind="ambulance" />
                      {stale ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-warning-fg"><SignalLow size={12} aria-hidden />GPS {fmtDuration(a.location_age_s)} old</span>
                      ) : a.request_id ? (
                        <span className="text-[11px] font-semibold text-ink-500 tabular-nums">Request #{a.request_id}</span>
                      ) : null}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
