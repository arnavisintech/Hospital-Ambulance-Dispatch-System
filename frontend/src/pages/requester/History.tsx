import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { ChevronRight, Hospital, Siren } from 'lucide-react';
import { MobileAppLayout } from '../../components/layout/MobileAppLayout';
import { ButtonLink, EmptyState, ErrorState, SkeletonCard, StatusPill } from '../../components/ui';
import { useAsync } from '../../hooks/useAsync';
import { get } from '../../lib/api';
import { cn } from '../../lib/cn';
import { fmtClock, fmtDate } from '../../lib/format';
import { incidentMeta, isLiveTrip, requestStatusMeta, severityMeta } from '../../lib/status';
import type { RequestOut } from '../../lib/types';

/** My trips: active request pinned on top, then past trips newest first. Tap → /track/:id (live or summary). */
export default function History() {
  const state = useAsync(() => get<RequestOut[]>('/requests/mine'), []);
  const reduce = useReducedMotion();
  const list = (state.data ?? []).slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const isActive = (r: RequestOut) => isLiveTrip(r.status) || requestStatusMeta(r.status).searching;
  const active = list.filter(isActive);
  const past = list.filter((r) => !isActive(r));

  return (
    <MobileAppLayout title="My trips" back="/sos" width="md"
      bottomBar={<ButtonLink to="/sos" size="lg" fullWidth icon={Siren}>Request an ambulance</ButtonLink>}>
      {state.loading && !state.data ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading trips"><SkeletonCard /><SkeletonCard /><SkeletonCard /></div>
      ) : state.error && !state.data ? (
        <ErrorState title="Couldn't load your trips" message={`${state.error}. Check your connection and try again.`} onRetry={() => void state.reload()} />
      ) : list.length === 0 ? (
        <EmptyState icon={Siren} title="No trips yet" description="When you request an ambulance, you'll be able to track it and see the summary here." />
      ) : (
        <div className="space-y-6">
          {active.length > 0 && (
            <section aria-labelledby="h-active">
              <h2 id="h-active" className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">In progress</h2>
              <ul className="space-y-3">{active.map((r, i) => <TripRow key={r.id} r={r} i={i} reduce={!!reduce} live />)}</ul>
            </section>
          )}
          {past.length > 0 && (
            <section aria-labelledby="h-past">
              <h2 id="h-past" className="mb-2 text-sm font-bold uppercase tracking-wide text-ink-500">Past trips</h2>
              <ul className="space-y-3">{past.map((r, i) => <TripRow key={r.id} r={r} i={i} reduce={!!reduce} />)}</ul>
            </section>
          )}
        </div>
      )}
    </MobileAppLayout>
  );
}

function TripRow({ r, i, reduce, live }: { r: RequestOut; i: number; reduce: boolean; live?: boolean }) {
  const m = incidentMeta(r.incident_type);
  const sev = severityMeta(r.severity);
  return (
    <motion.li
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 8) * 0.04, duration: 0.22 } }}
    >
      <Link
        to={`/track/${r.id}`}
        className={cn(
          'press flex items-center gap-3 rounded-lg border bg-surface p-4 shadow-card transition-shadow duration-standard hover:shadow-raised',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
          live ? 'border-info/40' : 'border-line/70',
        )}
      >
        <span className={cn('flex h-12 w-12 shrink-0 items-center justify-center rounded-full', live ? 'bg-info-bg text-info-fg' : 'bg-canvas text-ink-700')} aria-hidden>
          <m.icon size={22} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-bold text-ink-900">{m.label}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-500">
            <StatusPill status={r.status} headline={live} />
            <span><time dateTime={r.created_at}>{fmtDate(r.created_at)}, {fmtClock(r.created_at)}</time> · {sev.label}</span>
          </span>
          {r.destination_hospital && (
            <span className="mt-1 flex items-center gap-1.5 text-sm text-ink-700">
              <Hospital size={14} className="shrink-0 text-teal-fg" aria-hidden />
              <span className="truncate">{r.destination_hospital.name}</span>
            </span>
          )}
        </span>
        <ChevronRight size={20} className="shrink-0 text-ink-400" aria-hidden />
      </Link>
    </motion.li>
  );
}
