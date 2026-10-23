import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildUrl, getToken, onUnauthorized, setToken } from '../lib/api';
import { buildWsUrl } from '../hooks/useSocket';

const mockFetch = (status: number, body?: unknown) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });

describe('api client', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); onUnauthorized(null); });

  it('builds urls with query, skipping empty values', () => {
    expect(buildUrl('/audit', { action: 'x', entity: '', limit: 5 })).toBe('/api/audit?action=x&limit=5');
  });

  it('sends bearer token and JSON body', async () => {
    setToken('abc');
    const f = mockFetch(200, { ok: 1 });
    vi.stubGlobal('fetch', f);
    await api('/crew/duty', { method: 'POST', body: { on_duty: true } });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('/api/crew/duty');
    expect(init.headers.Authorization).toBe('Bearer abc');
    expect(init.body).toBe('{"on_duty":true}');
  });

  it('returns undefined on 204', async () => {
    vi.stubGlobal('fetch', mockFetch(204));
    await expect(api('/crew/location', { method: 'POST', body: {} })).resolves.toBeUndefined();
  });

  it('auto-logs out on 401 (clears token, fires handler)', async () => {
    setToken('stale');
    const handler = vi.fn();
    onUnauthorized(handler);
    vi.stubGlobal('fetch', mockFetch(401, { detail: 'Token expired' }));
    await expect(api('/auth/me')).rejects.toMatchObject({ status: 401, message: 'Token expired' });
    expect(getToken()).toBeNull();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('does not treat a failed login as session expiry', async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    vi.stubGlobal('fetch', mockFetch(401, { detail: 'Bad credentials' }));
    await expect(api('/auth/login', { method: 'POST', body: {}, auth: false })).rejects.toBeInstanceOf(ApiError);
    expect(handler).not.toHaveBeenCalled();
  });

  it('maps network failures to status 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    await expect(api('/x')).rejects.toMatchObject({ status: 0 });
  });

  it('formats FastAPI validation errors', async () => {
    vi.stubGlobal('fetch', mockFetch(422, { detail: [{ msg: 'field required' }, { msg: 'bad lat' }] }));
    await expect(api('/x')).rejects.toMatchObject({ message: 'field required; bad lat' });
  });
});

describe('websocket url', () => {
  it('uses ws/wss and comma separated topics', () => {
    const u = buildWsUrl(['request:12', 'controller'], 'tkt', { protocol: 'https:', host: 'h.example' });
    expect(u).toBe('wss://h.example/api/ws?ticket=tkt&topics=request%3A12%2Ccontroller');
  });
});
