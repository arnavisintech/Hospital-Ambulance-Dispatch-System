import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NotificationBell } from '../NotificationBell';
import { Outlet, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { cn } from '../../lib/cn';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { IconButton } from '../ui/IconButton';
import { Sheet } from '../ui/Sheet';
import { MapInsetsContext } from '../map/MapCanvas';
import { QueueBanner } from '../QueueBanner';
import { BrandMark, UserMenu } from './Chrome';

export interface MobileAppLayoutProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Back affordance: true = history back (falls back to '/'), a path, or a handler. Omit to show the logo. */
  back?: boolean | string | (() => void);
  /** Extra right-side app-bar actions (IconButtons). */
  actions?: ReactNode;
  /** Show the avatar menu (default true when signed in). */
  showUserMenu?: boolean;
  /**
   * Map-first screen (tracking, SOS location, crew navigation). Phones: the map fills the screen, the app bar floats
   * over it and `children` render in a draggable bottom Sheet. >= 1024px: map left, 420px panel right.
   */
  map?: ReactNode;
  /** Bottom sheet config for map screens (phones). */
  sheet?: { snapPoints?: number[]; initialSnap?: number; header?: ReactNode; title?: ReactNode; ariaLabel?: string };
  /** Sticky bottom CTA bar (safe-area padded). On map screens it is the sheet/panel footer. */
  bottomBar?: ReactNode;
  /** Content width for non-map screens. Default 'md' (448px). */
  width?: 'md' | 'lg' | '2xl';
  /** Content (or <Outlet/> when used as a route element). */
  children?: ReactNode;
  className?: string;
}

const WIDTH = { md: 'max-w-md', lg: 'max-w-lg', '2xl': 'max-w-2xl' };

function useViewportH() {
  const [h, setH] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return h;
}

/** Layout for requester / crew (and hospital on phones). See COMPONENTS.md → Layouts. */
export function MobileAppLayout({
  title, subtitle, back, actions, showUserMenu = true, map, sheet, bottomBar, width = 'md', children, className,
}: MobileAppLayoutProps) {
  const isDesktop = useIsDesktop();
  const { user } = useAuth();
  const navigate = useNavigate();
  const vh = useViewportH();
  const content = children ?? <Outlet />;

  const onBack = back === undefined || back === false ? undefined
    : typeof back === 'function' ? back
    : typeof back === 'string' ? () => navigate(back)
    : () => (window.history.length > 1 ? navigate(-1) : navigate('/'));

  const snapPoints = sheet?.snapPoints ?? [0.42, 0.88];
  const peek = Math.round(Math.min(...snapPoints) * vh);
  const insets = useMemo(() => (isDesktop ? {} : { top: 64, bottom: peek }), [isDesktop, peek]);

  const backBtn = onBack && <IconButton label="Back" icon={ArrowLeft} onClick={onBack} variant={map && !isDesktop ? 'floating' : 'ghost'} className={map && !isDesktop ? '' : '-ml-2'} />;
  const userMenu = showUserMenu && user ? <span className="flex items-center gap-1"><NotificationBell /><UserMenu /></span> : null;
  const queue = user?.role === 'requester' ? <QueueBanner /> : null;

  /* -------------------------------------------- map screens */
  if (map) {
    if (isDesktop) {
      return (
        <div className={cn('flex h-dvh flex-col bg-canvas', className)}>
          <AppBar title={title} subtitle={subtitle} back={backBtn} actions={actions} userMenu={userMenu} />
          {queue}
          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1">
              <MapInsetsContext.Provider value={insets}>{map}</MapInsetsContext.Provider>
            </div>
            <aside className="flex w-panel shrink-0 flex-col border-l border-line bg-surface" aria-label={typeof title === 'string' ? title : 'Details'}>
              {sheet?.header && <div className="border-b border-line px-5 py-4">{sheet.header}</div>}
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 scrollbar-thin">{content}</div>
              {bottomBar && <div className="border-t border-line px-5 py-4">{bottomBar}</div>}
            </aside>
          </div>
        </div>
      );
    }
    return (
      <div className={cn('relative h-dvh overflow-hidden bg-canvas', className)}>
        <div className="absolute inset-0">
          <MapInsetsContext.Provider value={insets}>{map}</MapInsetsContext.Provider>
        </div>
        {/* floating top bar over the map */}
        <div className="pointer-events-none absolute inset-x-0 top-0 z-sticky flex items-start gap-2 px-3 pt-safe" style={{ paddingTop: 'calc(var(--safe-top) + 10px)' }}>
          <div className="pointer-events-auto">{backBtn ?? <span className="flex h-11 items-center rounded-full bg-surface px-3 shadow-raised"><BrandMark compact /></span>}</div>
          {title && (
            <div className="pointer-events-auto min-w-0 flex-1 truncate rounded-full bg-surface/95 px-4 py-2.5 text-center text-sm font-bold text-ink-900 shadow-raised backdrop-blur">
              {title}
            </div>
          )}
          {!title && <div className="flex-1" />}
          <div className="pointer-events-auto flex items-center gap-2">
            {actions}
            {userMenu && <span className="flex rounded-full bg-surface p-1 shadow-raised">{userMenu}</span>}
          </div>
        </div>
        {queue && <div className="absolute inset-x-3 top-[calc(var(--safe-top)+64px)] z-sticky">{queue}</div>}
        <Sheet
          snapPoints={snapPoints}
          initialSnap={sheet?.initialSnap ?? 0}
          title={sheet?.title}
          header={sheet?.header}
          footer={bottomBar}
          ariaLabel={sheet?.ariaLabel ?? (typeof title === 'string' ? title : 'Details')}
        >
          {content}
        </Sheet>
      </div>
    );
  }

  /* -------------------------------------------- regular screens */
  return (
    <div className={cn('flex min-h-dvh flex-col bg-canvas', className)}>
      <AppBar title={title} subtitle={subtitle} back={backBtn} actions={actions} userMenu={userMenu} />
      {queue}
      <main id="main" className={cn('mx-auto w-full flex-1 px-4 py-5 sm:py-8', WIDTH[width], bottomBar && 'pb-28')}>
        {content}
      </main>
      {bottomBar && (
        <div className="fixed inset-x-0 bottom-0 z-sticky border-t border-line bg-surface/95 backdrop-blur pb-safe-3">
          <div className={cn('mx-auto w-full px-4 pt-3', WIDTH[width])}>{bottomBar}</div>
        </div>
      )}
    </div>
  );
}

function AppBar({ title, subtitle, back, actions, userMenu }: { title?: ReactNode; subtitle?: ReactNode; back?: ReactNode; actions?: ReactNode; userMenu?: ReactNode }) {
  return (
    <header className="sticky top-0 z-sticky border-b border-line/80 bg-surface/95 pt-safe backdrop-blur">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-toast focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-raised">Skip to content</a>
      <div className="mx-auto flex h-[var(--appbar-h)] w-full max-w-screen-2xl items-center gap-2 px-4">
        {back ?? <BrandMark compact={!!title} />}
        {title && (
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-bold leading-tight text-ink-900 sm:text-lg">{title}</h1>
            {subtitle && <p className="truncate text-xs text-ink-500">{subtitle}</p>}
          </div>
        )}
        {!title && <div className="flex-1" />}
        <div className="flex items-center gap-1.5">
          {actions}
          {userMenu}
        </div>
      </div>
    </header>
  );
}
