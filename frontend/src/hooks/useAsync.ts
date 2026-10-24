import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
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
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const alive = useRef(true);

  const run = useCallback(async (silent: boolean) => {
    if (!silent) setLoading(true);
    try {
      const d = await fnRef.current();
      if (alive.current) { setData(d); setError(null); }
    } catch (e) {
      if (alive.current) setError(errMsg(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void run(false);
    let t: ReturnType<typeof setInterval> | undefined;
    if (pollMs > 0) t = setInterval(() => void run(true), pollMs);
    return () => { alive.current = false; if (t) clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const reload = useCallback(() => run(true), [run]);
  return { data, error, loading, reload, setData };
}
