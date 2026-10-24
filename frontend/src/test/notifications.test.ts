import { describe, expect, it } from 'vitest';
import { applyNotification, markReadLocal, normalizeInbox, type AppNotification } from '../lib/notifications';

const n = (id: number, read = false): AppNotification => ({
  id, type: 'dispatch.offer', title: `t${id}`, body: '', data: {}, created_at: `2026-10-24T00:00:${String(id % 60).padStart(2, '0')}Z`,
  read_at: read ? '2026-10-24T01:00:00Z' : null,
});

describe('applyNotification', () => {
  it('puts the newest first and ignores duplicates', () => {
    const list = applyNotification(applyNotification([], n(1)), n(2));
    expect(list.map((x) => x.id)).toEqual([2, 1]);
    expect(applyNotification(list, n(2)).map((x) => x.id)).toEqual([2, 1]);
  });
  it('keeps at most 50 items', () => {
    let list: AppNotification[] = [];
    for (let i = 1; i <= 60; i++) list = applyNotification(list, n(i));
    expect(list).toHaveLength(50);
    expect(list[0].id).toBe(60);
  });
});

describe('markReadLocal', () => {
  it('marks one item read and is a no-op for an already-read item', () => {
    const list = [n(2), n(1, true)];
    const once = markReadLocal(list, 2, '2026-10-24T02:00:00Z');
    expect(once[0].read_at).toBe('2026-10-24T02:00:00Z');
    expect(markReadLocal(once, 1, 'x')).toBe(once);
  });
});

describe('normalizeInbox', () => {
  it('accepts only an array of notifications', () => {
    expect(normalizeInbox([n(1)])).toHaveLength(1);
    expect(normalizeInbox({ user: {} })).toEqual([]);
    expect(normalizeInbox(null)).toEqual([]);
  });
});
