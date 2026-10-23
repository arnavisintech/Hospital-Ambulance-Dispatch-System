import type { CreateRequestBody } from './types';

const QUEUE_KEY = 'hads_sos_queue';

export interface QueuedRequest { client_uuid: string; body: CreateRequestBody; queued_at: string; attempts: number }

export function newUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function loadQueue(): QueuedRequest[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedRequest[]) : [];
  } catch { return []; }
}
function save(q: QueuedRequest[]): void {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* ignore */ }
}

export function enqueue(body: CreateRequestBody): QueuedRequest {
  const uuid = body.client_uuid ?? newUuid();
  const item: QueuedRequest = {
    client_uuid: uuid,
    body: { ...body, client_uuid: uuid },
    queued_at: new Date().toISOString(),
    attempts: 0,
  };
  const q = loadQueue().filter((x) => x.client_uuid !== uuid);
  q.push(item);
  save(q);
  return item;
}

export function removeFromQueue(uuid: string): void {
  save(loadQueue().filter((x) => x.client_uuid !== uuid));
}

/** Network-level failure or server 5xx => worth retrying. Other 4xx (validation/auth) => drop. */
export function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === undefined || status === 0 || status >= 500 || status === 408 || status === 429;
}

export type Sender = (body: CreateRequestBody) => Promise<{ id: number }>;

export interface FlushResult { sent: { client_uuid: string; id: number }[]; dropped: string[]; remaining: number }

/** Try to send all queued requests in order; stop at the first retryable failure. */
export async function flushQueue(send: Sender): Promise<FlushResult> {
  const res: FlushResult = { sent: [], dropped: [], remaining: 0 };
  for (const item of loadQueue()) {
    try {
      const out = await send(item.body);
      removeFromQueue(item.client_uuid);
      res.sent.push({ client_uuid: item.client_uuid, id: out.id });
    } catch (e) {
      if (isRetryable(e)) {
        save(loadQueue().map((x) => (x.client_uuid === item.client_uuid ? { ...x, attempts: x.attempts + 1 } : x)));
        break;
      }
      removeFromQueue(item.client_uuid);
      res.dropped.push(item.client_uuid);
    }
  }
  res.remaining = loadQueue().length;
  return res;
}

export function backoffMs(attempt: number, base = 1000, max = 30000): number {
  return Math.min(max, base * 2 ** attempt);
}
