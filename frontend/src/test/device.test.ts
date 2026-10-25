import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearGuestDevice, guestDeviceId } from '../lib/device';

describe('guestDeviceId (a short-lived retry key, never a lasting credential)', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());

  it('is a long random id, reused for retries within the window', () => {
    const a = guestDeviceId();
    expect(a).toMatch(/^[A-Za-z0-9-]{32,64}$/);
    expect(guestDeviceId()).toBe(a);
  });

  it('expires after 10 minutes, so the next person on a shared phone gets a new guest', () => {
    vi.useFakeTimers();
    const a = guestDeviceId();
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(guestDeviceId()).not.toBe(a);
  });

  it('is forgotten on sign-out', () => {
    const a = guestDeviceId();
    clearGuestDevice();
    expect(guestDeviceId()).not.toBe(a);
  });
});
