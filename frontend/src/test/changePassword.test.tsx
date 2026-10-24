import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiError } from '../lib/api';

// Plain delegating function: in this vitest version a throwing module-level vi.fn fails the test even when caught.
let impl: (current: string, next: string) => Promise<unknown> = async () => ({});
const calls: [string, string][] = [];
const changePassword = (current: string, next: string) => { calls.push([current, next]); return impl(current, next); };
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ changePassword }) }));

import { ChangePasswordModal } from '../components/ChangePasswordModal';

const fill = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('<ChangePasswordModal>', () => {
  beforeEach(() => { calls.length = 0; impl = async () => ({}); });

  it('rejects a mismatched confirmation without calling the server', async () => {
    render(<ChangePasswordModal open onClose={() => undefined} />);
    fill(/current password/i, 'old-password');
    fill(/^new password/i, 'new-password-1');
    fill(/confirm new password/i, 'new-password-2');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));
    expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('shows the server error', async () => {
    impl = async () => { throw new ApiError(400, 'Current password is incorrect'); };
    render(<ChangePasswordModal open onClose={() => undefined} />);
    fill(/current password/i, 'wrong-one');
    fill(/^new password/i, 'new-password-1');
    fill(/confirm new password/i, 'new-password-1');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));
    expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument();
  });

  it('calls changePassword and closes on success', async () => {
    const onClose = vi.fn();
    render(<ChangePasswordModal open onClose={onClose} />);
    fill(/current password/i, 'old-password');
    fill(/^new password/i, 'new-password-1');
    fill(/confirm new password/i, 'new-password-1');
    fireEvent.click(screen.getByRole('button', { name: /update password/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls).toEqual([['old-password', 'new-password-1']]);
  });
});
