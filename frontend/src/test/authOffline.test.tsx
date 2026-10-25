import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { setToken } from '../lib/api';
import { enqueue, loadQueue } from '../lib/queue';

const ME = { id: 5, name: 'Asha', role: 'requester', email: 'a@hads.test', phone: null };

function Probe() {
  const { user, loading, logout } = useAuth();
  return (
    <div>
      <span data-testid="state">{loading ? 'loading' : user ? `user:${user.name}` : 'none'}</span>
      <button onClick={logout}>out</button>
    </div>
  );
}

describe('session restore offline (final review F1)', () => {
  beforeEach(() => {
    localStorage.clear();
    setToken('tok');
    localStorage.setItem('hads_user', JSON.stringify(ME));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the cached user when the network is down, so the SOS screen still opens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:Asha'));
  });

  it('signs out when the server rejects the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"detail":"expired"}', { status: 401 })));
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('none'));
    expect(localStorage.getItem('hads_user')).toBeNull();
  });

  it('sign-out forgets the cached user and their queued SOS', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(ME), { status: 200 })));
    enqueue({ lat: 13.08, lng: 80.27, incident_type: 'other', severity: 3 }, ME.id);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('user:Asha'));
    screen.getByText('out').click();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('none'));
    expect(localStorage.getItem('hads_user')).toBeNull();
    expect(loadQueue()).toHaveLength(0);
  });
});
