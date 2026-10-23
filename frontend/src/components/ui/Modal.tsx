import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, X, type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useFocusTrap, useLockBodyScroll } from '../../hooks/useFocusTrap';
import { toneClasses, type Tone } from '../../lib/status';
import { Button } from './Button';
import { IconButton } from './IconButton';

export const SPRING = { type: 'spring' as const, stiffness: 420, damping: 36 };

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Sticky footer (actions). */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Close when clicking the scrim (default true). */
  dismissible?: boolean;
  /** Hide the X button (still closes on Esc unless dismissible=false). */
  hideClose?: boolean;
  className?: string;
}

const W = { sm: 'sm:max-w-sm', md: 'sm:max-w-md', lg: 'sm:max-w-lg', xl: 'sm:max-w-2xl' };

/**
 * Accessible dialog: portal, 50% scrim, focus trap, Esc to close, focus restore, body scroll lock.
 * Phones: slides up from the bottom (sheet-like). >= 640px: centred card.
 * Put `data-autofocus` on the element that should receive initial focus.
 */
export function Modal({ open, onClose, title, description, children, footer, size = 'md', dismissible = true, hideClose, className }: ModalProps) {
  return createPortal(
    <AnimatePresence>
      {open && (
        <ModalBody {...{ onClose, title, description, footer, size, dismissible, hideClose, className }}>{children}</ModalBody>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function ModalBody({ onClose, title, description, children, footer, size = 'md', dismissible = true, hideClose, className }: Omit<ModalProps, 'open'>) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const reduce = useReducedMotion();
  useFocusTrap(ref, true, dismissible ? onClose : undefined);
  useLockBodyScroll(true);

  return (
    <div className="fixed inset-0 z-modal flex items-end justify-center sm:items-center sm:p-6">
      <motion.div
        className="absolute inset-0 bg-ink-900/50"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.14 } }}
        onClick={dismissible ? onClose : undefined}
        aria-hidden
      />
      <motion.div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          'relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface shadow-raised',
          'rounded-t-2xl sm:rounded-2xl pb-safe sm:pb-0', W[size], className,
        )}
        initial={reduce ? { opacity: 0 } : { opacity: 0, y: 40, scale: 0.98 }}
        animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, transition: SPRING }}
        exit={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.98, transition: { duration: 0.14 } }}
      >
        <div className="flex items-start gap-3 px-5 pb-2 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-bold text-ink-900">{title}</h2>
            {description && <p id={descId} className="mt-1 text-sm text-ink-500">{description}</p>}
          </div>
          {!hideClose && <IconButton label="Close" icon={X} size="sm" onClick={onClose} className="-mr-2 -mt-1" />}
        </div>
        {children && <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 scrollbar-thin">{children}</div>}
        {footer && <div className="flex flex-col-reverse gap-2 border-t border-line px-5 py-4 sm:flex-row sm:justify-end">{footer}</div>}
      </motion.div>
    </div>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  /** May return a promise: the confirm button shows a spinner until it settles, then the dialog closes. */
  onConfirm: () => void | Promise<unknown>;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' for destructive actions (cancel request, close trip), 'primary' otherwise. */
  tone?: 'danger' | 'primary';
  icon?: LucideIcon;
  children?: ReactNode;
}

/** Yes/no confirmation built on Modal. Cancel gets initial focus for destructive actions. */
export function ConfirmDialog({
  open, onClose, onConfirm, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'primary', icon, children,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const Icon = icon ?? (tone === 'danger' ? AlertTriangle : undefined);
  const t: Tone = tone === 'danger' ? 'danger' : 'brand';
  const run = async () => {
    setBusy(true);
    try { await onConfirm(); onClose(); } catch { /* caller surfaces the error (toast); keep dialog open */ } finally { setBusy(false); }
  };
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      size="sm"
      title={
        <span className="flex items-center gap-3">
          {Icon && <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-full', toneClasses(t).soft)} aria-hidden><Icon size={20} /></span>}
          {title}
        </span>
      }
      description={description}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy} data-autofocus={tone === 'danger' ? true : undefined}>{cancelLabel}</Button>
          {/* danger = brand red per DESIGN_SYSTEM, so both tones use the primary (brand) button */}
          <Button variant="primary" onClick={() => void run()} loading={busy} data-autofocus={tone !== 'danger' ? true : undefined}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
