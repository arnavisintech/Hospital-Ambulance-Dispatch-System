import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, api, get, getToken, onUnauthorized, post, setToken } from '../lib/api';
import { clearGuestDevice, guestDeviceId } from '../lib/device';
import { clearQueue } from '../lib/queue';
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

// The last signed-in user, kept with the token so the app (and the SOS screen) still opens without a connection.
const USER_KEY = 'hads_user';
function cachedUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch { return null; }
}
function cacheUser(u: User | null): void {
  try {
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  } catch { /* storage blocked: online-only session restore */ }
}
/** No answer from the server (offline, gateway down): the session may still be valid. */
const unreachable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 500);

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(() => !!getToken());
  const setUser = useCallback((u: User | null) => { cacheUser(u); setUserState(u); }, []);
  const userRef = useRef<User | null>(null);
  useEffect(() => { userRef.current = user; }, [user]);

  // Explicit sign-out (also after erasure) forgets this user's unsent SOS; an expired session (401) keeps it.
  const logout = useCallback(() => {
    if (userRef.current) clearQueue(userRef.current.id);
    setToken(null); setUser(null); clearGuestDevice();
  }, [setUser]);

  useEffect(() => {
    onUnauthorized(() => setUser(null));
    return () => onUnauthorized(null);
  }, [setUser]);

  useEffect(() => {
    if (!getToken()) return; // `loading` already started false: there is no session to restore
    let alive = true;
    get<User>('/auth/me')
      .then((u) => { if (alive) setUser(u); })
      .catch((e) => {
        if (!alive) return;
        // Offline: carry on as the cached user (the token is re-checked on the next request). 401 is handled globally.
        setUser(unreachable(e) && getToken() ? cachedUser() : null);
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [setUser]);

  const accept = useCallback((r: TokenResponse) => { setToken(r.token); setUser(r.user); return r.user; }, [setUser]);

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
  }), [user, loading, logout, accept]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
