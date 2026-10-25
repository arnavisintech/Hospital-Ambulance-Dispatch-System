const TOKEN_KEY = 'hads_token';

export const API_BASE = '/api';

export class ApiError extends Error {
  status: number;
  /** Structured `detail` from the server when it is not a plain message (e.g. {errors: [...]} on an import). */
  detail?: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
    this.detail = detail;
  }
}

export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null): void {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable */ }
}

let unauthorizedHandler: (() => void) | null = null;
export function onUnauthorized(fn: (() => void) | null): void { unauthorizedHandler = fn; }

function extractDetail(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) {
      return d.map((e) => (e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : String(e))).join('; ');
    }
  }
  return fallback;
}

export interface ReqOpts {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  auth?: boolean;
  signal?: AbortSignal;
  /** Multipart body (file upload); sent as-is, the browser sets the boundary header. */
  formData?: FormData;
}

export function buildUrl(path: string, query?: ReqOpts['query']): string {
  let url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  if (query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    const qs = sp.toString();
    if (qs) url += `?${qs}`;
  }
  return url;
}

export async function api<T = unknown>(path: string, opts: ReqOpts = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getToken();
  if (token && opts.auth !== false) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined && !opts.formData) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(buildUrl(path, opts.query), {
      method: opts.method ?? (opts.body !== undefined || opts.formData ? 'POST' : 'GET'),
      headers,
      body: opts.formData ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, 'Network error - check your connection');
  }

  if (res.status === 204) return undefined as T;
  const data = await readBody(res);
  if (!res.ok) throw failure(res, data, opts);
  return data as T;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function failure(res: Response, data: unknown, opts: ReqOpts): ApiError {
  // A 401 on login itself (auth:false) is just bad credentials, not an expired session.
  if (res.status === 401 && opts.auth !== false) {
    setToken(null);
    unauthorizedHandler?.();
  }
  const detail = data && typeof data === 'object' ? (data as { detail?: unknown }).detail : undefined;
  return new ApiError(res.status, extractDetail(data, res.statusText || `HTTP ${res.status}`), detail);
}

/** Authenticated GET of a file (CSV export etc.); the name comes from Content-Disposition when the server sends one. */
export async function fetchFile(path: string, query: ReqOpts['query'] | undefined, fallbackName: string): Promise<{ blob: Blob; filename: string }> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), { method: 'GET', headers });
  } catch {
    throw new ApiError(0, 'Network error - check your connection');
  }
  if (!res.ok) throw failure(res, await readBody(res), {});
  const m = /filename="?([^";]+)"?/i.exec(res.headers.get('Content-Disposition') ?? '');
  return { blob: await res.blob(), filename: m?.[1] ?? fallbackName };
}

/** Save a blob through a temporary link. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);   // some Safari/Firefox versions start the download late
}

export const get = <T>(path: string, query?: ReqOpts['query']) => api<T>(path, { query });
export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const put = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'PUT', body });
export const patch = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'PATCH', body });

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}
