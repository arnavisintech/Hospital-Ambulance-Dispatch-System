import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';

const posted: [string, unknown][] = [];
// A device with GPS that answers at once; installed before Sos.tsx is imported (it checks support at load).
vi.hoisted(() => {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 13.08, longitude: 80.27 } } as GeolocationPosition) },
  });
});
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 3, name: 'Kavya', role: 'requester', email: 'k@x.in' }, loading: false, logout: vi.fn() }),
}));
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async (path: string) => (path.startsWith('/requests/mine') || path.startsWith('/notifications') ? [] : {}),
  post: async (path: string, body: unknown) => { posted.push([path, body]); return { id: 41, status: 'received', estimated_wait_seconds: 360 }; },
}));
vi.mock('../components/map', () => ({ MapCanvas: () => <div data-testid="map" /> }));

import Sos from '../pages/requester/Sos';

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});

describe('<Sos> (NFR5: an SOS within 2 taps of opening the app)', () => {
  it('sends the request with a single tap once GPS has a fix, and shows the receipt', async () => {
    render(
      <ToastProvider><MemoryRouter initialEntries={['/sos']}>
        <Routes><Route path="/sos" element={<Sos />} /><Route path="/track/:id" element={<p>tracking page</p>} /></Routes>
      </MemoryRouter></ToastProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /request ambulance/i }));   // tap 1 (of at most 2)
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0][0]).toBe('/requests');
    expect(posted[0][1]).toMatchObject({ lat: 13.08, lng: 80.27 });
    expect(await screen.findByText('tracking page')).toBeTruthy();
    expect((await screen.findAllByText(/about 6 min away/i)).length).toBeGreaterThan(0);
  });
});
