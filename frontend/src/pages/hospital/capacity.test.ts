import { describe, expect, it } from 'vitest';
import { capacityDiff, etaRemaining, normalizeIncoming, normalizeIncomingList, occupancy, occupancyTone, sortIncoming, specialistsMap } from './capacity';

describe('occupancy thresholds', () => {
  it('maps occupancy to tones', () => {
    expect(occupancyTone(50, 100)).toBe('success'); // 50 %
    expect(occupancyTone(31, 100)).toBe('success'); // 69 %
    expect(occupancyTone(30, 100)).toBe('warning'); // 70 %
    expect(occupancyTone(11, 100)).toBe('warning'); // 89 %
    expect(occupancyTone(10, 100)).toBe('danger'); // 90 %
    expect(occupancyTone(0, 4)).toBe('danger');
    expect(occupancyTone(2, 0)).toBe('muted');
    expect(occupancyTone(undefined, 10)).toBe('muted');
  });
  it('clamps occupancy', () => {
    expect(occupancy(12, 10)).toBe(0);
    expect(occupancy(5, 10)).toBe(0.5);
  });
});

describe('specialists & diff', () => {
  it('normalises dict / list / string', () => {
    expect(specialistsMap({ cardiology: 2, neuro: '1', bad: -3 })).toEqual({ cardiology: 2, neuro: 1, bad: 0 });
    expect(specialistsMap(['trauma'])).toEqual({ trauma: 1 });
    expect(specialistsMap('a, b')).toEqual({ a: 1, b: 1 });
    expect(specialistsMap(null)).toEqual({});
  });
  it('lists changes', () => {
    expect(capacityDiff({ beds: 10, icu: 2, specialists: { cardiology: 1 } }, { beds: 8, icu: 2, specialists: { cardiology: 3 } }))
      .toEqual(['Beds 10 → 8', 'cardiology 1 → 3']);
    expect(capacityDiff({ beds: 1, icu: 1, specialists: {} }, { beds: 1, icu: 1, specialists: {} })).toEqual([]);
  });
});

describe('incoming', () => {
  const base = { status: 'transporting', incident_type: 'stroke', severity: 3, lat: 1, lng: 2, created_at: '2026-01-01T00:00:00Z' };
  it('normalises v2 items and bare v1 requests', () => {
    const v2 = normalizeIncoming({ request: { id: 1, ...base }, eta_seconds: 60, ambulance: { registration_number: 'TN-1' }, crew: { name: 'Ravi' }, reserved: 'icu', acknowledged: true })!;
    expect(v2).toMatchObject({ eta_seconds: 60, reserved: 'icu', acknowledged: true, crew: { name: 'Ravi' } });
    const v1 = normalizeIncoming({ id: 2, ...base, eta_seconds: 30, ambulance: { id: 3, registration_number: 'TN-2' } })!;
    expect(v1).toMatchObject({ eta_seconds: 30, reserved: null, acknowledged: false, ambulance: { registration_number: 'TN-2' } });
    expect(normalizeIncomingList({ items: [{ id: 3, ...base }] })).toHaveLength(1);
    expect(normalizeIncoming({ foo: 1 })).toBeNull();
  });
  it('sorts arrived first, then by ETA, unknown ETA last', () => {
    const list = normalizeIncomingList([
      { id: 1, ...base, eta_seconds: 400 },
      { id: 2, ...base, eta_seconds: null },
      { id: 3, ...base, status: 'arrived', eta_seconds: 0 },
      { id: 4, ...base, eta_seconds: 100 },
    ]);
    expect(sortIncoming(list).map((i) => i.request.id)).toEqual([3, 4, 1, 2]);
  });
  it('counts the ETA down locally', () => {
    expect(etaRemaining(120, 1000, 31000)).toBe(90);
    expect(etaRemaining(10, 0, 60000)).toBe(0);
    expect(etaRemaining(null, 0, 1)).toBeNull();
  });
});
