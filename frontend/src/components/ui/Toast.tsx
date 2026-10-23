import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastOptions {
  kind?: ToastKind;
  /** Optional bold first line; the message becomes the description. */
  title?: string;
  /** ms; default 4000 (errors 6000). 0 = sticky until dismissed. */
  duration?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions { id: number; text: string; kind: ToastKind }

export interface ToastApi {
  /** Back-compatible signature: toast(text, kind?) or toast(text, options). Returns the toast id. */
  toast: (text: string, kindOrOpts?: ToastKind | ToastOptions) => number;
  success: (text: string, opts?: Omit<ToastOptions, 'kind'>) => number;
  info: (text: string, opts?: Omit<ToastOptions, 'kind'>) => number;
  warning: (text: string, opts?: Omit<ToastOptions, 'kind'>) => number;
  /** Accepts an Error / ApiError / string. */
  error: (e: unknown, opts?: Omit<ToastOptions, 'kind'>) => number;
  dismiss: (id: number) => void;
}

const noop = () => 0;
const Ctx = createContext<ToastApi>({ toast: noop, success: noop, info: noop, warning: noop, error: noop, dismiss: () => {} });

/** `const { toast, success, error } = useToast();` */
export const useToast = () => useContext(Ctx);

const META: Record<ToastKind, { icon: LucideIcon; cls: string }> = {
  info: { icon: Info, cls: 'text-info' },
  success: { icon: CheckCircle2, cls: 'text-success' },
  warning: { icon: AlertTriangle, cls: 'text-warning' },
  error: { icon: XCircle, cls: 'text-brand-500' },
};

const MAX = 4;

/** Toast host. Mount once near the root (main.tsx). Polite live region, auto-dismiss, max 4 visible. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((x) => x.filter((t) => t.id !== id)), []);

  const toast = useCallback((text: string, kindOrOpts?: ToastKind | ToastOptions) => {
    const opts: ToastOptions = typeof kindOrOpts === 'string' ? { kind: kindOrOpts } : kindOrOpts ?? {};
    const id = ++seq.current;
    setItems((x) => [...x.slice(-(MAX - 1)), { ...opts, id, text, kind: opts.kind ?? 'info' }]);
    return id;
  }, []);

  const api = useMemo<ToastApi>(() => ({
    toast,
    dismiss,
    success: (t, o) => toast(t, { ...o, kind: 'success' }),
    info: (t, o) => toast(t, { ...o, kind: 'info' }),
    warning: (t, o) => toast(t, { ...o, kind: 'warning' }),
    error: (e, o) => toast(e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong', { ...o, kind: 'error' }),
  }), [toast, dismiss]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {typeof document !== 'undefined' && createPortal(<ToastViewport items={items} dismiss={dismiss} />, document.body)}
    </Ctx.Provider>
  );
}

function ToastViewport({ items, dismiss }: { items: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-toast flex flex-col items-center gap-2 px-4 pt-safe"
      style={{ paddingTop: 'calc(var(--safe-top) + 12px)' }}
      role="region"
      aria-label="Notifications"
    >
      <div className="sr-only" aria-live="polite" aria-atomic="false">
        {items.map((t) => <p key={t.id}>{t.title ? `${t.title}. ` : ''}{t.text}</p>)}
      </div>
      <AnimatePresence initial={false}>
        {items.map((t) => <ToastCard key={t.id} item={t} onDismiss={() => dismiss(t.id)} />)}
      </AnimatePresence>
    </div>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const reduce = useReducedMotion();
  const [paused, setPaused] = useState(false);
  const duration = item.duration ?? (item.kind === 'error' ? 6000 : 4000);
  const dismissRef = useRef(onDismiss);
  useEffect(() => { dismissRef.current = onDismiss; });
  useEffect(() => {
    if (!duration || paused) return;
    const t = setTimeout(() => dismissRef.current(), duration);
    return () => clearTimeout(t);
  }, [duration, paused]);
  const { icon: Icon, cls } = META[item.kind];
  return (
    <motion.div
      layout={!reduce}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -16, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] } }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10, scale: 0.98, transition: { duration: 0.14 } }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      className="pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg border border-line/80 bg-surface px-4 py-3 shadow-raised"
    >
      <Icon size={20} className={cn('mt-0.5 shrink-0', cls)} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        {item.title && <p className="font-semibold text-ink-900">{item.title}</p>}
        <p className={item.title ? 'text-ink-500' : 'font-medium text-ink-900'}>{item.text}</p>
      </div>
      {item.action && (
        <button
          type="button"
          onClick={() => { item.action?.onClick(); onDismiss(); }}
          className="shrink-0 rounded-sm px-1 text-sm font-bold text-brand-600 hover:underline"
        >
          {item.action.label}
        </button>
      )}
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification" className="-mr-1 shrink-0 rounded-full p-1 text-ink-400 hover:bg-canvas hover:text-ink-700">
        <X size={16} aria-hidden />
      </button>
    </motion.div>
  );
}
