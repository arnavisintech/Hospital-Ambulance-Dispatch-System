import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';

const calls: [string, unknown][] = [];
let loggedOut = false;
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 3, name: 'Kavya', role: 'requester', email: 'k@x.in' }, logout: () => { loggedOut = true; } }),
}));
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  api: async (path: string, opts: { method?: string; body?: unknown }) => { calls.push([`${opts.method} ${path}`, opts.body]); return { erased: true }; },
  get: async (path: string) => { calls.push([`GET ${path}`, null]); return { user: { id: 3 }, requests: [] }; },
}));

import Account from '../pages/requester/Account';

const renderPage = () => render(<ToastProvider><MemoryRouter><Account /></MemoryRouter></ToastProvider>);

describe('<Account>', () => {
  it('downloads the export as a JSON file', async () => {
    const url = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL: url, revokeObjectURL: () => undefined });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /download my data/i }));
    await waitFor(() => expect(url).toHaveBeenCalled());
    expect(calls).toContainEqual(['GET /auth/me/export', null]);
  });

  it('erases the account with the password and signs out', async () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /delete my account/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/password/i), { target: { value: 'secret-pass' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /delete permanently/i }));
    await waitFor(() => expect(loggedOut).toBe(true));
    expect(calls).toContainEqual(['DELETE /auth/me', { password: 'secret-pass' }]);
  });
});
