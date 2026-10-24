import { render, screen } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 3, name: 'Kavya', role: 'requester', email: 'k@x.in' }, loading: false,
    login: vi.fn(), register: vi.fn(), guest: vi.fn(), logout: vi.fn(),
  }),
}));
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async (path: string) => (path === '/public/config'
    ? { demo_mode: false, demo_password: null, demo_accounts: [] }
    : path.startsWith('/notifications') || path.startsWith('/requests/mine') ? [] : {}),
  post: async () => ({}),
}));
// jsdom has no ResizeObserver (the bottom sheet measures itself); a no-op is enough for a static audit.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
// Leaflet's own DOM is third-party; the screens around it are what we audit.
vi.mock('../components/map', () => ({ MapCanvas: () => <div data-testid="map" /> }));

import Landing from '../pages/Landing';
import Login from '../pages/Login';
import Register from '../pages/Register';
import Sos from '../pages/requester/Sos';

async function seriousViolations(ui: ReactElement, ready: () => Promise<unknown>) {
  const { container } = render(<ToastProvider><MemoryRouter>{ui}</MemoryRouter></ToastProvider>);
  await ready();
  const res = await axe.run(container, { rules: { region: { enabled: false } } }); // fragments, not full pages
  return res.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

describe('accessibility (axe: no serious or critical violations)', () => {
  it('the audit itself flags a broken control (guards against a vacuous check)', async () => {
    const bad = await seriousViolations(<form><input type="text" /><button type="button" /></form>, async () => undefined);
    expect(bad.some((v) => v.startsWith('label:'))).toBe(true);
    expect(bad.some((v) => v.startsWith('button-name:'))).toBe(true);
  });
  it('Landing', async () => {
    expect(await seriousViolations(<Landing />, () => screen.findByRole('heading', { level: 1 }))).toEqual([]);
  });
  it('Login', async () => {
    expect(await seriousViolations(<Login />, () => screen.findByLabelText(/^email/i))).toEqual([]);
  });
  it('Register', async () => {
    expect(await seriousViolations(<Register />, () => screen.findByLabelText(/^email/i))).toEqual([]);
  });
  it('Sos', async () => {
    expect(await seriousViolations(<Sos />, () => screen.findByTestId('map'))).toEqual([]);
  });
});
