import { cn } from '../../lib/cn';

/** Shimmering placeholder block. Size it with className (h-4 w-32, h-24 w-full rounded-lg, …). */
export function Skeleton({ className, rounded = 'md' }: { className?: string; rounded?: 'sm' | 'md' | 'lg' | 'full' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'relative block overflow-hidden bg-line/70',
        { sm: 'rounded-sm', md: 'rounded-md', lg: 'rounded-lg', full: 'rounded-full' }[rounded],
        'before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer',
        'before:bg-gradient-to-r before:from-transparent before:via-white/70 before:to-transparent',
        className,
      )}
    />
  );
}

/** N lines of text placeholder; last line shorter. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={cn('flex flex-col gap-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 && lines > 1 ? 'w-3/5' : 'w-full')} />
      ))}
    </span>
  );
}

/** Card-shaped placeholder (avatar + 2 lines), with an sr-only loading label. */
export function SkeletonCard({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <div className={cn('rounded-lg border border-line/70 bg-surface p-4 shadow-card', className)} role="status" aria-live="polite">
      <span className="sr-only">{label}…</span>
      <div className="flex items-center gap-3">
        <Skeleton className="h-10 w-10" rounded="full" />
        <div className="flex-1"><SkeletonText lines={2} /></div>
      </div>
    </div>
  );
}
