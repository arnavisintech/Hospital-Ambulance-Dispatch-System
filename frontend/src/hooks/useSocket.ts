import { useEffect, useRef, useState } from 'react';
import { getToken } from '../lib/api';
import { backoffMs } from '../lib/queue';
import type { WsMessage } from '../lib/types';

export function buildWsUrl(topics: string[], token: string, loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams({ token, topics: topics.join(',') });
  return `${proto}//${loc.host}/api/ws?${qs.toString()}`;
}

/**
 * Subscribe to server push topics. Auto-reconnects with exponential backoff.
 * `topics` is compared by value so callers may pass a fresh array every render.
 */
export function useSocket(topics: string[], onMessage: (m: WsMessage) => void, enabled = true): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onMessage);
  handler.current = onMessage;
  const key = topics.join(',');

  useEffect(() => {
    if (!enabled || !key) { setConnected(false); return; }
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let closed = false;

    const connect = () => {
      const token = getToken();
      if (!token || closed) return;
      try {
        ws = new WebSocket(buildWsUrl(key.split(','), token));
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
      timer = setTimeout(connect, backoffMs(attempt++, 1000, 15000));
    };

    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      if (ws) { ws.onclose = null; ws.close(); }
      setConnected(false);
    };
  }, [key, enabled]);

  return { connected };
}
