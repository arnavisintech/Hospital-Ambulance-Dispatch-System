import { useId, type KeyboardEvent } from 'react';
import { Minus, Plus } from 'lucide-react';
import { cn } from '../../lib/cn';
import { IconButton } from './IconButton';

export interface StepperProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** Visible label (e.g. "Available beds"). */
  label?: string;
  /** Accessible name when no visible label. */
  ariaLabel?: string;
  helper?: string;
  disabled?: boolean;
  size?: 'md' | 'lg';
  className?: string;
}

/** +/- numeric stepper (role="spinbutton": Arrow keys, PageUp/Down = 10 steps, Home/End). */
export function Stepper({ value, onChange, min = 0, max = Number.MAX_SAFE_INTEGER, step = 1, label, ariaLabel, helper, disabled, size = 'md', className }: StepperProps) {
  const id = useId();
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const set = (v: number) => { const c = clamp(v); if (c !== value) onChange(c); };
  const onKey = (e: KeyboardEvent) => {
    const map: Record<string, number> = { ArrowUp: step, ArrowRight: step, ArrowDown: -step, ArrowLeft: -step, PageUp: step * 10, PageDown: -step * 10 };
    if (e.key in map) { e.preventDefault(); set(value + map[e.key]); }
    else if (e.key === 'Home' && min > Number.MIN_SAFE_INTEGER) { e.preventDefault(); set(min); }
    else if (e.key === 'End' && max < Number.MAX_SAFE_INTEGER) { e.preventDefault(); set(max); }
  };
  return (
    <div className={cn('flex items-center justify-between gap-3', className)}>
      {label && (
        <div className="min-w-0">
          <span id={`${id}-l`} className="block text-sm font-semibold text-ink-900">{label}</span>
          {helper && <span className="block text-xs text-ink-500">{helper}</span>}
        </div>
      )}
      <div className={cn('inline-flex items-center rounded-full border border-line-strong bg-surface p-1', disabled && 'opacity-50')}>
        <IconButton label={`Decrease${label ? ` ${label}` : ''}`} icon={Minus} size="sm" disabled={disabled || value <= min} onClick={() => set(value - step)} tabIndex={-1} />
        <span
          role="spinbutton"
          tabIndex={disabled ? -1 : 0}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max < Number.MAX_SAFE_INTEGER ? max : undefined}
          aria-labelledby={label ? `${id}-l` : undefined}
          aria-label={label ? undefined : ariaLabel}
          aria-disabled={disabled || undefined}
          onKeyDown={disabled ? undefined : onKey}
          className={cn('rounded-md text-center font-bold tabular-nums text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
            size === 'lg' ? 'min-w-[3.5rem] text-2xl' : 'min-w-[2.75rem] text-lg')}
        >
          {value}
        </span>
        <IconButton label={`Increase${label ? ` ${label}` : ''}`} icon={Plus} size="sm" disabled={disabled || value >= max} onClick={() => set(value + step)} tabIndex={-1} />
      </div>
    </div>
  );
}
