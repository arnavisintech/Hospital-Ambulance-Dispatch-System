import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: null, loading: false }),
}));
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async () => ({}),
  api: async () => ({}),
}));

import App from '../App';

const at = (path: string) => render(<ToastProvider><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></ToastProvider>);

describe('routes', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('does not expose the component gallery in production builds', async () => {
    vi.stubEnv('DEV', false);
    at('/dev/ui');
    expect(await screen.findByRole('heading', { name: /couldn't find that page/i })).toBeTruthy();
  });

  it('serves the landing page at /', async () => {
    vi.stubEnv('DEV', false);
    at('/');
    expect(await screen.findByRole('heading', { name: /an ambulance in minutes/i })).toBeTruthy();
  });
});
