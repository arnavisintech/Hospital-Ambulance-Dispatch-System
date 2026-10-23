import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';

const posted: [string, unknown][] = [];
let bills = [
  { id: 41, trip_id: 9, request_id: 120, amount: 1157.5, payment_status: 'pending', insurance_claim_status: null },
];
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async () => bills,
  post: async (path: string, body: unknown) => { posted.push([path, body]); bills = []; return {}; },
}));

import { PaymentsDue } from '../pages/hospital/PaymentsDue';

describe('<PaymentsDue>', () => {
  it('lists pending bills and records a payment with method and reference', async () => {
    render(<ToastProvider><PaymentsDue /></ToastProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /mark bill 41 received/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Cash' }));
    fireEvent.change(within(dialog).getByLabelText(/receipt or utr/i), { target: { value: 'RCPT-9' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /confirm payment/i }));
    await waitFor(() => expect(posted).toEqual([['/billing/41/pay', { method: 'cash', reference: 'RCPT-9' }]]));
    expect(await screen.findByText(/no payments due/i)).toBeInTheDocument();
  });
});
