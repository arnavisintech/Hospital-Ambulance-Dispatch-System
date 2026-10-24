import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { get, post } from '../lib/api';
import { applyNotification, markReadLocal, normalizeInbox, type AppNotification } from '../lib/notifications';
import type { WsMessage } from '../lib/types';
import { useSocket } from './useSocket';

interface Inbox { uid: number | null; items: AppNotification[] }

/** Signed-in user's inbox: loaded on mount and on every websocket (re)connect, live updates on user:{id}. */
export function useNotifications() {
  const { user } = useAuth();
  // Keyed on the id, not the object: a provider that hands out a fresh user object per render must not refetch.
  const uid = user?.id ?? null;
  const [inbox, setInbox] = useState<Inbox>({ uid: null, items: [] });
  // Items belong to the user they were loaded for: after sign-out / switching user the old list is never shown.
  const items = inbox.uid === uid ? inbox.items : [];
  const update = useCallback((f: (xs: AppNotification[]) => AppNotification[]) =>
    setInbox((s) => ({ ...s, items: f(s.items) })), []);

  const onMessage = useCallback((m: WsMessage) => {
    if (m.type === 'notification') update((xs) => applyNotification(xs, m.data as unknown as AppNotification));
  }, [update]);
  const { connected } = useSocket(uid ? [`user:${uid}`] : [], onMessage, !!uid);

  useEffect(() => {
    if (!uid) return;
    let live = true;
    get<unknown>('/notifications', { limit: 50 })
      .then((d) => { if (live) setInbox({ uid, items: normalizeInbox(d) }); })
      .catch(() => { /* keep what we have; the next (re)connect reloads */ });
    return () => { live = false; };
  }, [uid, connected]);

  const markRead = useCallback(async (id: number) => {
    update((xs) => markReadLocal(xs, id, new Date().toISOString()));
    try { await post(`/notifications/${id}/read`); } catch { /* next load reconciles */ }
  }, [update]);
  const markAll = useCallback(async () => {
    const at = new Date().toISOString();
    update((xs) => xs.map((x) => (x.read_at ? x : { ...x, read_at: at })));
    try { await post('/notifications/read-all'); } catch { /* next load reconciles */ }
  }, [update]);

  return { items, unread: items.filter((x) => !x.read_at).length, markRead, markAll };
}
