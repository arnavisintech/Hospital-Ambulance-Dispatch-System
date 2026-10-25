import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, get, getToken, onUnauthorized, post, setToken } from '../lib/api';
import { clearGuestDevice, guestDeviceId } from '../lib/device';
import type { TokenResponse, User } from '../lib/types';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<User>;
  register: (b: { name: string; phone?: string; email?: string; password: string; consent: boolean }) => Promise<User>;
  guest: (b?: { name?: string; phone?: string }) => Promise<User>;
  logout: () => void;
  /** Change own password; the server revokes other sessions and returns a fresh token. */
  changePassword: (current: string, next: string) => Promise<User>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !!getToken());

  const logout = useCallback(() => { setToken(null); setUser(null); clearGuestDevice(); }, []);

  useEffect(() => {
    onUnauthorized(() => setUser(null));
    return () => onUnauthorized(null);
  }, []);

  useEffect(() => {
    if (!getToken()) return; // `loading` already started false: there is no session to restore
    let alive = true;
    get<User>('/auth/me')
      .then((u) => { if (alive) setUser(u); })
      .catch(() => { /* 401 handled globally; other errors leave user logged out */ if (alive) setUser(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const accept = (r: TokenResponse) => { setToken(r.token); setUser(r.user); return r.user; };

  const value = useMemo<AuthCtx>(() => ({
    user,
    loading,
    logout,
    login: async (identifier, password) =>
      accept(await api<TokenResponse>('/auth/login', { method: 'POST', body: { identifier, password }, auth: false })),
    register: async (b) => accept(await post<TokenResponse>('/auth/register', b)),
    guest: async (b = {}) => accept(await post<TokenResponse>('/auth/guest', { ...b, device_id: guestDeviceId() })),
    changePassword: async (current, next) =>
      accept(await post<TokenResponse>('/auth/password', { current_password: current, new_password: next })),
  }), [user, loading, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
