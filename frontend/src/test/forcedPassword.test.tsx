import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const logout = vi.fn();
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, name: 'A', role: 'crew', must_change_password: true }, logout, changePassword: async () => ({}) }),
}));

import { ForcedPasswordChange } from '../components/ChangePasswordModal';

const at = (path: string) => render(<MemoryRouter initialEntries={[path]}><ForcedPasswordChange /></MemoryRouter>);

describe('forced password change (final review F6)', () => {
  it.each(['/sos', '/track/12', '/crew', '/crew/trip'])('never blocks the emergency screen %s', (path) => {
    at(path);
    expect(screen.queryByText('Set a new password')).not.toBeInTheDocument();
  });

  it('blocks other screens but offers a way to sign out', () => {
    at('/admin');
    expect(screen.getByText('Set a new password')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));
    expect(logout).toHaveBeenCalled();
  });
});
