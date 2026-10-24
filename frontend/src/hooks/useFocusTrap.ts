import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', 'iframe', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && el.getAttribute('aria-hidden') !== 'true' && (el.offsetParent !== null || el === document.activeElement || getComputedStyle(el).position === 'fixed'),
  );
}

/** Stack of active traps so only the top-most overlay reacts to Tab / Escape. */
const trapStack: object[] = [];

/**
 * Trap Tab focus inside `ref` while `active`, close on Escape, focus the first focusable element (or the
 * element marked `data-autofocus`) on open, and restore focus to the previously focused element on close.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void): void {
  const escRef = useRef(onEscape);
  useEffect(() => { escRef.current = onEscape; });
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    const token = {};
    trapStack.push(token);

    const initial = root.querySelector<HTMLElement>('[data-autofocus]') ?? focusableIn(root)[0] ?? root;
    // Defer so enter animations / portals have mounted.
    const raf = requestAnimationFrame(() => initial.focus({ preventScroll: true }));

    const onKey = (e: KeyboardEvent) => {
      if (trapStack[trapStack.length - 1] !== token) return;
      if (e.key === 'Escape' && escRef.current) {
        e.stopPropagation();
        escRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusableIn(root);
      if (items.length === 0) { e.preventDefault(); root.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      const cur = document.activeElement;
      if (e.shiftKey && (cur === first || !root.contains(cur))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (cur === last || !root.contains(cur))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(raf);
      trapStack.splice(trapStack.indexOf(token), 1);
      document.removeEventListener('keydown', onKey, true);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [active, ref]);
}

let locks = 0;
let saved = '';
/** Prevent background page scroll while an overlay is open (ref-counted for stacked overlays). */
export function useLockBodyScroll(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (locks++ === 0) {
      saved = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    return () => {
      if (--locks === 0) document.body.style.overflow = saved;
    };
  }, [active]);
}
