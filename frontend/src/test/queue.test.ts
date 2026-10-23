import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { backoffMs, enqueue, flushQueue, isRetryable, loadQueue } from '../lib/queue';
import { densify, nextTripStatus } from '../lib/geo';

const body = { lat: 13.08, lng: 80.27, incident_type: 'cardiac', severity: 4 };

describe('offline queue', () => {
  beforeEach(() => localStorage.clear());

  it('stores requests with a client_uuid', () => {
    const it1 = enqueue(body);
    expect(it1.client_uuid).toMatch(/[0-9a-f-]{36}/);
    expect(loadQueue()).toHaveLength(1);
    expect(loadQueue()[0].body.client_uuid).toBe(it1.client_uuid);
  });

  it('flush sends and removes items, reusing the same client_uuid', async () => {
    const q = enqueue(body);
    const send = vi.fn().mockResolvedValue({ id: 7 });
    const res = await flushQueue(send);
    expect(send.mock.calls[0][0].client_uuid).toBe(q.client_uuid);
    expect(res.sent).toEqual([{ client_uuid: q.client_uuid, id: 7 }]);
    expect(loadQueue()).toHaveLength(0);
  });

  it('keeps item and stops on network failure, counting attempts', async () => {
    enqueue(body); enqueue(body);
    const send = vi.fn().mockRejectedValue(new ApiError(0, 'net'));
    const res = await flushQueue(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(res.remaining).toBe(2);
    expect(loadQueue()[0].attempts).toBe(1);
  });

  it('drops items rejected with a non-retryable 4xx', async () => {
    enqueue(body);
    const res = await flushQueue(vi.fn().mockRejectedValue(new ApiError(422, 'bad')));
    expect(res.dropped).toHaveLength(1);
    expect(loadQueue()).toHaveLength(0);
  });

  it('classifies retryable errors', () => {
    expect(isRetryable(new ApiError(0, ''))).toBe(true);
    expect(isRetryable(new ApiError(503, ''))).toBe(true);
    expect(isRetryable(new ApiError(400, ''))).toBe(false);
    expect(isRetryable(new ApiError(401, ''))).toBe(false);
  });

  it('backs off exponentially with a cap', () => {
    expect([0, 1, 2, 3].map((n) => backoffMs(n))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffMs(20)).toBe(30000);
  });
});

describe('trip helpers', () => {
  it('follows the forward-only state machine', () => {
    expect(nextTripStatus('accepted')).toBe('en_route');
    expect(nextTripStatus('en_route')).toBe('on_scene');
    expect(nextTripStatus('on_scene')).toBe('transporting');
    expect(nextTripStatus('transporting')).toBe('arrived');
    expect(nextTripStatus('arrived')).toBeNull();
    expect(nextTripStatus('completed')).toBeNull();
  });

  it('densifies polylines for simulated driving', () => {
    const out = densify([[13.0, 80.0], [13.01, 80.0]], 200);
    expect(out.length).toBeGreaterThan(5);
    expect(out[0]).toEqual([13.0, 80.0]);
    expect(out[out.length - 1]).toEqual([13.01, 80.0]);
  });
});
