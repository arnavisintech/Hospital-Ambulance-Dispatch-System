import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label (recommended). Without it pass `ariaLabel`. */
  label?: ReactNode;
  description?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  size?: 'md' | 'lg';
  /** Colour when on. Default success (green) — e.g. crew "On duty". */
  tone?: 'success' | 'brand' | 'info';
  className?: string;
}

const ON = { success: 'bg-success', brand: 'bg-brand-500', info: 'bg-info' };

/** role="switch" toggle. Whole row is clickable when a label is given. */
export function Switch({ checked, onChange, label, description, ariaLabel, disabled, size = 'md', tone = 'success', className }: SwitchProps) {
  const id = useId();
  const track = size === 'lg' ? 'h-8 w-14' : 'h-6 w-11';
  const knob = size === 'lg' ? 'h-6 w-6' : 'h-[18px] w-[18px]';
  const shift = size === 'lg' ? 'translate-x-6' : 'translate-x-5';
  const btn = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      aria-labelledby={label ? `${id}-l` : undefined}
      aria-describedby={description ? `${id}-d` : undefined}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full p-[3px] transition-colors duration-standard',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:opacity-50',
        track, checked ? ON[tone] : 'bg-line-strong',
      )}
    >
      <span className={cn('rounded-full bg-white shadow-card transition-transform duration-standard ease-out', knob, checked ? shift : 'translate-x-0')} aria-hidden />
    </button>
  );
  if (!label) return <span className={className}>{btn}</span>;
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="min-w-0 cursor-pointer" onClick={() => !disabled && onChange(!checked)}>
        <span id={`${id}-l`} className="block text-base font-semibold text-ink-900">{label}</span>
        {description && <span id={`${id}-d`} className="mt-0.5 block text-sm text-ink-500">{description}</span>}
      </div>
      {btn}
    </div>
  );
}
