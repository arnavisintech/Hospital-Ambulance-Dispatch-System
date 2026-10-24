import type { ReactNode } from 'react';
import { CloudOff, Inbox, Phone, RefreshCw, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from './Button';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Call to action (Button / ButtonLink). */
  action?: ReactNode;
  /** Smaller padding for use inside cards/tables. */
  compact?: boolean;
  className?: string;
}

/** Friendly "nothing here" block: icon in a soft circle + title + description + optional action. */
export function EmptyState({ icon: Icon = Inbox, title, description, action, compact, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center text-center', compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-12', className)}>
      <span className={cn('flex items-center justify-center rounded-full bg-canvas text-ink-500', compact ? 'h-12 w-12' : 'h-16 w-16')} aria-hidden>
        <Icon size={compact ? 22 : 28} />
      </span>
      <div className="max-w-sm">
        <p className={cn('font-semibold text-ink-900', compact ? 'text-base' : 'text-lg')}>{title}</p>
        {description && <p className="mt-1 text-sm text-ink-500">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title?: ReactNode;
  /** Cause + fix, e.g. "Couldn't load hospitals — check your connection." */
  message?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  retrying?: boolean;
  /** Show the "Call 108" fallback (requester emergency screens). */
  showCall108?: boolean;
  compact?: boolean;
  className?: string;
}

/** Error with retry (role="alert"). */
export function ErrorState({ title = "Couldn't load this", message, onRetry, retryLabel = 'Try again', retrying, showCall108, compact, className }: ErrorStateProps) {
  return (
    <div role="alert" className={cn('flex flex-col items-center text-center', compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-12', className)}>
      <span className={cn('flex items-center justify-center rounded-full bg-brand-50 text-brand-500', compact ? 'h-12 w-12' : 'h-16 w-16')} aria-hidden>
        <CloudOff size={compact ? 22 : 28} />
      </span>
      <div className="max-w-sm">
        <p className={cn('font-semibold text-ink-900', compact ? 'text-base' : 'text-lg')}>{title}</p>
        {message && <p className="mt-1 text-sm text-ink-500">{message}</p>}
      </div>
      {(onRetry || showCall108) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onRetry && <Button variant="secondary" size={compact ? 'sm' : 'md'} icon={RefreshCw} loading={retrying} onClick={onRetry}>{retryLabel}</Button>}
          {showCall108 && <Call108Button size={compact ? 'sm' : 'md'} />}
        </div>
      )}
    </div>
  );
}

/** "Call 108" fallback — a real tel: link. Always show on requester emergency screens. */
export function Call108Button({ size = 'md', variant = 'secondary', label = 'Call 108', className }: {
  size?: 'sm' | 'md' | 'lg' | 'xl'; variant?: 'secondary' | 'dark' | 'ghost'; label?: string; className?: string;
}) {
  const sz = { sm: 'h-9 px-3 text-sm', md: 'h-11 px-4 text-md', lg: 'h-12 px-5 text-base', xl: 'h-14 px-6 text-lg' }[size];
  const v = {
    secondary: 'border border-line-strong bg-surface text-ink-900 hover:bg-canvas',
    dark: 'bg-ink-900 text-white hover:bg-ink-700',
    ghost: 'text-ink-700 hover:bg-ink-900/[.05]',
  }[variant];
  return (
    <a href="tel:108" className={cn('press inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors', sz, v, className)}>
      <Phone size={size === 'sm' ? 16 : 18} aria-hidden />
      {label}
    </a>
  );
}
