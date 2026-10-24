import { createContext, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';
import { NotificationBell } from '../NotificationBell';
import { NavLink, Outlet, matchPath, useLocation } from 'react-router-dom';
import { Menu as MenuIcon, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { cn } from '../../lib/cn';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { Drawer } from '../ui/Drawer';
import { IconButton } from '../ui/IconButton';
import { LoadingBlock } from '../ui/Spinner';
import { BrandMark, ConnectionIndicator, LogoTile, UserMenu } from './Chrome';
import { CONSOLE_NAV, ROLE_LABEL, type NavItem } from './nav';

interface PageChrome { title?: string; fullBleed?: boolean }
const PageCtx = createContext<(c: PageChrome) => void>(() => {});

/**
 * Console pages call this to set the top-bar title and opt into a full-bleed (edge-to-edge, no padding)
 * content area, e.g. the live map board: `useConsolePage({ title: 'Live board', fullBleed: true })`.
 */
export function useConsolePage({ title, fullBleed }: PageChrome): void {
  const set = useContext(PageCtx);
  useEffect(() => {
    set({ title, fullBleed });
    return () => set({});
  }, [title, fullBleed, set]);
}

const KEY = 'hads.sidebar.collapsed';
const readCollapsed = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

/** Layout for controller / admin / authority / hospital staff. Route element with <Outlet/>. */
export function ConsoleLayout({ children }: { children?: ReactNode }) {
  const { user } = useAuth();
  const isDesktop = useIsDesktop();
  const loc = useLocation();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawer, setDrawer] = useState(false);
  const [chrome, setChrome] = useState<PageChrome>({});
  const items = (user && CONSOLE_NAV[user.role]) || [];

  const toggle = () => setCollapsed((c) => { try { localStorage.setItem(KEY, c ? '0' : '1'); } catch { /* ignore */ } return !c; });
  // Close the mobile drawer on navigation.
  const [lastPath, setLastPath] = useState(loc.pathname);
  if (lastPath !== loc.pathname) { setLastPath(loc.pathname); if (drawer) setDrawer(false); }

  const active = items.find((i) => matchPath({ path: i.to, end: i.end ?? true }, loc.pathname));
  const title = chrome.title ?? active?.label ?? '';

  return (
    <PageCtx.Provider value={setChrome}>
      <div className="flex h-dvh bg-canvas">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-toast focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:shadow-raised">Skip to content</a>
        {isDesktop && (
          <aside
            className={cn('flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-standard ease-out', collapsed ? 'w-[76px]' : 'w-64')}
            aria-label="Sidebar"
          >
            <div className={cn('flex h-16 items-center border-b border-line/70', collapsed ? 'justify-center' : 'px-5')}>
              {collapsed ? <LogoTile /> : <BrandMark />}
            </div>
            <SideNav items={items} collapsed={collapsed} />
            <div className={cn('border-t border-line/70 p-3', collapsed && 'flex justify-center')}>
              <button
                type="button"
                onClick={toggle}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                className={cn('press flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium text-ink-500 hover:bg-canvas hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500', !collapsed && 'w-full')}
              >
                {collapsed ? <PanelLeftOpen size={20} aria-hidden /> : <><PanelLeftClose size={20} aria-hidden /> Collapse</>}
              </button>
            </div>
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="z-sticky flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface px-4 pt-safe lg:px-6">
            {!isDesktop && (
              <>
                <IconButton label="Open navigation" icon={MenuIcon} onClick={() => setDrawer(true)} className="-ml-2" />
                <LogoTile size={28} />
              </>
            )}
            <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-ink-900">{title}</h1>
            <ConnectionIndicator compact={!isDesktop} />
            <NotificationBell />
            <UserMenu />
          </header>
          <main id="main" className={cn('min-h-0 flex-1', chrome.fullBleed ? 'relative overflow-hidden' : 'overflow-y-auto scrollbar-thin')}>
            <Suspense fallback={<LoadingBlock full label="Loading" />}>
              {chrome.fullBleed ? (children ?? <Outlet />) : (
                <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 lg:px-8 lg:py-8">{children ?? <Outlet />}</div>
              )}
            </Suspense>
          </main>
        </div>

        {!isDesktop && (
          <Drawer open={drawer} onClose={() => setDrawer(false)} side="left" hideHeader ariaLabel="Navigation">
            <div className="flex h-16 items-center justify-between border-b border-line/70 px-5">
              <BrandMark />
              {user && <span className="text-xs font-semibold text-ink-500">{ROLE_LABEL[user.role]}</span>}
            </div>
            <SideNav items={items} collapsed={false} />
          </Drawer>
        )}
      </div>
    </PageCtx.Provider>
  );
}

function SideNav({ items, collapsed }: { items: NavItem[]; collapsed: boolean }) {
  return (
    <nav className="flex-1 overflow-y-auto p-3 scrollbar-thin" aria-label="Main">
      <ul className="flex flex-col gap-1">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <li key={it.to + it.label}>
              <NavLink
                to={it.to}
                end={it.end ?? true}
                title={collapsed ? it.label : undefined}
                className={({ isActive }) => cn(
                  'press group relative flex h-11 items-center gap-3 rounded-md text-sm font-semibold transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                  collapsed ? 'justify-center px-0' : 'px-3',
                  isActive ? 'bg-brand-50 text-brand-600' : 'text-ink-700 hover:bg-canvas hover:text-ink-900',
                )}
              >
                {({ isActive }) => (
                  <>
                    {isActive && <span className="absolute -left-3 top-2 bottom-2 w-1 rounded-r-full bg-brand-500" aria-hidden />}
                    <Icon size={20} aria-hidden className={isActive ? 'text-brand-500' : 'text-ink-500 group-hover:text-ink-700'} />
                    <span className={cn(collapsed && 'sr-only')}>{it.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
