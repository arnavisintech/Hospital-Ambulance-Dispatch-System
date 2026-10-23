// Legacy async-state helpers, re-skinned on the v2 UI kit. New code: use LoadingBlock / ErrorState / EmptyState.
import type { ReactNode } from 'react';
import { EmptyState, ErrorState } from './ui/EmptyState';
import { LoadingBlock } from './ui/Spinner';

export function Spinner({ label = 'Loading', full = false }: { label?: string; full?: boolean }) {
  return <LoadingBlock label={label} full={full} />;
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return <ErrorState compact message={error} onRetry={onRetry} />;
}

export function Empty({ children, title = 'Nothing here yet' }: { children?: ReactNode; title?: string }) {
  return <EmptyState compact title={title} description={children} />;
}

/** Convenience: renders spinner / error / empty / content for an async state. */
export function Async<T>({
  state, children, isEmpty, emptyText,
}: {
  state: { data: T | null; loading: boolean; error: string | null; reload: () => void };
  children: (d: T) => ReactNode;
  isEmpty?: (d: T) => boolean;
  emptyText?: string;
}) {
  if (state.loading && state.data === null) return <Spinner />;
  if (state.error && state.data === null) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (state.data === null) return null;
  if (isEmpty?.(state.data)) return <Empty title={emptyText} />;
  return <>{children(state.data)}</>;
}
