import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline' | 'dark';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brand-500 text-white shadow-[0_6px_16px_-6px_rgb(var(--brand-500)/.55)] hover:bg-brand-600 active:bg-brand-700',
  secondary: 'bg-surface text-ink-900 border border-line-strong hover:bg-canvas hover:border-ink-400',
  outline: 'bg-transparent text-brand-600 border border-brand-200 hover:bg-brand-50',
  ghost: 'bg-transparent text-ink-700 hover:bg-ink-900/[.05] active:bg-ink-900/[.08]',
  danger: 'bg-surface text-brand-600 border border-brand-200 hover:bg-brand-50',
  success: 'bg-success-fg text-white shadow-[0_6px_16px_-6px_rgb(var(--success)/.5)] hover:brightness-95',
  dark: 'bg-ink-900 text-white hover:bg-ink-700',
};

// 44px min touch target from md up. `sm` (36px) is for dense desktop tables/toolbars only.
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-sm gap-1.5 rounded-sm',
  md: 'h-11 px-4 text-md gap-2 rounded-md',
  lg: 'h-12 px-5 text-base gap-2 rounded-md',
  xl: 'h-14 px-6 text-lg gap-2.5 rounded-lg',
};
const ICON: Record<ButtonSize, number> = { sm: 16, md: 18, lg: 20, xl: 22 };

export interface ButtonStyleProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}

/** Class string for anything that should look like a button (e.g. an <a> or router <Link>). */
export function buttonClasses({ variant = 'primary', size = 'md', fullWidth }: ButtonStyleProps = {}, extra?: string): string {
  return cn(
    'press relative inline-flex select-none items-center justify-center whitespace-nowrap font-semibold',
    'transition-[background-color,border-color,color,box-shadow,transform,filter] duration-micro ease-out',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    VARIANT[variant], SIZE[size], fullWidth && 'w-full', extra,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyleProps {
  /** Shows a spinner, keeps the width, sets aria-busy and disables the button. */
  loading?: boolean;
  /** Leading lucide icon. */
  icon?: LucideIcon;
  /** Trailing lucide icon. */
  iconRight?: LucideIcon;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', fullWidth, loading, icon: Icon, iconRight: IconRight, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  const s = ICON[size];
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, fullWidth }, className)}
      {...rest}
    >
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
          <Spinner size={s} className={variant === 'primary' || variant === 'success' || variant === 'dark' ? 'text-white' : 'text-ink-500'} />
        </span>
      )}
      <span className={cn('inline-flex items-center justify-center gap-[inherit]', loading && 'invisible')}>
        {Icon && <Icon size={s} strokeWidth={2.2} aria-hidden className="shrink-0" />}
        {children}
        {IconRight && <IconRight size={s} strokeWidth={2.2} aria-hidden className="shrink-0" />}
      </span>
    </button>
  );
});

export interface ButtonLinkProps extends LinkProps, ButtonStyleProps {
  icon?: LucideIcon;
  iconRight?: LucideIcon;
}

/** A react-router <Link> styled as a Button. */
export function ButtonLink({ variant = 'primary', size = 'md', fullWidth, icon: Icon, iconRight: IconRight, className, children, ...rest }: ButtonLinkProps) {
  const s = ICON[size];
  return (
    <Link className={buttonClasses({ variant, size, fullWidth }, className)} {...rest}>
      {Icon && <Icon size={s} strokeWidth={2.2} aria-hidden className="shrink-0" />}
      {children}
      {IconRight && <IconRight size={s} strokeWidth={2.2} aria-hidden className="shrink-0" />}
    </Link>
  );
}
