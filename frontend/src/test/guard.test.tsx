import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { decideAccess } from '../lib/guard';
import type { Role } from '../lib/types';

let currentRole: Role | null = null;
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: currentRole ? { id: 1, name: 'x', role: currentRole } : null, loading: false }),
}));

import { RequireRole } from '../components/RequireRole';

describe('decideAccess', () => {
  it('redirects anonymous users to login', () => {
    expect(decideAccess(null, ['admin'])).toEqual({ allow: false, redirect: '/login' });
  });
  it('allows matching roles and sends others to their home', () => {
    expect(decideAccess('admin', ['admin'])).toEqual({ allow: true });
    expect(decideAccess('crew', ['admin'])).toEqual({ allow: false, redirect: '/crew' });
    expect(decideAccess('requester', ['controller', 'admin'])).toEqual({ allow: false, redirect: '/sos' });
  });
  it('allows any authenticated role when none specified', () => {
    expect(decideAccess('authority', undefined)).toEqual({ allow: true });
  });
});

describe('<RequireRole>', () => {
  const renderAt = (role: Role | null) => {
    currentRole = role;
    return render(
      <MemoryRouter initialEntries={['/admin']}>
        <Routes>
          <Route path="/admin" element={<RequireRole roles={['admin']}><p>admin area</p></RequireRole>} />
          <Route path="/login" element={<p>login page</p>} />
          <Route path="/controller" element={<p>controller home</p>} />
        </Routes>
      </MemoryRouter>,
    );
  };
  it('renders children for permitted role', () => { renderAt('admin'); expect(screen.getByText('admin area')).toBeInTheDocument(); });
  it('redirects anonymous to /login', () => { renderAt(null); expect(screen.getByText('login page')).toBeInTheDocument(); });
  it('redirects wrong role to own home', () => { renderAt('controller'); expect(screen.getByText('controller home')).toBeInTheDocument(); });
});
