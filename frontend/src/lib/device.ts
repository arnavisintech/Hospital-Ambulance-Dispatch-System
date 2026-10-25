import { newUuid } from './queue';

const KEY = 'hads_guest_device';

/** Random id kept on this device for the no-account SOS: a retried guest sign-in returns the same account. */
export function guestDeviceId(): string {
  try {
    const known = localStorage.getItem(KEY);
    if (known && /^[A-Za-z0-9-]{32,64}$/.test(known)) return known;
    const id = newUuid();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return newUuid();   // storage blocked: still works, just without retry reuse
  }
}
