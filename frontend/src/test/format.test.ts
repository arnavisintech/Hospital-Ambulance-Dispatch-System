import { describe, expect, it } from 'vitest';
import {
  fmtArrival, fmtClockTimer, fmtDistance, fmtDuration, fmtEta, fmtMeters, fmtMoney, fmtPhone, fmtRelative, initials, pct,
} from '../lib/format';

describe('ETA', () => {
  it('formats chip text, rounding up', () => {
    expect(fmtEta(null)).toBe('--');
    expect(fmtEta(-5)).toBe('--');
    expect(fmtEta(30)).toBe('<1 min');
    expect(fmtEta(60)).toBe('1 min');
    expect(fmtEta(181)).toBe('4 min');
    expect(fmtEta(3600)).toBe('1 h');
    expect(fmtEta(3900)).toBe('1 h 5 min');
  });
  it('formats arrival headline', () => {
    expect(fmtArrival(240)).toBe('Arriving in 4 min');
    expect(fmtArrival(20)).toBe('Arriving now');
    expect(fmtArrival(undefined)).toBe('Arriving soon');
    expect(fmtArrival(600, 'Reaching hospital')).toBe('Reaching hospital in 10 min');
  });
});

describe('durations', () => {
  it('formats elapsed durations and timers', () => {
    expect(fmtDuration(45)).toBe('45 s');
    expect(fmtDuration(380)).toBe('6 min 20 s');
    expect(fmtDuration(600)).toBe('10 min');
    expect(fmtDuration(3840)).toBe('1 h 4 min');
    expect(fmtClockTimer(247)).toBe('04:07');
    expect(fmtClockTimer(3729)).toBe('1:02:09');
  });
});

describe('relative time', () => {
  const now = new Date('2026-10-12T10:00:00Z').getTime();
  it('formats past and future', () => {
    expect(fmtRelative(now - 10_000, now)).toBe('just now');
    expect(fmtRelative(now - 120_000, now)).toBe('2 min ago');
    expect(fmtRelative(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(fmtRelative(now - 30 * 3600_000, now)).toBe('Yesterday');
    expect(fmtRelative(now - 4 * 86400_000, now)).toBe('4 d ago');
    expect(fmtRelative(now - 40 * 86400_000, now)).toMatch(/Sept? 2026|2 Sep/);
    expect(fmtRelative(now + 5 * 60_000, now)).toBe('in 5 min');
    expect(fmtRelative(null, now)).toBe('--');
    expect(fmtRelative('garbage', now)).toBe('--');
  });
});

describe('money, distance, misc', () => {
  it('formats rupees with Indian grouping', () => {
    expect(fmtMoney(1250)).toBe('₹1,250');
    expect(fmtMoney(125000)).toBe('₹1,25,000');
    expect(fmtMoney(99.5)).toBe('₹99.5');
    expect(fmtMoney(undefined)).toBe('--');
  });
  it('formats distance', () => {
    expect(fmtDistance(0.853)).toBe('850 m');
    expect(fmtDistance(0.001)).toBe('10 m');
    expect(fmtDistance(4.24)).toBe('4.2 km');
    expect(fmtDistance(12.6)).toBe('13 km');
    expect(fmtMeters(1500)).toBe('1.5 km');
    expect(fmtDistance(null)).toBe('--');
  });
  it('percent, initials, phone', () => {
    expect(pct(0.875)).toBe('87.5%');
    expect(pct(42, 1, 'percent')).toBe('42.0%');
    expect(pct(0.8, 1, 'percent')).toBe('0.8%');
    expect(initials('Priya Raman')).toBe('PR');
    expect(initials('admin@hads.in')).toBe('A');
    expect(initials('')).toBe('?');
    expect(fmtPhone('9840012345')).toBe('+91 98400 12345');
    expect(fmtPhone('+91 98400-12345')).toBe('+91 98400 12345');
  });
});
