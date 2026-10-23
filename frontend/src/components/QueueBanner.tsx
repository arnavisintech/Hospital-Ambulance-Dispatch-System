import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { WifiOff } from 'lucide-react';
import { post } from '../lib/api';
import { useToast } from '../context/ToastContext';
import { backoffMs, flushQueue, loadQueue } from '../lib/queue';
import type { RequestOut } from '../lib/types';

export const QUEUE_EVENT = 'hads-queue-changed';
export const notifyQueueChanged = () => window.dispatchEvent(new Event(QUEUE_EVENT));

/** Shows queued (offline) SOS requests and retries them automatically (UC-1 E1). */
export function QueueBanner() {
  const [count, setCount] = useState(() => loadQueue().length);
  const [retrying, setRetrying] = useState(false);
  const attempt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const nav = useNavigate();
  const { toast } = useToast();
  const busy = useRef(false);

  const flush = useCallback(async () => {
    if (busy.current || loadQueue().length === 0) { setCount(loadQueue().length); return; }
    busy.current = true;
    setRetrying(true);
    try {
      const res = await flushQueue((b) => post<RequestOut>('/requests', b));
      setCount(res.remaining);
      if (res.sent.length) {
        attempt.current = 0;
        toast('Queued SOS delivered - dispatching now', 'success');
        nav(`/track/${res.sent[res.sent.length - 1].id}`);
      }
      if (res.dropped.length) toast('A queued request was rejected by the server and discarded', 'error');
      if (res.remaining > 0) {
        timer.current = setTimeout(() => void flush(), backoffMs(attempt.current++, 2000, 30000));
      }
    } finally {
      busy.current = false;
      setRetrying(false);
    }
  }, [nav, toast]);

  useEffect(() => {
    const onChange = () => {
      setCount(loadQueue().length);
      if (timer.current) clearTimeout(timer.current);
      attempt.current = 0;
      timer.current = setTimeout(() => void flush(), 1500);
    };
    const onOnline = () => void flush();
    window.addEventListener(QUEUE_EVENT, onChange);
    window.addEventListener('online', onOnline);
    void flush();
    return () => {
      window.removeEventListener(QUEUE_EVENT, onChange);
      window.removeEventListener('online', onOnline);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flush]);

  if (count === 0) return null;
  return (
    <div className="flex items-center gap-3 border-b border-warning/30 bg-warning-bg px-4 py-2.5 text-sm text-warning-fg" role="status" aria-live="assertive">
      <WifiOff size={18} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 font-medium">
        {count} SOS request{count > 1 ? 's' : ''} waiting to send. {retrying ? 'Retrying now…' : "We'll retry automatically — you can also call 108."}
      </span>
      <button className="shrink-0 font-bold underline-offset-2 hover:underline" onClick={() => void flush()}>Retry</button>
    </div>
  );
}
