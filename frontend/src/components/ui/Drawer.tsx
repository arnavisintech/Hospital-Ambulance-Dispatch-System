import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useFocusTrap, useLockBodyScroll } from '../../hooks/useFocusTrap';
import { IconButton } from './IconButton';
import { SPRING } from './Modal';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Visible heading; pass `hideHeader` + `ariaLabel` for custom headers (e.g. nav drawer with logo). */
  title?: ReactNode;
  ariaLabel?: string;
  side?: 'left' | 'right';
  /** CSS width, default min(86vw, 320px) left / min(100vw, 420px) right. */
  width?: string;
  hideHeader?: boolean;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Slide-over panel (focus trap, Esc, scrim). Used for mobile console nav and detail panels. */
export function Drawer({ open, onClose, title, ariaLabel, side = 'right', width, hideHeader, footer, children, className }: DrawerProps) {
  return createPortal(
    <AnimatePresence>
      {open && <DrawerBody {...{ onClose, title, ariaLabel, side, width, hideHeader, footer, className }}>{children}</DrawerBody>}
    </AnimatePresence>,
    document.body,
  );
}

function DrawerBody({ onClose, title, ariaLabel, side = 'right', width, hideHeader, footer, children, className }: Omit<DrawerProps, 'open'>) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const reduce = useReducedMotion();
  useFocusTrap(ref, true, onClose);
  useLockBodyScroll(true);
  const off = side === 'left' ? '-100%' : '100%';
  return (
    <div className="fixed inset-0 z-modal">
      <motion.div
        className="absolute inset-0 bg-ink-900/50" aria-hidden onClick={onClose}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.14 } }}
      />
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={!hideHeader && title ? titleId : undefined}
        aria-label={hideHeader || !title ? ariaLabel : undefined}
        tabIndex={-1}
        style={{ width: width ?? (side === 'left' ? 'min(86vw, 320px)' : 'min(100vw, 420px)') }}
        className={cn(
          'absolute inset-y-0 flex flex-col bg-surface shadow-raised pt-safe pb-safe',
          side === 'left' ? 'left-0 rounded-r-2xl' : 'right-0 sm:rounded-l-2xl', className,
        )}
        initial={reduce ? { opacity: 0 } : { x: off }}
        animate={reduce ? { opacity: 1 } : { x: 0, transition: SPRING }}
        exit={reduce ? { opacity: 0 } : { x: off, transition: { duration: 0.16, ease: 'easeIn' } }}
      >
        {!hideHeader && (
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            <h2 id={titleId} className="min-w-0 flex-1 truncate text-lg font-bold">{title}</h2>
            <IconButton label="Close" icon={X} size="sm" onClick={onClose} />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>
        {footer && <div className="border-t border-line p-4">{footer}</div>}
      </motion.div>
    </div>
  );
}
