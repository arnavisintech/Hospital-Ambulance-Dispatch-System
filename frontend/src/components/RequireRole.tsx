import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { decideAccess } from '../lib/guard';
import type { Role } from '../lib/types';
import { Spinner } from './States';

export function RequireRole({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <Spinner label="Checking session" full />;
  const d = decideAccess(user?.role, roles);
  if (!d.allow) return <Navigate to={d.redirect} replace state={d.redirect === '/login' ? { from: loc.pathname } : undefined} />;
  return <>{children}</>;
}
