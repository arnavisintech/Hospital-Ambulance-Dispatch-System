import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface MenuItem {
  label: ReactNode;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface MenuProps {
  /** Render prop for the trigger; spread `props` onto a button (IconButton/Button). */
  trigger: (props: { onClick: () => void; 'aria-haspopup': 'menu'; 'aria-expanded': boolean; 'aria-controls': string }) => ReactNode;
  items: MenuItem[];
  /** Non-interactive header (e.g. user name + role). */
  header?: ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

/** Dropdown menu (role="menu", arrow keys, Esc, click-outside). */
export function Menu({ trigger, items, header, align = 'right', className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    requestAnimationFrame(() => refs.current.find((r) => r && !r.disabled)?.focus());
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    const list = refs.current.filter((r): r is HTMLButtonElement => !!r && !r.disabled);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); (root.current?.querySelector('[aria-haspopup]') as HTMLElement | null)?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div ref={root} className={cn('relative inline-flex', className)} onKeyDown={open ? onKey : undefined}>
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-haspopup': 'menu', 'aria-expanded': open, 'aria-controls': id })}
      <AnimatePresence>
        {open && (
          <motion.div
            id={id}
            role="menu"
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.15 } }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            className={cn(
              'absolute top-full z-modal mt-2 min-w-[220px] origin-top overflow-hidden rounded-lg border border-line/80 bg-surface py-1.5 shadow-raised',
              align === 'right' ? 'right-0' : 'left-0',
            )}
          >
            {header && <div className="border-b border-line px-4 pb-2.5 pt-1.5">{header}</div>}
            {items.map((it, i) => {
              const Icon = it.icon;
              return (
                <button
                  key={i}
                  ref={(el) => { refs.current[i] = el; }}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={it.disabled}
                  onClick={() => { setOpen(false); it.onSelect(); }}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium transition-colors disabled:opacity-40',
                    'hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none',
                    it.danger ? 'text-brand-600' : 'text-ink-900',
                  )}
                >
                  {Icon && <Icon size={18} className={it.danger ? '' : 'text-ink-500'} aria-hidden />}
                  {it.label}
                </button>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
