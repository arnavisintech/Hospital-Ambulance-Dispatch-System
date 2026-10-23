import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import {
  ambulanceStatusMeta, genericStatusMeta, incidentMeta, requestStatusMeta, severityMeta, toneClasses, type Tone,
} from '../../lib/status';

export interface BadgeProps {
  tone?: Tone;
  /** 'soft' (tinted, default), 'solid', or 'outline'. */
  variant?: 'soft' | 'solid' | 'outline';
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  /** Leading coloured dot instead of an icon. */
  dot?: boolean;
  /** Animate the dot (live states). */
  pulse?: boolean;
  className?: string;
  children: ReactNode;
  title?: string;
}

/** Generic pill. For statuses prefer <StatusPill>, for severity <SeverityBadge>. */
export function Badge({ tone = 'neutral', variant = 'soft', size = 'sm', icon: Icon, dot, pulse, className, children, title }: BadgeProps) {
  const t = toneClasses(tone);
  return (
    <span
      title={title}
      className={cn(
        'inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full font-semibold leading-none',
        size === 'sm' ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-sm',
        variant === 'soft' && t.soft,
        variant === 'solid' && t.solid,
        variant === 'outline' && cn('border bg-surface', t.border, t.text),
        className,
      )}
    >
      {dot && (
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          {pulse && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', t.dot)} />}
          <span className={cn('relative h-2 w-2 rounded-full', variant === 'solid' ? 'bg-white' : t.dot)} />
        </span>
      )}
      {Icon && <Icon size={size === 'sm' ? 13 : 15} strokeWidth={2.4} aria-hidden className="shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

export interface StatusPillProps {
  status: string;
  /** Which status vocabulary: request (default), ambulance, or generic (billing/claims/accounts). */
  kind?: 'request' | 'ambulance' | 'generic';
  size?: 'sm' | 'md';
  variant?: 'soft' | 'solid' | 'outline';
  /** Use the calm consumer headline ("Ambulance on the way") instead of the ops label. Request kind only. */
  headline?: boolean;
  className?: string;
}

/** Status = colour + icon + label, sourced from lib/status.ts. */
export function StatusPill({ status, kind = 'request', size = 'sm', variant = 'soft', headline, className }: StatusPillProps) {
  if (kind === 'ambulance') {
    const m = ambulanceStatusMeta(status);
    return <Badge tone={m.tone} size={size} variant={variant} icon={m.icon} className={className}>{m.label}</Badge>;
  }
  if (kind === 'generic') {
    const g = genericStatusMeta(status);
    return <Badge tone={g.tone} size={size} variant={variant} dot className={className}>{g.label}</Badge>;
  }
  const m = requestStatusMeta(status);
  return (
    <Badge tone={m.tone} size={size} variant={variant} icon={m.icon} className={className}>
      {headline ? m.headline : m.label}
    </Badge>
  );
}

/** Severity as words ("Critical"), never bare numbers. `showLevel` appends "· 4/5" for ops screens. */
export function SeverityBadge({ severity, size = 'sm', variant = 'soft', showLevel, className }: {
  severity: number; size?: 'sm' | 'md'; variant?: 'soft' | 'solid' | 'outline'; showLevel?: boolean; className?: string;
}) {
  const m = severityMeta(severity);
  return (
    <Badge tone={m.tone} size={size} variant={variant} dot className={className} title={m.description}>
      {m.label}{showLevel ? <span className="ml-1 opacity-70 tabular-nums">{m.level}/5</span> : null}
    </Badge>
  );
}

/** Incident type chip with its icon. */
export function IncidentBadge({ type, size = 'sm', short, className }: { type: string; size?: 'sm' | 'md'; short?: boolean; className?: string }) {
  const m = incidentMeta(type);
  return <Badge tone="neutral" size={size} icon={m.icon} className={className}>{short ? m.short : m.label}</Badge>;
}
