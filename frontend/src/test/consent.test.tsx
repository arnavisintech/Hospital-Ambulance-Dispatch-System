import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const registered: unknown[] = [];
const register = async (b: unknown) => { registered.push(b); return { id: 1, name: 'x', role: 'requester' }; };
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ register }) }));

import Register from '../pages/Register';

const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('<Register> privacy consent', () => {
  beforeEach(() => { registered.length = 0; });

  it('blocks sign-up until the privacy notice is accepted', async () => {
    render(<MemoryRouter><Register /></MemoryRouter>);
    fill(/full name/i, 'Kavya');
    fill(/^email/i, 'kavya@example.com');
    fill(/^password/i, 'password123');
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByText(/accept the privacy notice/i)).toBeInTheDocument();
    expect(registered).toHaveLength(0);
  });

  it('sends consent: true once accepted', async () => {
    render(<MemoryRouter><Register /></MemoryRouter>);
    fill(/full name/i, 'Kavya');
    fill(/^email/i, 'kavya@example.com');
    fill(/^password/i, 'password123');
    fireEvent.click(screen.getByRole('checkbox', { name: /i agree/i }));
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));
    await waitFor(() => expect(registered).toHaveLength(1));
    expect(registered[0]).toMatchObject({ consent: true, name: 'Kavya', email: 'kavya@example.com' });
  });
});
