import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { errMsg } from '../lib/api';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  setData: Dispatch<SetStateAction<T | null>>;
}

/** Load data on mount / when deps change. `pollMs` enables silent background refresh. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = [], pollMs = 0): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // New deps mean a fresh (non-silent) load: flip `loading` while rendering, not in an effect afterwards.
  const [prevDeps, setPrevDeps] = useState(deps);
  if (!sameDeps(prevDeps, deps)) {
    setPrevDeps(deps);
    setLoading(true);
  }
  const fnRef = useRef(fn);
  useLayoutEffect(() => { fnRef.current = fn; });
  // Each deps change (and unmount) starts a new generation; a response from an older one is dropped, so a slow
  // earlier request can never overwrite newer data (e.g. paging quickly through Records).
  const gen = useRef(0);

  const run = useCallback(async (g: number) => {
    try {
      const d = await fnRef.current();
      if (gen.current === g) { setData(d); setError(null); }
    } catch (e) {
      if (gen.current === g) setError(errMsg(e));
    } finally {
      if (gen.current === g) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const counter = gen;   // a generation counter, not a DOM ref: bumping it in cleanup is the point
    const g = ++counter.current;
    void run(g);
    let t: ReturnType<typeof setInterval> | undefined;
    if (pollMs > 0) t = setInterval(() => void run(g), pollMs);
    return () => { counter.current++; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(() => run(gen.current), [run]);
  return { data, error, loading, reload, setData };
}

function sameDeps(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
}
