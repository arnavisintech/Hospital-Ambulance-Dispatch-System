import { newUuid } from './queue';

const KEY = 'hads_guest_device';
const WINDOW_MS = 10 * 60 * 1000;   // the server honours the same id for 10 minutes (retries of one guest SOS)

/** Retry key for the no-account SOS: retries within 10 minutes reuse the same guest account. It is not a lasting
 *  credential: it expires, and is cleared on sign-out, so the next person on a shared phone starts fresh. */
export function guestDeviceId(): string {
  try {
    const raw = localStorage.getItem(KEY);
    const known = raw ? (JSON.parse(raw) as { id?: string; at?: number }) : null;
    if (known?.id && /^[A-Za-z0-9-]{32,64}$/.test(known.id) && typeof known.at === 'number' && Date.now() - known.at < WINDOW_MS) {
      return known.id;
    }
    const id = newUuid();
    localStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() }));
    return id;
  } catch {
    return newUuid();   // storage blocked or corrupt: still works, just without retry reuse
  }
}

export function clearGuestDevice(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}
