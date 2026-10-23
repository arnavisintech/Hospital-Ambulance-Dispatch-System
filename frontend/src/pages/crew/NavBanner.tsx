import { createElement } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { cn } from '../../lib/cn';
import { fmtMeters } from '../../lib/format';
import { maneuverIcon, maneuverText, type NextManeuver } from './nav';

/** Turn-by-turn banner (top of the navigation map): big arrow, distance to the maneuver, street name. */
export function NavBanner({ next, then, className }: { next: NextManeuver | null; then?: NextManeuver | null; className?: string }) {
  const reduce = useReducedMotion();
  if (!next) return null;
  const verb = maneuverText(next.step.maneuver);
  // v1 steps have no maneuver: fall back to the plain instruction text.
  const street = next.step.maneuver && next.step.maneuver.type !== 'arrive' ? next.step.name ?? '' : '';
  return (
    <div className={cn('pointer-events-auto', className)} role="status" aria-live="polite" aria-atomic="true">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={next.index}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.22 } }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          className="overflow-hidden rounded-xl bg-ink-900 text-white shadow-raised"
        >
          <div className="flex items-center gap-3 px-4 py-3">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-lg bg-white/10" aria-hidden>
              {createElement(maneuverIcon(next.step.maneuver), { size: 34, strokeWidth: 2.4 })}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-2xl font-extrabold leading-none tabular-nums">{fmtMeters(next.distanceM)}</p>
              <p className="mt-1 truncate text-base font-semibold text-white/90">
                {next.step.maneuver ? <>{verb}{street ? <> onto <span className="text-white">{street}</span></> : null}</> : next.step.instruction}
              </p>
            </div>
          </div>
          {then && (
            <div className="flex items-center gap-2 bg-white/5 px-4 py-1.5 text-sm text-white/80">
              Then {createElement(maneuverIcon(then.step.maneuver), { size: 16, 'aria-hidden': true })} <span className="truncate">{maneuverText(then.step.maneuver)}{then.step.name ? ` · ${then.step.name}` : ''}</span>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
