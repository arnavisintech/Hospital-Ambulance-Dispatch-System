import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let fail = false;
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async (_p: string, q: { q: string }) => {
    calls.push(q.q);
    if (fail) throw new Error('down');
    return [{ label: `${q.q} result`, lat: 13, lng: 80 }];
  },
}));

import { usePlaceSearch } from '../hooks/usePlaceSearch';

describe('usePlaceSearch', () => {
  it('ignores terms shorter than two characters', () => {
    const { result } = renderHook(() => usePlaceSearch('a', 0));
    expect(result.current).toEqual({ results: null, loading: false, error: null });
  });

  it('is loading until the debounced search for the current term returns', async () => {
    const { result, rerender } = renderHook(({ q }) => usePlaceSearch(q, 0), { initialProps: { q: 'adyar' } });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.results?.[0].label).toBe('adyar result'));
    expect(result.current.loading).toBe(false);
    rerender({ q: 'adyar ' });                        // same trimmed term: no new search
    expect(result.current.loading).toBe(false);
    rerender({ q: 'guindy' });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.results?.[0].label).toBe('guindy result'));
  });

  it('reports a failure as an empty list with the error', async () => {
    fail = true;
    const { result } = renderHook(() => usePlaceSearch('velachery', 0));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.results).toEqual([]);
    expect(result.current.error).toBeInstanceOf(Error);
    fail = false;
  });
});
