import { useSyncExternalStore } from 'react';

/** Subscribe to a CSS media query. SSR/jsdom safe (returns `fallback` when matchMedia is unavailable). */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const mql = window.matchMedia(query);
      mql.addEventListener?.('change', cb);
      return () => mql.removeEventListener?.('change', cb);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : fallback),
    () => fallback,
  );
}

/** >= 1024px: MobileApp layout switches to "map left, panel right"; sheets render as side panels. */
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)');
/** < 640px */
export const useIsPhone = () => useMediaQuery('(max-width: 639px)');
/** OS "reduce motion" preference. framer-motion's `useReducedMotion` is equivalent inside motion components. */
export const usePrefersReducedMotion = () => useMediaQuery('(prefers-reduced-motion: reduce)');
