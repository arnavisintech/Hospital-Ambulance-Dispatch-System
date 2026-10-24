import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from '../lib/sw';

const fakeNav = (register: (url: string) => Promise<unknown>) =>
  ({ serviceWorker: { register } }) as unknown as Pick<Navigator, 'serviceWorker'>;

describe('registerServiceWorker', () => {
  it('does nothing outside production builds', async () => {
    const register = vi.fn(async () => ({}));
    expect(await registerServiceWorker(fakeNav(register), { PROD: false })).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });

  it('does nothing when service workers are unsupported', async () => {
    expect(await registerServiceWorker({} as Pick<Navigator, 'serviceWorker'>, { PROD: true })).toBe(false);
  });

  it('registers /sw.js in production', async () => {
    const urls: string[] = [];
    const ok = await registerServiceWorker(fakeNav(async (u) => { urls.push(u); return {}; }), { PROD: true });
    expect(ok).toBe(true);
    expect(urls).toEqual(['/sw.js']);
  });

  it('resolves false instead of throwing when registration fails', async () => {
    const nav = fakeNav(() => Promise.reject(new Error('blocked')));
    await expect(registerServiceWorker(nav, { PROD: true })).resolves.toBe(false);
  });
});

describe('sw.js', () => {
  const src = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');

  it('never caches API or tile responses', () => {
    expect(src).toMatch(/\/api\//);            // the bypass rule exists ...
    expect(src).toMatch(/\/tiles\//);
    expect(src).not.toMatch(/cache\.put\([^)]*\/api\//);
  });

  it('falls back to the cached app shell for navigations', () => {
    expect(src).toMatch(/mode === 'navigate'/);
    expect(src).toMatch(/\/index\.html/);
  });
});

describe('manifest', () => {
  const m = JSON.parse(readFileSync(resolve(__dirname, '../../public/manifest.webmanifest'), 'utf8')) as Record<string, unknown>;
  it('is installable and opens on the SOS screen', () => {
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/sos');
    expect(Array.isArray(m.icons) && (m.icons as unknown[]).length).toBeTruthy();
  });
});
