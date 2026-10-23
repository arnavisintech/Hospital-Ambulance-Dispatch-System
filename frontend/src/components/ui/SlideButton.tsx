import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useTransform, type PanInfo } from 'framer-motion';
import { Check, ChevronsRight, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { Tone } from '../../lib/status';
import { Spinner } from './Spinner';
import { SPRING } from './Modal';

type SlideTone = Extract<Tone, 'brand' | 'success' | 'info' | 'warning' | 'violet' | 'orange' | 'teal'>;

const TONE: Record<SlideTone, { track: string; fill: string; knobIcon: string; text: string }> = {
  brand: { track: 'bg-brand-50', fill: 'bg-brand-500', knobIcon: 'text-brand-500', text: 'text-brand-600' },
  success: { track: 'bg-success-bg', fill: 'bg-success', knobIcon: 'text-success', text: 'text-success-fg' },
  info: { track: 'bg-info-bg', fill: 'bg-info', knobIcon: 'text-info', text: 'text-info-fg' },
  warning: { track: 'bg-warning-bg', fill: 'bg-warning', knobIcon: 'text-warning', text: 'text-warning-fg' },
  violet: { track: 'bg-violet-bg', fill: 'bg-violet', knobIcon: 'text-violet', text: 'text-violet-fg' },
  orange: { track: 'bg-orange-bg', fill: 'bg-orange', knobIcon: 'text-orange', text: 'text-orange-fg' },
  teal: { track: 'bg-teal-bg', fill: 'bg-teal', knobIcon: 'text-teal', text: 'text-teal-fg' },
};

export interface SlideButtonProps {
  /** e.g. "Slide to start trip". Also the accessible name. */
  label: string;
  /** Called once when the slide completes (or Enter/Space on the focused knob). May return a promise. */
  onConfirm: () => void | Promise<unknown>;
  tone?: SlideTone;
  /** Icon on the knob. Default ChevronsRight. */
  icon?: LucideIcon;
  /** Shown briefly after success. Default "Done". */
  confirmedLabel?: string;
  disabled?: boolean;
  /** Fraction of the track that counts as "confirmed". Default 0.85. */
  threshold?: number;
  className?: string;
}

const KNOB = 52;
const PAD = 4;

/**
 * Slide-to-confirm (crew status changes, SOS confirm alternative). Prevents accidental taps:
 * a pointer tap on the knob does nothing; the user must slide. Keyboard / assistive tech: focus the knob and
 * press Enter or Space (a deliberate action) — announced via aria-describedby.
 */
export function SlideButton({
  label, onConfirm, tone = 'brand', icon: Icon = ChevronsRight, confirmedLabel = 'Done', disabled, threshold = 0.85, className,
}: SlideButtonProps) {
  const track = useRef<HTMLDivElement>(null);
  const [max, setMax] = useState(0);
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const x = useMotionValue(0);
  const reduce = useReducedMotion();
  const hintId = useId();
  const t = TONE[tone];
  const labelOpacity = useTransform(x, (v) => (max ? Math.max(0, 1 - v / (max * 0.7)) : 1));
  const fillWidth = useTransform(x, (v) => v + KNOB + PAD * 2);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => setMax(Math.max(0, el.clientWidth - KNOB - PAD * 2));
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  const to = (v: number) => (reduce ? x.set(v) : void animate(x, v, SPRING));

  const confirm = async () => {
    if (disabled || state !== 'idle') return;
    to(max);
    setState('loading');
    try {
      await onConfirm();
      if (!alive.current) return;
      setState('done');
      setTimeout(() => { if (alive.current) { setState('idle'); to(0); } }, 1100);
    } catch {
      if (!alive.current) return;
      setState('idle');
      to(0);
    }
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const v = x.get() + info.velocity.x * 0.05;
    if (max > 0 && v >= max * threshold) void confirm();
    else to(0);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void confirm(); }
  };
  // Keyboard/AT-synthesised clicks have detail === 0; real pointer taps must slide instead.
  const onClick = (e: MouseEvent) => { if (e.detail === 0) void confirm(); };

  const busy = state !== 'idle';
  return (
    <div
      ref={track}
      className={cn('relative h-[60px] w-full select-none overflow-hidden rounded-full', t.track, disabled && 'opacity-50', className)}
    >
      <motion.div className={cn('absolute inset-y-0 left-0 rounded-full', t.fill)} style={{ width: fillWidth, opacity: 0.18 }} aria-hidden />
      <motion.span
        style={{ opacity: state === 'done' ? 1 : labelOpacity }}
        className={cn('pointer-events-none absolute inset-0 flex items-center justify-center pl-12 pr-4 text-base font-bold', t.text)}
        aria-hidden
      >
        {state === 'done' ? confirmedLabel : label}
      </motion.span>
      <span id={hintId} className="sr-only">Slide right, or press Enter, to confirm.</span>
      <motion.button
        type="button"
        aria-label={label}
        aria-describedby={hintId}
        aria-busy={state === 'loading' || undefined}
        disabled={disabled}
        drag={disabled || busy ? false : 'x'}
        dragConstraints={{ left: 0, right: max }}
        dragElastic={0}
        dragMomentum={false}
        onDragEnd={onDragEnd}
        onKeyDown={onKeyDown}
        onClick={onClick}
        style={{ x, width: KNOB, height: KNOB, top: PAD, left: PAD }}
        className={cn(
          'absolute flex cursor-grab touch-none items-center justify-center rounded-full shadow-raised active:cursor-grabbing',
          'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-500/40',
          state === 'done' ? cn(t.fill, 'text-white') : cn('bg-surface', t.knobIcon),
        )}
      >
        {state === 'loading' ? <Spinner size={22} className="text-current" /> : state === 'done' ? <Check size={24} strokeWidth={3} aria-hidden /> : <Icon size={24} strokeWidth={2.4} aria-hidden />}
      </motion.button>
      <span className="sr-only" role="status" aria-live="polite">{state === 'loading' ? 'Confirming…' : state === 'done' ? confirmedLabel : ''}</span>
    </div>
  );
}
