import { forwardRef } from 'react';
import { AlertTriangle, Ambulance, Clock, MapPin, Phone } from 'lucide-react';
import { Badge, SeverityBadge, StatusPill } from '../../components/ui';
import { cn } from '../../lib/cn';
import { fmtClockTimer, fmtEta } from '../../lib/format';
import { incidentMeta, severityMeta, toneClasses } from '../../lib/status';
import type { RequestOut } from '../../lib/types';
import { ageSeconds } from './board';

export interface RequestCardProps {
  r: RequestOut;
  now: number;
  selected?: boolean;
  escalated?: boolean;
  onSelect: (id: number) => void;
}

/** Compact live request card for the console list. The whole card is one button. */
export const RequestCard = forwardRef<HTMLButtonElement, RequestCardProps>(function RequestCard({ r, now, selected, escalated, onSelect }, ref) {
  const inc = incidentMeta(r.incident_type);
  const sev = severityMeta(r.severity);
  const Icon = inc.icon;
  const age = ageSeconds(r, now);
  const slow = age !== null && age > (escalated ? 60 : 600);
  const place = r.zone_label || r.address || `${r.lat.toFixed(3)}, ${r.lng.toFixed(3)}`;
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(r.id)}
      aria-current={selected ? 'true' : undefined}
      aria-label={`Request ${r.id}, ${inc.short}, ${sev.label}, ${place}`}
      className={cn(
        'press group relative w-full rounded-lg border bg-surface p-3 text-left transition-[box-shadow,border-color,background-color] duration-micro',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
        selected ? 'border-ink-900 shadow-raised' : 'border-line/80 shadow-card hover:border-line-strong hover:shadow-raised',
        escalated && !selected && 'border-brand-200 bg-brand-50/60',
      )}
    >
      {escalated && <span className="absolute inset-y-3 left-0 w-1 rounded-r-full bg-brand-500" aria-hidden />}
      <div className="flex items-start gap-3">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-md', toneClasses(sev.tone).soft)} aria-hidden>
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm font-bold text-ink-900">
              {inc.short} <span className="font-semibold text-ink-500 tabular-nums">#{r.id}</span>
            </p>
            <span className={cn('inline-flex shrink-0 items-center gap-1 text-xs font-semibold tabular-nums', slow ? 'text-danger-fg' : 'text-ink-500')} title="Time since request">
              <Clock size={12} aria-hidden />{fmtClockTimer(age)}
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs font-medium text-ink-500">
            <MapPin size={12} aria-hidden className="shrink-0" />
            <span className="truncate">{place}</span>
            {r.channel === 'ivr' && <span className="ml-1 inline-flex items-center gap-0.5 rounded-sm bg-canvas px-1 text-[11px] font-semibold text-ink-700"><Phone size={10} aria-hidden />IVR</span>}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {escalated ? <Badge tone="danger" icon={AlertTriangle}>Escalated</Badge> : <StatusPill status={r.status} />}
            <SeverityBadge severity={r.severity} showLevel />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2 border-t border-line/70 pt-2 text-xs">
            {r.ambulance ? (
              <span className="flex min-w-0 items-center gap-1.5 font-semibold text-ink-700">
                <Ambulance size={14} aria-hidden className="shrink-0 text-ink-500" />
                <span className="truncate">{r.ambulance.registration_number}</span>
              </span>
            ) : (
              <span className={cn('font-semibold', escalated ? 'text-danger-fg' : 'text-ink-500')}>{escalated ? 'Needs a unit' : 'Unassigned'}</span>
            )}
            {r.ambulance && r.eta_seconds != null && (
              <span className="shrink-0 rounded-full bg-ink-900 px-2 py-0.5 font-bold text-white tabular-nums">ETA {fmtEta(r.eta_seconds)}</span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
});
