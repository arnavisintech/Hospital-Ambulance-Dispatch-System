import type { ReactNode } from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { fmtClock } from '../../lib/format';
import { requestStatusMeta, STATUS_ORDER, toneClasses, type Tone } from '../../lib/status';
import type { TimelineEvent } from '../../lib/types';

export interface TimelineItem {
  id?: string | number;
  title: ReactNode;
  description?: ReactNode;
  /** ISO timestamp (rendered as "4:05 pm") or any node. */
  time?: string | ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  /** done = filled check, current = tone ring + pulse, upcoming = hollow grey. Default 'done'. */
  state?: 'done' | 'current' | 'upcoming';
}

/** Vertical timeline with timestamps. */
export function Timeline({ items, className, dense }: { items: TimelineItem[]; className?: string; dense?: boolean }) {
  return (
    <ol className={cn('relative', className)}>
      {items.map((it, i) => {
        const state = it.state ?? 'done';
        const t = toneClasses(it.tone ?? (state === 'done' ? 'success' : state === 'current' ? 'brand' : 'muted'));
        const Icon = it.icon;
        const last = i === items.length - 1;
        return (
          <li key={it.id ?? i} className={cn('relative flex gap-3', !last && (dense ? 'pb-3' : 'pb-5'))} aria-current={state === 'current' ? 'step' : undefined}>
            {!last && (
              <span className={cn('absolute left-[13px] top-7 bottom-0 w-0.5 rounded-full', state === 'done' ? 'bg-success/40' : 'bg-line')} aria-hidden />
            )}
            <span
              className={cn(
                'relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
                state === 'done' && t.solid,
                state === 'current' && cn(t.solid, 'ring-4 ring-brand-500/15'),
                state === 'upcoming' && 'border-2 border-line-strong bg-surface text-ink-400',
              )}
              aria-hidden
            >
              {Icon ? <Icon size={14} strokeWidth={2.5} /> : state === 'done' ? <Check size={14} strokeWidth={3} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <p className={cn('text-sm font-semibold', state === 'upcoming' ? 'text-ink-500' : 'text-ink-900')}>{it.title}</p>
                {it.time && (
                  <span className="shrink-0 text-xs text-ink-500 tabular-nums">
                    {typeof it.time === 'string' ? <time dateTime={it.time}>{fmtClock(it.time)}</time> : it.time}
                  </span>
                )}
              </div>
              {it.description && <p className="mt-0.5 text-sm text-ink-500">{it.description}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Build timeline items for a request from v2 `timeline` events (+ optional upcoming happy-path steps).
 * `consumer` uses calm headlines ("Ambulance on the way") instead of ops labels.
 */
export function requestTimelineItems(
  events: TimelineEvent[] | undefined,
  currentStatus: string,
  { showUpcoming = true, consumer = false }: { showUpcoming?: boolean; consumer?: boolean } = {},
): TimelineItem[] {
  const evs = (events ?? []).slice().sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const items: TimelineItem[] = evs.map((e, i) => {
    const m = requestStatusMeta(e.status);
    const isCurrent = i === evs.length - 1 && !m.terminal;
    return {
      id: `${e.status}-${e.at}`,
      title: consumer ? m.headline : m.label,
      description: e.note ?? undefined,
      time: e.at,
      icon: m.icon,
      tone: isCurrent ? m.tone : m.terminal && m.tone === 'muted' ? 'muted' : 'success',
      state: isCurrent ? 'current' : 'done',
    };
  });
  const cur = requestStatusMeta(currentStatus);
  if (showUpcoming && !cur.terminal) {
    const seen = new Set(evs.map((e) => e.status));
    const from = STATUS_ORDER.indexOf(currentStatus as (typeof STATUS_ORDER)[number]);
    STATUS_ORDER.slice(from + 1)
      .filter((s) => !seen.has(s) && !['matching', 'offered'].includes(s))
      .forEach((s) => {
        const m = requestStatusMeta(s);
        items.push({ id: s, title: consumer ? m.headline : m.label, icon: m.icon, state: 'upcoming' });
      });
  }
  return items;
}
