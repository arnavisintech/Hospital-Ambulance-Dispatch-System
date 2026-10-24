import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getToken, post } from '../lib/api';
import { backoffMs } from '../lib/queue';
import type { WsMessage } from '../lib/types';

/** `ticket` is a single-use, 30 s ticket from POST /auth/ws-ticket (the JWT never goes in a URL). */
export function buildWsUrl(topics: string[], ticket: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ ticket, topics: topics.join(',') });
  return `${proto}//${loc.host}/api/ws?${qs.toString()}`;
}

/**
 * Subscribe to server push topics. Auto-reconnects with exponential backoff.
 * `topics` is compared by value so callers may pass a fresh array every render.
 */
export function useSocket(topics: string[], onMessage: (m: WsMessage) => void, enabled = true): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  useLayoutEffect(() => { handler.current = onMessage; });
  const key = topics.join(',');

  useEffect(() => {
    if (!enabled || !key) return;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;

    const connect = async () => {
      if (!getToken() || closed) return;
      try {
        const { ticket } = await post<{ ticket: string }>('/auth/ws-ticket');
        if (closed) return;
        ws = new WebSocket(buildWsUrl(key.split(','), ticket));
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => { attempt = 0; setConnected(true); };
      ws.onmessage = (ev) => {
        try { handler.current(JSON.parse(ev.data as string) as WsMessage); } catch { /* ignore malformed frame */ }
      };
      ws.onclose = () => { setConnected(false); if (!closed) schedule(); };
      ws.onerror = () => { ws?.close(); };
    };
    const schedule = () => {
      timer = setTimeout(() => void connect(), backoffMs(attempt++, 1000, 15000));
    };

    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) { ws.onclose = null; ws.close(); }
      setConnected(false);
    };
  }, [key, enabled]);

  return { connected: connected && enabled && !!key };
}
