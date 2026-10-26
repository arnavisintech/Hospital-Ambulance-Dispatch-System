import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientConfig } from '../lib/types';

const login = vi.fn().mockResolvedValue({ id: 1, name: 'x', role: 'admin' });
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ login, guest: vi.fn() }) }));

let config: ClientConfig = { demo_mode: false, demo_password: null, demo_accounts: [] };
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: vi.fn(async () => config),
}));

import Login from '../pages/Login';

const DEMO: ClientConfig = {
  demo_mode: true,
  demo_password: 'pw-from-server',
  demo_accounts: [
    { role: 'requester', label: 'Requester', email: 'user@hads.in', hint: 'Request' },
    { role: 'crew', label: 'Crew', email: 'crew1@hads.in', hint: 'Trips' },
    { role: 'hospital_staff', label: 'Hospital', email: 'staff1@hads.in', hint: 'Beds' },
    { role: 'controller', label: 'Controller', email: 'controller@hads.in', hint: 'Board' },
    { role: 'admin', label: 'Admin', email: 'admin@hads.in', hint: 'Setup' },
    { role: 'authority', label: 'Authority', email: 'authority@hads.in', hint: 'KPIs' },
  ],
};

const renderLogin = () => render(<MemoryRouter><Login /></MemoryRouter>);

describe('<Login> demo accounts', () => {
  afterEach(() => { login.mockClear(); });

  it('shows one card per demo role when the server is in demo mode', async () => {
    config = DEMO;
    renderLogin();
    expect(await screen.findAllByRole('button', { name: /sign in as demo/i })).toHaveLength(6);
    expect(screen.getByText('pw-from-server')).toBeInTheDocument();
  });

  it('logs in with the card email and the server-provided password', async () => {
    config = DEMO;
    renderLogin();
    fireEvent.click(await screen.findByRole('button', { name: /sign in as demo crew/i }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('crew1@hads.in', 'pw-from-server'));
  });

  it('shows no demo cards outside demo mode', async () => {
    config = { demo_mode: false, demo_password: null, demo_accounts: [] };
    renderLogin();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument());
    expect(screen.queryByRole('list', { name: /demo accounts/i })).toBeNull();
    expect(screen.queryByText(/demo password/i)).toBeNull();
  });
});

describe('<Login> resilience (final review minor)', () => {
  it('still renders when the server lists a role this client does not know', async () => {
    config = { ...DEMO, demo_accounts: [...DEMO.demo_accounts, { role: 'auditor' as never, label: 'Auditor', email: 'aud@hads.in', hint: 'New' }] };
    renderLogin();
    expect(await screen.findAllByRole('button', { name: /sign in as demo/i })).toHaveLength(7);
  });
});

describe('<Login> demo hospital and ambulance choice', () => {
  afterEach(() => { login.mockClear(); });

  it('signs in as the hospital or ambulance picked, so a demo can open the one a trip was sent to', async () => {
    config = {
      ...DEMO,
      demo_choices: {
        hospital_staff: [{ email: 'staff1@hads.in', label: 'Rajiv Gandhi Government General Hospital' }, { email: 'staff7@hads.in', label: 'Gleneagles Global Health City' }],
        crew: [{ email: 'crew1@hads.in', label: 'TN-09-AM-4137 · BLS · T. Nagar Station' }, { email: 'crew12@hads.in', label: 'TN-07-AM-4248 · ALS · Adyar Station' }],
      },
    };
    renderLogin();
    const hospital = await screen.findByLabelText(/choose demo hospital/i);
    expect((hospital as HTMLSelectElement).value).toBe('staff1@hads.in');   // unchanged default
    fireEvent.change(hospital, { target: { value: 'staff7@hads.in' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in as demo hospital/i }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('staff7@hads.in', 'pw-from-server'));
    cleanup();   // a successful sign-in navigates away; start again for the crew card
    renderLogin();
    fireEvent.change(await screen.findByLabelText(/choose demo ambulance/i), { target: { value: 'crew12@hads.in' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in as demo crew/i }));
    await waitFor(() => expect(login).toHaveBeenCalledWith('crew12@hads.in', 'pw-from-server'));
  });
});
