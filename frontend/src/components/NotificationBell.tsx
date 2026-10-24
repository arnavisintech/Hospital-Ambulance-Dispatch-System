import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../hooks/useNotifications';
import { cn } from '../lib/cn';
import { fmtRelative } from '../lib/format';
import { notificationLink } from '../lib/notifications';
import { Button } from './ui/Button';
import { Drawer } from './ui/Drawer';
import { EmptyState } from './ui/EmptyState';

/** Bell with unread badge; opens the inbox drawer. */
export function NotificationBell() {
  const { user } = useAuth();
  const { items, unread, markRead, markAll } = useNotifications();
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  if (!user) return null;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        className="press relative flex h-10 w-10 items-center justify-center rounded-full text-ink-700 hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500">
        <Bell size={20} aria-hidden />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-500 px-1 text-3xs font-bold text-white tabular-nums" aria-hidden>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      <Drawer open={open} onClose={() => setOpen(false)} title="Notifications" side="right"
        footer={unread > 0 ? <Button variant="secondary" icon={CheckCheck} fullWidth onClick={() => void markAll()}>Mark all as read</Button> : undefined}>
        {items.length === 0 ? (
          <EmptyState compact icon={Bell} title="No notifications yet" description="Dispatch, hospital and trip updates appear here." />
        ) : (
          <ul className="divide-y divide-line/70">
            {items.map((n) => {
              const to = notificationLink(n, user.role);
              return (
                <li key={n.id}>
                  <button type="button"
                    onClick={() => { void markRead(n.id); if (to) { setOpen(false); nav(to); } }}
                    className={cn('flex w-full items-start gap-3 px-1 py-3 text-left hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                      !n.read_at && 'font-semibold')}>
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.read_at ? 'bg-transparent' : 'bg-brand-500')} aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink-900">{n.title}</span>
                      {n.body && <span className="block text-xs font-normal text-ink-500">{n.body}</span>}
                      <span className="block text-xs font-normal text-ink-400">{n.created_at ? fmtRelative(n.created_at) : ''}</span>
                    </span>
                    {!n.read_at && <span className="sr-only">(unread)</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Drawer>
    </>
  );
}
