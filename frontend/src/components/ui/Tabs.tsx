import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: LucideIcon;
  /** Count badge. */
  badge?: number;
  disabled?: boolean;
}

/** Roving arrow-key navigation shared by Tabs and SegmentedControl. */
function useRovingKeys<V extends string>(items: TabItem<V>[], value: V, onChange: (v: V) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent) => {
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    const cur = enabled.indexOf(items.findIndex((i) => i.value === value));
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = enabled[(cur + 1) % enabled.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = enabled[(cur - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (next < 0) return;
    e.preventDefault();
    onChange(items[next].value);
    refs.current[next]?.focus();
  };
  return { refs, onKeyDown };
}

export interface TabsProps<V extends string> {
  items: TabItem<V>[];
  value: V;
  onChange: (v: V) => void;
  /** Stable prefix for ids; pair panels with `tabPanelProps(id, value)`. */
  id?: string;
  /** 'underline' (page sections) or 'pill' (compact filters). */
  variant?: 'underline' | 'pill';
  fullWidth?: boolean;
  ariaLabel?: string;
  className?: string;
}

export const tabId = (id: string, v: string) => `${id}-tab-${v}`;
export const panelId = (id: string, v: string) => `${id}-panel-${v}`;
/** Spread on the content container for the active tab: `<div {...tabPanelProps('trip', tab)}>`. */
export const tabPanelProps = (id: string, v: string) => ({ id: panelId(id, v), role: 'tabpanel' as const, 'aria-labelledby': tabId(id, v), tabIndex: 0 });

/** WAI-ARIA tabs (tab list only — render the active panel yourself with `tabPanelProps`). */
export function Tabs<V extends string>({ items, value, onChange, id: idProp, variant = 'underline', fullWidth, ariaLabel, className }: TabsProps<V>) {
  const auto = useId();
  const id = idProp ?? auto;
  const reduce = useReducedMotion();
  const { refs, onKeyDown } = useRovingKeys(items, value, onChange);
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        'relative flex scrollbar-none',
        variant === 'underline' ? 'gap-1 overflow-x-auto border-b border-line' : 'gap-2 overflow-x-auto',
        className,
      )}
    >
      {items.map((it, i) => {
        const active = it.value === value;
        const Icon = it.icon;
        return (
          <button
            key={it.value}
            ref={(el) => { refs.current[i] = el; }}
            role="tab"
            id={tabId(id, it.value)}
            aria-selected={active}
            aria-controls={panelId(id, it.value)}
            tabIndex={active ? 0 : -1}
            disabled={it.disabled}
            onClick={() => onChange(it.value)}
            className={cn(
              'relative inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-semibold transition-colors duration-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-40',
              fullWidth && 'flex-1',
              variant === 'underline'
                ? cn('h-11 px-3 text-sm', active ? 'text-ink-900' : 'text-ink-500 hover:text-ink-900')
                : cn('h-9 rounded-full border px-3.5 text-sm', active ? 'border-ink-900 bg-ink-900 text-white' : 'border-line-strong bg-surface text-ink-700 hover:border-ink-400'),
            )}
          >
            {Icon && <Icon size={16} aria-hidden />}
            {it.label}
            {it.badge !== undefined && (
              <span className={cn('min-w-[20px] rounded-full px-1.5 text-xs leading-5 tabular-nums',
                active ? (variant === 'pill' ? 'bg-white/20 text-white' : 'bg-brand-500 text-white') : 'bg-canvas text-ink-700')}>
                {it.badge}
              </span>
            )}
            {variant === 'underline' && active && (
              <motion.span
                layoutId={`${id}-underline`}
                className="absolute inset-x-2 -bottom-px h-[3px] rounded-full bg-brand-500"
                transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40 }}
                aria-hidden
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface SegmentedControlProps<V extends string> {
  items: TabItem<V>[];
  value: V;
  onChange: (v: V) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
}

/** iOS-style segmented control (radiogroup) with a sliding thumb. Use for 2-4 mutually exclusive views/filters. */
export function SegmentedControl<V extends string>({ items, value, onChange, ariaLabel, size = 'md', fullWidth, className }: SegmentedControlProps<V>) {
  const id = useId();
  const reduce = useReducedMotion();
  const { refs, onKeyDown } = useRovingKeys(items, value, onChange);
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn('inline-flex rounded-full bg-canvas p-1 ring-1 ring-inset ring-line', fullWidth && 'flex w-full', className)}
    >
      {items.map((it, i) => {
        const active = it.value === value;
        const Icon = it.icon;
        return (
          <button
            key={it.value}
            ref={(el) => { refs.current[i] = el; }}
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={it.disabled}
            onClick={() => onChange(it.value)}
            className={cn(
              'relative inline-flex items-center justify-center gap-1.5 rounded-full font-semibold transition-colors duration-micro',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-40',
              size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-sm',
              fullWidth && 'flex-1',
              active ? 'text-ink-900' : 'text-ink-500 hover:text-ink-900',
            )}
          >
            {active && (
              <motion.span
                layoutId={`${id}-thumb`}
                className="absolute inset-0 rounded-full bg-surface shadow-card ring-1 ring-line/80"
                transition={reduce ? { duration: 0 } : { type: 'spring', stiffness: 500, damping: 40 }}
                aria-hidden
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {Icon && <Icon size={size === 'sm' ? 14 : 16} aria-hidden />}
              {it.label}
              {it.badge !== undefined && <span className="tabular-nums text-ink-500">{it.badge}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
