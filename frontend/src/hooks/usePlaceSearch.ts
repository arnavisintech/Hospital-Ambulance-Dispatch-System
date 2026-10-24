import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import type { PlaceResult } from '../lib/types';

interface Found { term: string; items: PlaceResult[]; error: unknown }

/**
 * Debounced locality search (GET /geo/search, offline Chennai gazetteer). Results are keyed by the term they
 * answer, so `loading` is derived (current term not answered yet) and older responses can never overwrite newer.
 * While a new term loads, the previous results stay visible.
 */
export function usePlaceSearch(q: string, delayMs = 300): { results: PlaceResult[] | null; loading: boolean; error: unknown } {
  const term = q.trim();
  const active = term.length >= 2;
  const [found, setFound] = useState<Found | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    const t = setTimeout(() => {
      get<PlaceResult[]>('/geo/search', { q: term })
        .then((r) => { if (alive) setFound({ term, items: Array.isArray(r) ? r : [], error: null }); })
        .catch((e: unknown) => { if (alive) setFound({ term, items: [], error: e }); });
    }, delayMs);
    return () => { alive = false; clearTimeout(t); };
  }, [term, active, delayMs]);

  if (!active) return { results: null, loading: false, error: null };
  const current = found?.term === term;
  return { results: found ? found.items : null, loading: !current, error: current ? found.error : null };
}
