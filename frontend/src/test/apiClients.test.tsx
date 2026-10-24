import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';

const posted: [string, unknown][] = [];
let clients = [
  { id: 1, name: 'TN 108 CAD', is_active: true, created_at: '2026-10-01T10:00:00+00:00', last_used_at: '2026-10-24T09:00:00+00:00' },
  { id: 2, name: 'Old 102 link', is_active: false, created_at: '2026-09-01T10:00:00+00:00', last_used_at: null },
];
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async () => clients,
  post: async (path: string, body: unknown) => {
    posted.push([path, body]);
    if (path === '/admin/api-clients') {
      const c = { id: 3, name: (body as { name: string }).name, is_active: true, created_at: '2026-10-25T10:00:00+00:00', last_used_at: null };
      clients = [...clients, c];
      return { ...c, api_key: 'hads_NEWKEY123' };
    }
    if (path.endsWith('/rotate')) return { ...clients[0], api_key: 'hads_ROTATED456' };
    return { ...clients[0], is_active: false };
  },
}));

import { ApiClientsCard } from '../pages/admin/shared/ApiClientsCard';

const renderCard = () => render(<ToastProvider><ApiClientsCard /></ToastProvider>);

describe('<ApiClientsCard> (NFR8: keys for 108/102 centres)', () => {
  it('lists centres with status and last use', async () => {
    renderCard();
    const row = (await screen.findByText('TN 108 CAD')).closest('li')!;
    expect(within(row).getByText(/active/i)).toBeTruthy();
    expect(within(screen.getByText('Old 102 link').closest('li')!).getByText(/deactivated/i)).toBeTruthy();
  });

  it('creates a client and shows its key exactly once', async () => {
    renderCard();
    await screen.findByText('TN 108 CAD');
    fireEvent.change(screen.getByLabelText(/centre name/i), { target: { value: 'Chennai 102' } });
    fireEvent.click(screen.getByRole('button', { name: /create key/i }));
    await waitFor(() => expect(posted).toContainEqual(['/admin/api-clients', { name: 'Chennai 102' }]));
    expect(await screen.findByText('hads_NEWKEY123')).toBeTruthy();
    expect(screen.getByText(/will not be shown again/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    await waitFor(() => expect(screen.queryByText('hads_NEWKEY123')).toBeNull());
  });

  it('rotates and deactivates after confirmation', async () => {
    renderCard();
    const row = (await screen.findByText('TN 108 CAD')).closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: /rotate/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^rotate key$/i }));
    expect(await screen.findByText('hads_ROTATED456')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /done/i }));
    fireEvent.click(within(row).getByRole('button', { name: /deactivate/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^deactivate centre$/i }));
    await waitFor(() => expect(posted).toContainEqual(['/admin/api-clients/1/deactivate', {}]));
  });
});
