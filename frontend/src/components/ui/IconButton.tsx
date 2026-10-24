import { forwardRef, type ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

export type IconButtonVariant = 'ghost' | 'secondary' | 'primary' | 'floating' | 'danger' | 'dark';
export type IconButtonSize = 'sm' | 'md' | 'lg';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'> {
  /** Required accessible name (also used as the tooltip). */
  label: string;
  icon: LucideIcon;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  loading?: boolean;
  /** Small count badge (e.g. notifications). */
  badge?: number | boolean;
  /** Hide native title tooltip. */
  noTitle?: boolean;
}

const V: Record<IconButtonVariant, string> = {
  ghost: 'text-ink-700 hover:bg-ink-900/[.05] active:bg-ink-900/[.08]',
  secondary: 'bg-surface text-ink-900 border border-line-strong hover:bg-canvas',
  primary: 'bg-brand-500 text-white hover:bg-brand-600',
  floating: 'bg-surface text-ink-900 shadow-raised hover:bg-canvas border border-line/60',
  danger: 'text-brand-600 hover:bg-brand-50',
  dark: 'bg-ink-900 text-white hover:bg-ink-700',
};
// md/lg meet the 44px touch target; sm (36px) is for dense desktop UI.
const S: Record<IconButtonSize, { box: string; icon: number }> = {
  sm: { box: 'h-9 w-9', icon: 18 },
  md: { box: 'h-11 w-11', icon: 20 },
  lg: { box: 'h-12 w-12', icon: 22 },
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon: Icon, variant = 'ghost', size = 'md', loading, badge, noTitle, className, type = 'button', disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={noTitle ? undefined : label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'press relative inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-micro',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2',
        'disabled:pointer-events-none disabled:opacity-50',
        V[variant], S[size].box, className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={S[size].icon} className="text-current" /> : <Icon size={S[size].icon} strokeWidth={2} aria-hidden />}
      {badge ? (
        <span className="absolute -right-0.5 -top-0.5 flex min-w-[18px] items-center justify-center rounded-full bg-brand-500 px-1 text-2xs font-bold leading-[18px] text-white ring-2 ring-surface tabular-nums" aria-hidden>
          {typeof badge === 'number' ? (badge > 99 ? '99+' : badge) : ''}
        </span>
      ) : null}
    </button>
  );
});
