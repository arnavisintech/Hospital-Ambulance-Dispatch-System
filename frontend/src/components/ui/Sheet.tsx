import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AnimatePresence, animate, motion, useDragControls, useMotionValue, useReducedMotion, type PanInfo,
} from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useIsDesktop } from '../../hooks/useMediaQuery';
import { useFocusTrap, useLockBodyScroll } from '../../hooks/useFocusTrap';
import { IconButton } from './IconButton';
import { Modal, SPRING } from './Modal';

export interface SheetProps {
  /** Default true (persistent sheets over a map are simply always open). */
  open?: boolean;
  /** When set: shows a close button, allows drag-down-to-dismiss and scrim click (modal). */
  onClose?: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Extra header content under the title (e.g. ETA hero). Also acts as a drag handle. */
  header?: ReactNode;
  children?: ReactNode;
  /** Sticky footer pinned to the bottom of the screen (safe-area aware), e.g. a SlideButton / CTA. */
  footer?: ReactNode;
  /** Visible heights as fractions of the viewport, ascending. Default [0.42, 0.9]. */
  snapPoints?: number[];
  /** Initial snap index (uncontrolled). */
  initialSnap?: number;
  /** Controlled snap index. */
  snap?: number;
  onSnapChange?: (index: number) => void;
  /** Scrim + focus trap + body scroll lock. Default false (persistent map sheet). */
  modal?: boolean;
  /** Rendering at >= 1024px: 'panel' = fixed right side panel (420px), 'dialog' = centred Modal. */
  desktop?: 'panel' | 'dialog';
  /** CSS `top` of the desktop side panel. Default var(--appbar-h). */
  panelTop?: string;
  /** Accessible name when there is no title. */
  ariaLabel?: string;
  className?: string;
}

function useViewportHeight(): number {
  const [vh, setVh] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight));
  useEffect(() => {
    const on = () => setVh(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return vh;
}

/**
 * Bottom sheet (phones/tablets) with 2-3 snap points, a keyboard-operable grabber and a visible close/back
 * affordance; renders as a right side panel (or dialog) on desktop.
 */
export function Sheet(props: SheetProps) {
  const { open = true, modal = false, desktop: desktopMode = modal ? 'dialog' : 'panel' } = props;
  const isDesktop = useIsDesktop();

  if (isDesktop && desktopMode === 'dialog') {
    return (
      <Modal open={open} onClose={props.onClose ?? (() => {})} hideClose={!props.onClose} dismissible={!!props.onClose}
        title={props.title ?? props.ariaLabel ?? ''} description={props.subtitle} footer={props.footer}>
        {props.header}
        {props.children}
      </Modal>
    );
  }
  return createPortal(
    <AnimatePresence>{open && (isDesktop ? <SidePanel {...props} /> : <BottomSheet {...props} />)}</AnimatePresence>,
    document.body,
  );
}

function SheetHeading({ title, subtitle, titleId, onClose }: { title?: ReactNode; subtitle?: ReactNode; titleId: string; onClose?: () => void }) {
  if (!title && !onClose) return null;
  return (
    <div className="flex items-start gap-3 px-5 pb-2">
      <div className="min-w-0 flex-1">
        {title && <h2 id={titleId} className="text-lg font-bold leading-tight text-ink-900">{title}</h2>}
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {onClose && <IconButton label="Close" icon={X} size="sm" variant="secondary" onClick={onClose} className="-mr-1" />}
    </div>
  );
}

function SidePanel({ onClose, title, subtitle, header, children, footer, modal, panelTop = 'var(--appbar-h)', ariaLabel, className }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const reduce = useReducedMotion();
  useFocusTrap(ref, !!modal, onClose);
  return (
    <>
      {modal && (
        <motion.div className="fixed inset-0 z-sheet bg-ink-900/50" aria-hidden onClick={onClose}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      )}
      <motion.aside
        ref={ref}
        role={modal ? 'dialog' : 'complementary'}
        aria-modal={modal || undefined}
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        style={{ top: panelTop }}
        className={cn('fixed bottom-0 right-0 z-sheet flex w-panel flex-col border-l border-line bg-surface shadow-raised', className)}
        initial={reduce ? { opacity: 0 } : { x: '100%' }}
        animate={reduce ? { opacity: 1 } : { x: 0, transition: SPRING }}
        exit={reduce ? { opacity: 0 } : { x: '100%', transition: { duration: 0.16 } }}
      >
        <div className="pt-5">
          <SheetHeading title={title} subtitle={subtitle} titleId={titleId} onClose={onClose} />
          {header && <div className="px-5 pb-3">{header}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 scrollbar-thin">{children}</div>
        {footer && <div className="border-t border-line bg-surface px-5 py-4">{footer}</div>}
      </motion.aside>
    </>
  );
}

function BottomSheet({
  onClose, title, subtitle, header, children, footer, snapPoints = [0.42, 0.9], initialSnap = 0, snap, onSnapChange,
  modal, ariaLabel, className,
}: SheetProps) {
  const vh = useViewportHeight();
  const reduce = useReducedMotion();
  const controls = useDragControls();
  const ref = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const snapKey = snapPoints.join(',');
  const points = useMemo(() => (snapKey ? snapKey.split(',').map(Number).sort((a, b) => a - b) : [0.5]), [snapKey]);
  const max = points[points.length - 1];
  const sheetH = Math.round(max * vh);
  const offsetFor = useCallback((i: number) => Math.round((max - points[Math.min(Math.max(i, 0), points.length - 1)]) * vh), [vh, max, points]);

  const [inner, setInner] = useState(initialSnap);
  const index = snap ?? inner;
  const setIndex = (i: number) => { if (snap === undefined) setInner(i); onSnapChange?.(i); };

  const y = useMotionValue(sheetH); // start off-screen, animate in
  const [footerH, setFooterH] = useState(0);

  useFocusTrap(ref, !!modal, onClose);
  useLockBodyScroll(!!modal);

  useLayoutEffect(() => {
    const el = footerRef.current;
    if (!el) { setFooterH(0); return; }
    const ro = new ResizeObserver(() => setFooterH(el.offsetHeight));
    ro.observe(el);
    setFooterH(el.offsetHeight);
    return () => ro.disconnect();
  }, [footer]);

  useEffect(() => {
    const target = offsetFor(index);
    const a = reduce ? (y.set(target), null) : animate(y, target, SPRING);
    return () => a?.stop();
  }, [index, offsetFor, reduce, y]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const projected = y.get() + info.velocity.y * 0.2;
    const minOffset = offsetFor(0);
    if (onClose && projected > minOffset + points[0] * vh * 0.45) { onClose(); return; }
    let best = 0, bestD = Infinity;
    points.forEach((_p, i) => { const d = Math.abs(offsetFor(i) - projected); if (d < bestD) { bestD = d; best = i; } });
    if (best === index) animate(y, offsetFor(best), SPRING); else setIndex(best);
  };

  const expanded = index === points.length - 1;
  const toggle = () => setIndex(expanded ? 0 : points.length - 1);

  return (
    <>
      {modal && (
        <motion.div className="fixed inset-0 z-sheet bg-ink-900/50" aria-hidden onClick={onClose}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
      )}
      <motion.section
        ref={ref}
        role={modal ? 'dialog' : 'region'}
        aria-modal={modal || undefined}
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel ?? 'Details'}
        tabIndex={-1}
        className={cn('fixed inset-x-0 bottom-0 z-sheet flex flex-col rounded-t-2xl bg-surface shadow-sheet', className)}
        style={{ height: sheetH, y }}
        drag="y"
        dragControls={controls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: sheetH }}
        dragElastic={{ top: 0.05, bottom: 0.2 }}
        dragMomentum={false}
        onDragEnd={onDragEnd}
        exit={reduce ? { opacity: 0 } : { y: sheetH, transition: { duration: 0.18 } }}
      >
        <div className="shrink-0 cursor-grab touch-none select-none active:cursor-grabbing" onPointerDown={(e) => controls.start(e)}>
          <button
            type="button"
            onClick={toggle}
            aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
            aria-expanded={expanded}
            className="mx-auto flex h-6 w-full items-center justify-center focus-visible:outline-none focus-visible:[&>span]:bg-brand-500"
          >
            <span className="h-1.5 w-10 rounded-full bg-line-strong" aria-hidden />
          </button>
          <SheetHeading title={title} subtitle={subtitle} titleId={titleId} onClose={onClose} />
          {header && <div className="px-5 pb-3">{header}</div>}
        </div>
        <motion.div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 scrollbar-thin"
          style={{ paddingBottom: footer ? footerH + 16 : 24 }}
        >
          {children}
          {/* Spacer so the last content can scroll above the screen edge at lower snap points. */}
          <motion.div aria-hidden style={{ height: y }} />
        </motion.div>
      </motion.section>
      {footer && (
        <motion.div
          ref={footerRef}
          className="fixed inset-x-0 bottom-0 z-sheet border-t border-line bg-surface px-4 pt-3 pb-safe-3"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          {footer}
        </motion.div>
      )}
    </>
  );
}
