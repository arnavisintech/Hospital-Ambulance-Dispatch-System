import type { Role } from './types';

export const ROLE_HOME: Record<Role, string> = {
  requester: '/sos',
  crew: '/crew',
  hospital_staff: '/hospital',
  controller: '/controller',
  admin: '/admin',
  authority: '/authority',
};

export type GuardResult = { allow: true } | { allow: false; redirect: string };

/** Pure role-guard decision used by <RequireRole>. */
export function decideAccess(role: Role | null | undefined, allowed: Role[] | undefined): GuardResult {
  if (!role) return { allow: false, redirect: '/login' };
  if (!allowed || allowed.length === 0 || allowed.includes(role)) return { allow: true };
  return { allow: false, redirect: ROLE_HOME[role] };
}
