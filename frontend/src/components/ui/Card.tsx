import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** Inner padding. Default 'md' (16px). */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Hover lift + pointer, for clickable cards (still render a <button>/<Link> inside or pass onClick + role). */
  interactive?: boolean;
  /** 'raised' adds stronger elevation (floating cards over the map). 'flat' = border only. */
  elevation?: 'flat' | 'card' | 'raised';
  as?: 'div' | 'section' | 'article' | 'li' | 'aside';
}

const PAD = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-5 sm:p-6' };
const ELEV = { flat: '', card: 'shadow-card', raised: 'shadow-raised' };

/** White rounded surface (radius lg = 16px). */
export const Card = forwardRef<HTMLElement, CardProps>(function Card(
  { padding = 'md', interactive, elevation = 'card', as: As = 'div', className, ...rest },
  ref,
) {
  return (
    <As
      ref={ref as never}
      className={cn(
        'rounded-lg border border-line/70 bg-surface',
        PAD[padding], ELEV[elevation],
        interactive && 'press cursor-pointer transition-shadow duration-standard hover:shadow-raised',
        className,
      )}
      {...rest}
    />
  );
});

export interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  /** Right-aligned slot (button, link, pill). */
  action?: ReactNode;
  className?: string;
  /** Heading level for the title (default h3). */
  as?: 'h2' | 'h3' | 'h4';
}

export function CardHeader({ title, subtitle, icon: Icon, action, className, as: H = 'h3' }: CardHeaderProps) {
  return (
    <div className={cn('mb-3 flex items-start gap-3', className)}>
      {Icon && (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-canvas text-ink-700" aria-hidden>
          <Icon size={18} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <H className="truncate text-base font-semibold text-ink-900">{title}</H>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Thin divider respecting card padding. */
export function Divider({ className }: { className?: string }) {
  return <hr className={cn('my-3 border-0 border-t border-line', className)} />;
}
