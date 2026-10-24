import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Ambulance, Building2, ChevronDown, Flame, Hospital, Layers as LayersIcon, Route, type LucideIcon } from 'lucide-react';
import { Spinner } from '../../components/ui';
import { cn } from '../../lib/cn';
import { ambulanceStatusMeta, severityMeta, toneClasses } from '../../lib/status';
import type { Layers } from './ConsoleMap';

const LAYER_ITEMS: { key: keyof Layers; label: string; icon: LucideIcon }[] = [
  { key: 'units', label: 'Ambulances', icon: Ambulance },
  { key: 'routes', label: 'Routes', icon: Route },
  { key: 'hospitals', label: 'Hospitals', icon: Hospital },
  { key: 'stations', label: 'Stations', icon: Building2 },
  { key: 'risk', label: 'Risk heat', icon: Flame },
];

/** Floating layer toggles (top-right of the map). */
export function LayerToggles({ layers, onChange, riskLoading, riskError, compact }: {
  layers: Layers; onChange: (l: Layers) => void; riskLoading?: boolean; riskError?: string | null;
  /** Icon-only column (e.g. while a detail panel is open). */
  compact?: boolean;
}) {
  return (
    <div className="pointer-events-auto rounded-lg border border-line/70 bg-surface/95 p-1.5 shadow-raised backdrop-blur">
      <p className={cn('flex items-center gap-1.5 pb-1 pt-1 text-xs font-semibold uppercase tracking-wide text-ink-500', compact ? 'justify-center' : 'px-2')}>
        <LayersIcon size={14} aria-hidden /><span className={cn(compact && 'sr-only')}>Layers</span>
      </p>
      <ul className="flex flex-col gap-0.5" aria-label="Map layers">
        {LAYER_ITEMS.map(({ key, label, icon: Icon }) => {
          const on = layers[key];
          return (
            <li key={key}>
              <button
                type="button"
                aria-pressed={on}
                title={compact ? label : undefined}
                onClick={() => onChange({ ...layers, [key]: !on })}
                className={cn(
                  'press flex h-9 w-full items-center gap-2.5 rounded-md text-sm font-semibold transition-colors',
                  compact ? 'justify-center px-1.5' : 'px-2',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                  on ? 'text-ink-900 hover:bg-canvas' : 'text-ink-500 hover:bg-canvas hover:text-ink-700',
                )}
              >
                <span className={cn('flex h-6 w-6 items-center justify-center rounded-sm', on ? (key === 'risk' ? 'bg-orange-bg text-orange-fg' : 'bg-ink-900 text-white') : 'bg-canvas text-ink-400')} aria-hidden>
                  <Icon size={14} />
                </span>
                <span className={cn('flex-1 text-left', compact && 'sr-only')}>{label}</span>
                {!compact && key === 'risk' && on && riskLoading && <Spinner size={14} />}
                {!compact && <span className={cn('h-2 w-2 rounded-full', on ? 'bg-success' : 'bg-line-strong')} aria-hidden />}
              </button>
            </li>
          );
        })}
      </ul>
      {layers.risk && riskError && <p className="max-w-[180px] px-2 pb-1 text-xs font-medium text-danger-fg" role="alert">Risk map unavailable</p>}
    </div>
  );
}

const AMB_LEGEND = ['available', 'assigned', 'en_route', 'on_scene', 'transporting', 'offline'] as const;

/** Collapsible legend (bottom-left of the map). */
export function MapLegend({ showRisk }: { showRisk: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pointer-events-auto w-[212px] rounded-lg border border-line/70 bg-surface/95 shadow-raised backdrop-blur">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-9 w-full items-center justify-between rounded-lg px-3 text-xs font-semibold uppercase tracking-wide text-ink-500 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        Legend
        <ChevronDown size={16} aria-hidden className={cn('transition-transform duration-micro', open ? 'rotate-180' : '')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 px-3 pb-3 text-xs font-medium text-ink-700">
              <div>
                <p className="mb-1.5 font-semibold text-ink-900">Ambulances</p>
                <ul className="grid grid-cols-2 gap-x-2 gap-y-1">
                  {AMB_LEGEND.map((s) => {
                    const m = ambulanceStatusMeta(s);
                    return (
                      <li key={s} className="flex items-center gap-1.5">
                        <span className={cn('h-2.5 w-2.5 rounded-full ring-2 ring-surface', toneClasses(m.tone).dot)} aria-hidden />{m.label}
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div>
                <p className="mb-1.5 font-semibold text-ink-900">Requests by severity</p>
                <div className="flex items-center gap-1" aria-label="Mild to life-threatening">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <span key={n} title={severityMeta(n).label} className={cn('h-2.5 flex-1 rounded-full', toneClasses(severityMeta(n).tone).dot)} aria-hidden />
                  ))}
                </div>
                <div className="mt-1 flex justify-between text-ink-500"><span>Mild</span><span>Life-threatening</span></div>
              </div>
              <div>
                <p className="mb-1.5 font-semibold text-ink-900">Routes</p>
                <p className="flex items-center gap-2"><span className="h-1 w-6 rounded-full bg-brand-500" aria-hidden />To patient</p>
                <p className="mt-1 flex items-center gap-2"><span className="h-1 w-6 rounded-full bg-info" aria-hidden />To hospital</p>
              </div>
              <p className="flex items-center gap-2">
                <span className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-teal bg-surface text-3xs font-extrabold text-teal-fg" aria-hidden>H</span>
                Hospital · badge = free beds
              </p>
              {showRisk && (
                <div>
                  <p className="mb-1.5 font-semibold text-ink-900">Predicted demand</p>
                  <div className="h-2 rounded-full bg-gradient-to-r from-success via-warning to-brand-600" aria-hidden />
                  <div className="mt-1 flex justify-between text-ink-500"><span>Low</span><span>High</span></div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
