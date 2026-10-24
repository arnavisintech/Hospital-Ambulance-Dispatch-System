import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildUrl, fetchFile, getToken, onUnauthorized, setToken } from '../lib/api';
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

describe('multipart uploads and error detail', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  it('sends FormData as-is without a JSON content type', async () => {
    const f = mockFetch(200, { ok: 1 });
    vi.stubGlobal('fetch', f);
    const fd = new FormData();
    fd.append('file', new Blob(['a,b']), 'x.csv');
    await api('/admin/demographics/import', { method: 'POST', formData: fd });
    const [, init] = f.mock.calls[0];
    expect(init.body).toBe(fd);
    expect(init.headers['Content-Type']).toBeUndefined();
  });
  it('keeps structured error detail on ApiError', async () => {
    vi.stubGlobal('fetch', mockFetch(422, { detail: { errors: ['row 2: bad'] } }));
    const err = (await api('/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.detail).toEqual({ errors: ['row 2: bad'] });
  });

  it('fetchFile sends the bearer token and returns the blob with the server filename', async () => {
    setToken('abc');
    const blob = new Blob(['a,b\n']);
    const f = vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="hads-audit-20261024.csv"' }),
      blob: async () => blob,
    });
    vi.stubGlobal('fetch', f);
    const out = await fetchFile('/audit/export.csv', { action: 'x', entity: '' }, 'audit.csv');
    expect(f.mock.calls[0][0]).toBe('/api/audit/export.csv?action=x');
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer abc');
    expect(out.filename).toBe('hads-audit-20261024.csv');
    expect(out.blob).toBe(blob);
  });

  it('fetchFile falls back to the given name and raises the server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', headers: new Headers(), blob: async () => new Blob([]) }));
    expect((await fetchFile('/x', undefined, 'report.csv')).filename).toBe('report.csv');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 403, statusText: 'Forbidden', headers: new Headers(),
      text: async () => JSON.stringify({ detail: 'Role not permitted' }) }));
    const err = (await fetchFile('/x', undefined, 'r.csv').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
    expect(err.message).toBe('Role not permitted');
  });
});
