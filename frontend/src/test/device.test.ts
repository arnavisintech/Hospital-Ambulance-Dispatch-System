import { beforeEach, describe, expect, it } from 'vitest';
import { guestDeviceId } from '../lib/device';

describe('guestDeviceId', () => {
  beforeEach(() => localStorage.clear());
  it('is a long random id, stable on this device, so a retried guest SOS reuses the same account', () => {
    const a = guestDeviceId();
    expect(a).toMatch(/^[A-Za-z0-9-]{32,64}$/);
    expect(guestDeviceId()).toBe(a);
    localStorage.clear();
    expect(guestDeviceId()).not.toBe(a);
  });
});
