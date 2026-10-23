import { motion, useReducedMotion } from 'framer-motion';
import { Ambulance, Check, Flag, Hospital, UserCheck, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { PROGRESS_STEPS, progressIndex } from '../../lib/status';

const ICONS: LucideIcon[] = [UserCheck, Ambulance, Hospital, Flag];

export interface ProgressStepsProps {
  /** Request status (mapped via lib/status progressIndex) … */
  status?: string;
  /** … or an explicit index of the latest reached step (-1 none, 4 = all done). */
  current?: number;
  /** Override labels (4 entries). Default Assigned → On the way → Picked up → At hospital. */
  labels?: readonly string[];
  className?: string;
}

/** Horizontal 4-step trip tracker with animated connector (Swiggy-style). */
export function ProgressSteps({ status, current, labels = PROGRESS_STEPS, className }: ProgressStepsProps) {
  const idx = current ?? progressIndex(status);
  const reduce = useReducedMotion();
  const n = labels.length;
  const fill = idx < 0 ? 0 : Math.min(1, idx / (n - 1));
  return (
    <div className={cn('w-full', className)}>
      <ol className="relative grid" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }} aria-label="Trip progress">
        {/* connector track sits between first and last dot centres */}
        <span className="absolute top-4 h-1 -translate-y-1/2 rounded-full bg-line" style={{ left: `${50 / n}%`, right: `${50 / n}%` }} aria-hidden>
          <motion.span
            className="absolute inset-y-0 left-0 rounded-full bg-success"
            initial={false}
            animate={{ width: `${fill * 100}%` }}
            transition={reduce ? { duration: 0 } : { duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          />
        </span>
        {labels.map((label, i) => {
          const done = i < idx || idx >= n;
          const active = i === idx && idx < n;
          const Icon = ICONS[i] ?? Check;
          return (
            <li key={label} className="relative flex flex-col items-center gap-1.5 text-center" aria-current={active ? 'step' : undefined}>
              <span
                className={cn(
                  'relative flex h-8 w-8 items-center justify-center rounded-full border-2 transition-colors duration-standard',
                  done && 'border-success bg-success text-white',
                  active && 'border-brand-500 bg-brand-500 text-white shadow-[0_0_0_5px_rgb(var(--brand-500)/.15)]',
                  !done && !active && 'border-line-strong bg-surface text-ink-400',
                )}
                aria-hidden
              >
                {done ? <Check size={16} strokeWidth={3} /> : <Icon size={15} strokeWidth={2.4} />}
              </span>
              <span className={cn('px-0.5 text-xs leading-tight', active ? 'font-bold text-ink-900' : done ? 'font-semibold text-ink-700' : 'font-medium text-ink-500')}>
                {label}
                <span className="sr-only">{done ? ' (done)' : active ? ' (current)' : ''}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
