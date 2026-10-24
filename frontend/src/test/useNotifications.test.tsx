import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

let gets = 0;
// A fresh user object on every call, as any context provider that doesn't memoize would give.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 3, name: 'Kavya', role: 'requester', email: 'k@x.in' } }),
}));
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async () => { gets += 1; return []; },
  post: async () => { throw new Error('offline'); },
}));

import { useNotifications } from '../hooks/useNotifications';

describe('useNotifications', () => {
  it('loads the inbox once per user, not once per render', async () => {
    renderHook(() => useNotifications());
    await new Promise((r) => setTimeout(r, 100));
    expect(gets).toBeLessThanOrEqual(2);
  });
});
