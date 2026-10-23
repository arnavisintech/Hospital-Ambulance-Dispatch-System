import { cn } from '../../lib/cn';
import { initials } from '../../lib/format';

const PALETTE = [
  'bg-brand-50 text-brand-600', 'bg-info-bg text-info-fg', 'bg-teal-bg text-teal-fg',
  'bg-violet-bg text-violet-fg', 'bg-orange-bg text-orange-fg', 'bg-success-bg text-success-fg',
];
const SIZE = { xs: 'h-6 w-6 text-[10px]', sm: 'h-8 w-8 text-xs', md: 'h-10 w-10 text-sm', lg: 'h-12 w-12 text-base', xl: 'h-16 w-16 text-xl' };

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export interface AvatarProps {
  name?: string | null;
  /** Pre-computed initials (e.g. from the API `crew.initials`). */
  initials?: string;
  src?: string | null;
  size?: keyof typeof SIZE;
  /** Small status dot (bottom-right). */
  status?: 'online' | 'offline' | 'busy';
  className?: string;
}

/** Initials avatar with a stable colour per name. Decorative unless no name text is shown nearby. */
export function Avatar({ name, initials: init, src, size = 'md', status, className }: AvatarProps) {
  const text = init ?? initials(name);
  const tone = PALETTE[hash(name ?? text) % PALETTE.length];
  return (
    <span className={cn('relative inline-flex shrink-0', className)} title={name ?? undefined}>
      {src ? (
        <img src={src} alt={name ?? ''} className={cn('rounded-full object-cover', SIZE[size])} />
      ) : (
        <span className={cn('inline-flex items-center justify-center rounded-full font-bold tracking-wide', SIZE[size], tone)} aria-hidden={!name}>
          {text}
        </span>
      )}
      {status && (
        <span
          className={cn('absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full ring-2 ring-surface',
            status === 'online' ? 'bg-success' : status === 'busy' ? 'bg-warning' : 'bg-ink-400')}
          aria-label={status}
        />
      )}
    </span>
  );
}
