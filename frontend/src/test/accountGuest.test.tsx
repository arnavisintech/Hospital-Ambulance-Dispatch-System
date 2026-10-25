import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';

const calls: [string, unknown][] = [];
let loggedOut = false;
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 9, name: 'Guest', role: 'requester', is_guest: true }, logout: () => { loggedOut = true; } }),
}));
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  api: async (path: string, opts: { method?: string; body?: unknown }) => { calls.push([`${opts.method} ${path}`, opts.body]); return { erased: true }; },
  get: async () => [],
}));

import Account from '../pages/requester/Account';

describe('<Account> for a guest (no password was ever shown to them)', () => {
  it('deletes the account without asking for a password and offers no password change', async () => {
    render(<ToastProvider><MemoryRouter><Account /></MemoryRouter></ToastProvider>);
    expect(screen.queryByRole('button', { name: /change password/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByLabelText(/password/i)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /delete permanently/i }));
    await waitFor(() => expect(loggedOut).toBe(true));
    expect(calls).toContainEqual(['DELETE /auth/me', {}]);
  });
});
