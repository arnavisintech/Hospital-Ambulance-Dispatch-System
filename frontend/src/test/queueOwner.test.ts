import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { clearQueue, enqueue, flushQueue, isRetryable, loadQueue } from '../lib/queue';

const body = { lat: 13.08, lng: 80.27, incident_type: 'cardiac', severity: 4 };

describe('offline queue ownership (final review F5)', () => {
  beforeEach(() => localStorage.clear());

  it('only sends the signed-in user\'s queued SOS', async () => {
    const mine = enqueue(body, 1);
    enqueue(body, 2);
    const send = vi.fn().mockResolvedValue({ id: 9 });
    const res = await flushQueue(send, 1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].client_uuid).toBe(mine.client_uuid);
    expect(res.remaining).toBe(0);
    expect(loadQueue(2)).toHaveLength(1);
  });

  it('keeps a queued SOS when the session expired (401) so it sends after signing back in', async () => {
    expect(isRetryable(new ApiError(401, 'expired'))).toBe(true);
    enqueue(body, 1);
    const res = await flushQueue(vi.fn().mockRejectedValue(new ApiError(401, 'expired')), 1);
    expect(res.dropped).toHaveLength(0);
    expect(loadQueue(1)).toHaveLength(1);
  });

  it('clears only the given owner\'s items', () => {
    enqueue(body, 1); enqueue(body, 2);
    clearQueue(1);
    expect(loadQueue(1)).toHaveLength(0);
    expect(loadQueue(2)).toHaveLength(1);
    clearQueue();
    expect(loadQueue()).toHaveLength(0);
  });
});

describe('stale queued SOS (final review minor)', () => {
  beforeEach(() => localStorage.clear());

  it('never sends an SOS queued more than 30 minutes ago; reports it as expired instead', async () => {
    const old = enqueue(body, 1);
    localStorage.setItem('hads_sos_queue', JSON.stringify(loadQueue().map((x) =>
      ({ ...x, queued_at: new Date(Date.now() - 31 * 60_000).toISOString() }))));
    const fresh = enqueue(body, 1);
    const send = vi.fn().mockResolvedValue({ id: 3 });
    const res = await flushQueue(send, 1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].client_uuid).toBe(fresh.client_uuid);
    expect(res.expired).toEqual([old.client_uuid]);
    expect(loadQueue()).toHaveLength(0);
  });
});
