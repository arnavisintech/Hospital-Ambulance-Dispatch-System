import { cn } from '../../lib/cn';

/** Inline circular spinner (decorative; announce loading via surrounding text / aria-busy). */
export function Spinner({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={cn('animate-spin text-brand-500', className)} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Centered loading block with a polite live label. */
export function LoadingBlock({ label = 'Loading', className, full }: { label?: string; className?: string; full?: boolean }) {
  return (
    <div role="status" aria-live="polite" className={cn('flex items-center justify-center gap-3 p-6 text-sm text-ink-500', full && 'min-h-[50vh]', className)}>
      <Spinner size={20} />
      <span>{label}…</span>
    </div>
  );
}
