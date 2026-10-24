import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { KeyRound, LogOut } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { useConnection } from '../../context/ConnectionContext';
import { cn } from '../../lib/cn';
import { ChangePasswordModal } from '../ChangePasswordModal';
import { Avatar } from '../ui/Avatar';
import { Menu, type MenuItem } from '../ui/Menu';
import { APP_MENU, ROLE_LABEL } from './nav';

/** HADS logo: brand tile with a white cross + wordmark. */
export function BrandMark({ to = '/', compact, className }: { to?: string; compact?: boolean; className?: string }) {
  return (
    <Link to={to} className={cn('inline-flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500', className)} aria-label="HADS home">
      <LogoTile />
      {!compact && <span className="text-lg font-extrabold tracking-tight text-ink-900">HADS</span>}
    </Link>
  );
}

export function LogoTile({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="9" fill="rgb(var(--brand-500))" />
      <path d="M13.5 8h5v5.5H24v5h-5.5V24h-5v-5.5H8v-5h5.5z" fill="rgb(var(--surface))" />
    </svg>
  );
}

export type ConnState = 'live' | 'reconnecting' | 'offline' | 'idle';

export function useConnectionState(): ConnState {
  const { socket, online } = useConnection();
  if (!online) return 'offline';
  if (socket === true) return 'live';
  if (socket === false) return 'reconnecting';
  return 'idle';
}

const CONN = {
  live: { label: 'Live', dot: 'bg-success', text: 'text-success-fg', bg: 'bg-success-bg' },
  reconnecting: { label: 'Reconnecting', dot: 'bg-warning', text: 'text-warning-fg', bg: 'bg-warning-bg' },
  offline: { label: 'Offline', dot: 'bg-brand-500', text: 'text-brand-600', bg: 'bg-brand-50' },
  idle: { label: 'Not live', dot: 'bg-ink-400', text: 'text-ink-500', bg: 'bg-canvas' },
};

/** Global live-connection pill (reads ConnectionContext; pages report socket state via useReportConnection). */
export function ConnectionIndicator({ compact, className }: { compact?: boolean; className?: string }) {
  const s = useConnectionState();
  // Pages without a live socket (dashboards, settings) report nothing; a grey "Not live" pill reads as an error there.
  if (s === 'idle') return null;
  const c = CONN[s];
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label={`Connection: ${c.label}`}
      className={cn('inline-flex h-8 items-center gap-2 rounded-full px-3 text-xs font-semibold', c.bg, c.text, compact && 'px-2', className)}
    >
      <span className="relative flex h-2 w-2" aria-hidden>
        {s === 'live' && <span className={cn('absolute inset-0 animate-ping rounded-full opacity-60', c.dot)} />}
        <span className={cn('relative h-2 w-2 rounded-full', c.dot)} />
      </span>
      <span className={cn(compact && 'sr-only')}>{c.label}</span>
    </span>
  );
}

/** Avatar button + dropdown: name/role header, role links, sign out. */
export function UserMenu({ size = 'sm' }: { size?: 'sm' | 'md' }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [pwOpen, setPwOpen] = useState(false);
  if (!user) return null;
  const links = APP_MENU[user.role] ?? [];
  const items: MenuItem[] = [
    ...links.map((l) => ({ label: l.label, icon: l.icon, onSelect: () => nav(l.to) })),
    { label: 'Change password', icon: KeyRound, onSelect: () => setPwOpen(true) },
    { label: 'Sign out', icon: LogOut, danger: true, onSelect: () => { logout(); nav('/login'); } },
  ];
  return (
    <>
    <Menu
      header={
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-ink-900">{user.name}</p>
          <p className="truncate text-xs text-ink-500">{ROLE_LABEL[user.role]}{user.email ? ` · ${user.email}` : ''}</p>
        </div>
      }
      items={items}
      trigger={(p) => (
        <button
          type="button"
          {...p}
          aria-label={`Account menu for ${user.name}`}
          className="press rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
        >
          <Avatar name={user.name} size={size} />
        </button>
      )}
    />
    <ChangePasswordModal open={pwOpen} onClose={() => setPwOpen(false)} />
    </>
  );
}
