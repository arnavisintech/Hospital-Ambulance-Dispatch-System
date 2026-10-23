import { useId, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { toneClasses, type Tone } from '../../lib/status';
import { Skeleton } from './Skeleton';

export interface StatDelta {
  /** Signed change, e.g. -12 or 4.5. */
  value: number;
  /** Suffix, e.g. "%" or " s". */
  unit?: string;
  /** Which direction is good (colours green). Default 'up'. e.g. response time: 'down'. */
  goodWhen?: 'up' | 'down';
  /** e.g. "vs last week". */
  label?: string;
}

export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  delta?: StatDelta;
  /** Tiny inline trend line. */
  sparkline?: number[];
  hint?: ReactNode;
  loading?: boolean;
  className?: string;
}

/** KPI tile: label, big tabular number, optional delta chip, icon, sparkline. */
export function StatCard({ label, value, icon: Icon, tone = 'neutral', delta, sparkline, hint, loading, className }: StatCardProps) {
  const t = toneClasses(tone);
  const good = delta ? (delta.goodWhen ?? 'up') === (delta.value >= 0 ? 'up' : 'down') : false;
  return (
    <div className={cn('flex flex-col gap-3 rounded-lg border border-line/70 bg-surface p-4 shadow-card', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-ink-500">{label}</p>
        {Icon && (
          <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-md', tone === 'neutral' ? 'bg-canvas text-ink-700' : t.soft)} aria-hidden>
            <Icon size={18} />
          </span>
        )}
      </div>
      {loading ? (
        <Skeleton className="h-8 w-24" />
      ) : (
        <div className="flex items-end justify-between gap-3">
          <p className="text-3xl font-extrabold leading-none tracking-tight text-ink-900 tabular-nums">{value}</p>
          {sparkline && sparkline.length > 1 && <Sparkline data={sparkline} tone={tone === 'neutral' ? 'info' : tone} />}
        </div>
      )}
      {(delta || hint) && !loading && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {delta && (
            <span className={cn('inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-bold tabular-nums', good ? 'bg-success-bg text-success-fg' : 'bg-brand-50 text-brand-600')}>
              {delta.value >= 0 ? <ArrowUpRight size={13} aria-hidden /> : <ArrowDownRight size={13} aria-hidden />}
              <span className="sr-only">{delta.value >= 0 ? 'Up' : 'Down'} </span>
              {Math.abs(delta.value)}{delta.unit ?? ''}
            </span>
          )}
          {delta?.label && <span className="text-ink-500">{delta.label}</span>}
          {hint && <span className="text-ink-500">{hint}</span>}
        </div>
      )}
    </div>
  );
}

/** Minimal SVG sparkline with soft area fill (decorative). */
export function Sparkline({ data, tone = 'info', width = 96, height = 32, className }: { data: number[]; tone?: Tone; width?: number; height?: number; className?: string }) {
  const gid = useId();
  if (data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => [(i / (data.length - 1)) * width, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const color = toneClasses(tone).css;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cn('shrink-0 overflow-visible', className)} aria-hidden>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity=".22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${width},${height} L0,${height} Z`} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.5" fill={color} />
    </svg>
  );
}
