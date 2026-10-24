import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { get, post } from '../lib/api';
import { applyNotification, markReadLocal, normalizeInbox, type AppNotification } from '../lib/notifications';
import type { WsMessage } from '../lib/types';
import { useSocket } from './useSocket';

/** Signed-in user's inbox: loaded on mount and on every websocket (re)connect, live updates on user:{id}. */
export function useNotifications() {
  const { user } = useAuth();
  // Keyed on the id, not the object: a provider that hands out a fresh user object per render must not refetch.
  const uid = user?.id ?? null;
  const [items, setItems] = useState<AppNotification[]>([]);

  const load = useCallback(async () => {
    try { setItems(normalizeInbox(await get<unknown>('/notifications', { limit: 50 }))); } catch { /* keep what we have */ }
  }, []);

  const onMessage = useCallback((m: WsMessage) => {
    if (m.type === 'notification') setItems((xs) => applyNotification(xs, m.data as unknown as AppNotification));
  }, []);
  const { connected } = useSocket(uid ? [`user:${uid}`] : [], onMessage, !!uid);

  useEffect(() => { if (uid && connected) void load(); }, [uid, connected, load]);
  useEffect(() => { if (uid) void load(); else setItems([]); }, [uid, load]);

  const markRead = useCallback(async (id: number) => {
    setItems((xs) => markReadLocal(xs, id, new Date().toISOString()));
    try { await post(`/notifications/${id}/read`); } catch { /* next load reconciles */ }
  }, []);
  const markAll = useCallback(async () => {
    const at = new Date().toISOString();
    setItems((xs) => xs.map((x) => (x.read_at ? x : { ...x, read_at: at })));
    try { await post('/notifications/read-all'); } catch { /* next load reconciles */ }
  }, []);

  return { items, unread: items.filter((x) => !x.read_at).length, markRead, markAll };
}
