import type { CreateRequestBody } from './types';

const QUEUE_KEY = 'hads_sos_queue';
/** A queued SOS older than this is not sent: the caller has likely moved on or called 108, and an ambulance sent
 *  hours later would go to an empty address. */
export const QUEUE_MAX_AGE_MS = 30 * 60 * 1000;

/** `owner` is the user who queued it: only that user's session ever sends it (shared phones). */
export interface QueuedRequest { client_uuid: string; body: CreateRequestBody; queued_at: string; attempts: number; owner?: number }

export function newUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function loadAll(): QueuedRequest[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedRequest[]) : [];
  } catch { return []; }
}

/** Queued requests, optionally only those belonging to `owner`. */
export function loadQueue(owner?: number): QueuedRequest[] {
  const all = loadAll();
  return owner === undefined ? all : all.filter((x) => x.owner === owner);
}
function save(q: QueuedRequest[]): void {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* ignore */ }
}

export function enqueue(body: CreateRequestBody, owner?: number): QueuedRequest {
  const uuid = body.client_uuid ?? newUuid();
  const item: QueuedRequest = {
    client_uuid: uuid,
    body: { ...body, client_uuid: uuid },
    queued_at: new Date().toISOString(),
    attempts: 0,
    owner,
  };
  const q = loadAll().filter((x) => x.client_uuid !== uuid);
  q.push(item);
  save(q);
  return item;
}

export function removeFromQueue(uuid: string): void {
  save(loadAll().filter((x) => x.client_uuid !== uuid));
}

/** Forget queued requests on sign-out or erasure: all of them, or only `owner`'s. */
export function clearQueue(owner?: number): void {
  save(owner === undefined ? [] : loadAll().filter((x) => x.owner !== owner));
}

/** Network-level failure, server 5xx, or an expired session (401: kept until the same user signs back in) =>
 *  worth retrying. Other 4xx (validation, forbidden) => drop. */
export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === undefined || status === 0 || status >= 500 || status === 401 || status === 408 || status === 429;
}

export type Sender = (body: CreateRequestBody) => Promise<{ id: number }>;

export interface FlushResult { sent: { client_uuid: string; id: number }[]; dropped: string[]; expired: string[]; remaining: number }

/** Try to send all queued requests in order; stop at the first retryable failure. */
export async function flushQueue(send: Sender, owner?: number): Promise<FlushResult> {
  const res: FlushResult = { sent: [], dropped: [], expired: [], remaining: 0 };
  for (const item of loadQueue(owner)) {
    if (Date.now() - Date.parse(item.queued_at) > QUEUE_MAX_AGE_MS) {
      removeFromQueue(item.client_uuid);
      res.expired.push(item.client_uuid);
      continue;
    }
    try {
      const out = await send(item.body);
      removeFromQueue(item.client_uuid);
      res.sent.push({ client_uuid: item.client_uuid, id: out.id });
    } catch (e) {
      if (isRetryable(e)) {
        save(loadAll().map((x) => (x.client_uuid === item.client_uuid ? { ...x, attempts: x.attempts + 1 } : x)));
        break;
      }
      removeFromQueue(item.client_uuid);
      res.dropped.push(item.client_uuid);
    }
  }
  res.remaining = loadQueue(owner).length;
  return res;
}

export function backoffMs(attempt: number, base = 1000, max = 30000): number {
  return Math.min(max, base * 2 ** attempt);
}
