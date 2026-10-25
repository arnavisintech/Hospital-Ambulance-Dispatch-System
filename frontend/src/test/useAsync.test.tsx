import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useAsync } from '../hooks/useAsync';

describe('useAsync', () => {
  it('never lets an older response overwrite the result for newer deps', async () => {
    const resolvers: Record<number, (v: string) => void> = {};
    const load = (page: number) => new Promise<string>((res) => { resolvers[page] = res; });
    const { result, rerender } = renderHook(({ page }) => useAsync(() => load(page), [page]), { initialProps: { page: 1 } });
    rerender({ page: 2 });                            // user clicked "Next" before page 1 arrived
    await act(async () => { resolvers[2]('page 2'); });
    await waitFor(() => expect(result.current.data).toBe('page 2'));
    await act(async () => { resolvers[1]('page 1'); }); // the slow, older response lands last
    expect(result.current.data).toBe('page 2');
    expect(result.current.loading).toBe(false);
  });
});
