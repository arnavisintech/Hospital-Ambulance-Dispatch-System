/** In-app notifications (GET /api/notifications, pushed on websocket topic user:{id}). */
export interface AppNotification {
  id: number;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  created_at: string | null;
  read_at: string | null;
}

export const MAX_NOTIFICATIONS = 50;

/** Merge one notification into the list: newest first, no duplicates, capped. */
export function applyNotification(list: AppNotification[], incoming: AppNotification): AppNotification[] {
  if (list.some((x) => x.id === incoming.id)) return list;
  return [incoming, ...list].sort((a, b) => b.id - a.id).slice(0, MAX_NOTIFICATIONS);
}

/** Optimistically mark one item read; returns the same array when nothing changes. */
export function markReadLocal(list: AppNotification[], id: number, at: string): AppNotification[] {
  const hit = list.find((x) => x.id === id);
  if (!hit || hit.read_at) return list;
  return list.map((x) => (x.id === id ? { ...x, read_at: at } : x));
}

/** Where a notification should take the user, if anywhere. */
export function notificationLink(n: AppNotification, role: string): string | null {
  const rid = typeof n.data.request_id === 'number' ? n.data.request_id : null;
  if (role === 'requester' && rid) return `/track/${rid}`;
  if (role === 'crew') return '/crew';
  if (role === 'hospital_staff') return '/hospital';
  if ((role === 'controller' || role === 'admin') && rid) return '/controller';
  return null;
}

/** Defensive parse of GET /notifications: anything that is not a list is treated as an empty inbox. */
export function normalizeInbox(data: unknown): AppNotification[] {
  return Array.isArray(data) ? (data as AppNotification[]).filter((x) => x && typeof x.id === 'number') : [];
}
