import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Ambulance, ArrowDown, Check, Shuffle, Sparkles, TimerReset, X } from 'lucide-react';
import { Button, EmptyState, ErrorState, Skeleton, useToast } from '../../components/ui';
import type { AsyncState } from '../../hooks/useAsync';
import { post } from '../../lib/api';
import { fmtDuration, fmtRelative } from '../../lib/format';
import type { Recommendation } from '../../lib/types';

/** Shape returned by services/rebalance.rec_out (all optional so older payloads still render). */
export interface Rec extends Recommendation {
  ambulance_id?: number;
  registration_number?: string | null;
  from_station_id?: number;
  from_station_name?: string | null;
  to_station_id?: number;
  to_station_name?: string | null;
  reason?: string | null;
  expected_gain_seconds?: number | null;
  created_at?: string | null;
}

export function RebalancePanel({ recs, onHover, onChanged }: {
  recs: AsyncState<Rec[]>;
  /** Highlight a recommendation's move on the map. */
  onHover?: (id: number | null) => void;
  onChanged: () => void;
}) {
  const { success, error } = useToast();
  const reduce = useReducedMotion();
  const [busy, setBusy] = useState<number | 'gen' | null>(null);

  const act = async (r: Rec, kind: 'accept' | 'dismiss') => {
    setBusy(r.id);
    try {
      await post(`/rebalance/${r.id}/${kind}`);
      recs.setData((list) => list?.filter((x) => x.id !== r.id) ?? list);
      if (kind === 'accept') success(`${r.registration_number ?? 'Ambulance'} moving to ${r.to_station_name ?? 'new station'}`, { title: 'Repositioning' });
      else success('Recommendation dismissed');
      onChanged();
    } catch (e) { error(e); void recs.reload(); } finally { setBusy(null); }
  };
  const generate = async () => {
    setBusy('gen');
    try {
      const out = await post<Rec[]>('/rebalance/generate');
      await recs.reload();
      if (Array.isArray(out) && out.length === 0) success('Coverage looks balanced — no moves suggested');
    } catch (e) { error(e); } finally { setBusy(null); }
  };

  const list = recs.data ?? [];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-line/70 p-3">
        <p className="text-sm text-ink-500">Moves idle units toward predicted demand.</p>
        <Button size="sm" variant="secondary" icon={Sparkles} loading={busy === 'gen'} onClick={() => void generate()}>Suggest</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
        {recs.loading && !recs.data ? (
          <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-40 w-full" />)}</div>
        ) : recs.error && !recs.data ? (
          <ErrorState compact message={recs.error} onRetry={() => void recs.reload()} />
        ) : list.length === 0 ? (
          <EmptyState compact icon={Shuffle} title="No pending moves" description="Fleet coverage matches predicted demand. Ask for fresh suggestions any time." />
        ) : (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {list.map((r) => (
                <motion.li
                  key={r.id}
                  layout={!reduce}
                  initial={{ opacity: 0, y: reduce ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: reduce ? 0 : -24, transition: { duration: 0.15 } }}
                  onMouseEnter={() => onHover?.(r.id)} onMouseLeave={() => onHover?.(null)}
                  onFocus={() => onHover?.(r.id)} onBlur={() => onHover?.(null)}
                  className="rounded-lg border border-line/80 bg-surface p-3 shadow-card"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm font-bold text-ink-900">
                      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-info-bg text-info-fg" aria-hidden><Ambulance size={16} /></span>
                      {r.registration_number ?? `Unit ${r.ambulance_id ?? ''}`}
                    </p>
                    {r.expected_gain_seconds != null && r.expected_gain_seconds > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-xs font-bold text-success-fg tabular-nums">
                        <TimerReset size={12} aria-hidden />saves {fmtDuration(r.expected_gain_seconds)}
                      </span>
                    )}
                  </div>
                  {/* from → to */}
                  <div className="mt-3 rounded-md bg-canvas px-3 py-2">
                    <p className="flex items-center gap-2 text-sm">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-ink-900" aria-hidden />
                      <span className="text-xs font-semibold text-ink-500">From</span>
                      <span className="truncate font-semibold text-ink-900">{r.from_station_name ?? `Station ${r.from_station_id ?? '?'}`}</span>
                    </p>
                    <ArrowDown size={14} className="my-0.5 ml-[1px] text-ink-400" aria-hidden />
                    <p className="flex items-center gap-2 text-sm">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-info" aria-hidden />
                      <span className="text-xs font-semibold text-ink-500">To</span>
                      <span className="truncate font-semibold text-ink-900">{r.to_station_name ?? `Station ${r.to_station_id ?? '?'}`}</span>
                    </p>
                  </div>
                  {r.reason && <p className="mt-2 text-sm text-ink-700">{r.reason}</p>}
                  <div className="mt-3 flex items-center gap-2">
                    {r.created_at && <span className="mr-auto text-xs text-ink-500">{fmtRelative(r.created_at)}</span>}
                    <Button size="sm" variant="ghost" icon={X} disabled={busy === r.id} onClick={() => void act(r, 'dismiss')}>Dismiss</Button>
                    <Button size="sm" variant="success" icon={Check} loading={busy === r.id} onClick={() => void act(r, 'accept')}>Accept</Button>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  );
}
