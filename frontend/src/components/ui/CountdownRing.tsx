import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { toneClasses, type Tone } from '../../lib/status';

export interface CountdownRingProps {
  /** Total duration in seconds (ring = 100%). */
  total: number;
  /** Controlled remaining seconds … */
  remaining?: number;
  /** … or an absolute deadline (ISO / epoch ms) — the ring ticks itself. */
  endsAt?: string | number;
  onExpire?: () => void;
  size?: number;
  stroke?: number;
  /** Colour; automatically turns warning < 33% and danger < 15% unless `fixedTone`. */
  tone?: Tone;
  fixedTone?: boolean;
  /** Centre content; defaults to whole seconds. */
  children?: ReactNode;
  /** Small caption under the number, e.g. "sec". */
  caption?: string;
  className?: string;
}

/** SVG countdown ring (crew offer timeout, auto-escalation timers). */
export function CountdownRing({ total, remaining, endsAt, onExpire, size = 64, stroke = 6, tone = 'brand', fixedTone, children, caption, className }: CountdownRingProps) {
  const deadline = endsAt !== undefined ? new Date(endsAt).getTime() : null;
  const [now, setNow] = useState(() => Date.now());
  const expired = useRef(false);
  const onExpireRef = useRef(onExpire);
  useEffect(() => { onExpireRef.current = onExpire; });

  useEffect(() => {
    if (deadline === null) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [deadline]);

  const left = Math.max(0, deadline !== null ? (deadline - now) / 1000 : remaining ?? total);
  const frac = total > 0 ? Math.min(1, left / total) : 0;

  useEffect(() => {
    if (left <= 0 && !expired.current) { expired.current = true; onExpireRef.current?.(); }
    if (left > 0) expired.current = false;
  }, [left]);

  const autoTone: Tone = fixedTone ? tone : frac < 0.15 ? 'danger' : frac < 0.33 ? 'warning' : tone;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const secs = Math.ceil(left);
  return (
    <div
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
      role="timer"
      aria-label={`${secs} seconds remaining`}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--line))" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={toneClasses(autoTone).css} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - frac)}
          style={{ transition: 'stroke-dashoffset 250ms linear, stroke 220ms ease' }}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none" aria-hidden>
        {children ?? <span className={cn('font-extrabold tabular-nums text-ink-900', size >= 72 ? 'text-2xl' : 'text-lg')}>{secs}</span>}
        {caption && <span className="mt-0.5 text-3xs font-semibold uppercase tracking-wide text-ink-500">{caption}</span>}
      </span>
    </div>
  );
}
