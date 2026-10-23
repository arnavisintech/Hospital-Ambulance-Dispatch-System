/** Small live-ops helpers shared by the controller console and the hospital desk. */
import { useCallback, useEffect, useState } from 'react';

/** Re-render every `ms` and return Date.now() (age timers, ETA countdowns). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

let ctx: AudioContext | null = null;

/**
 * Subtle two-tone chime via WebAudio (no asset). `urgent` = slightly higher, three notes.
 * Silently does nothing when audio is unavailable or blocked by autoplay policy.
 */
export function playChime(urgent = false): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    const notes = urgent ? [880, 660, 880] : [660, 880];
    const t0 = ctx.currentTime + 0.01;
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const s = t0 + i * 0.16;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.12, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.22);
      o.connect(g).connect(ctx!.destination);
      o.start(s);
      o.stop(s + 0.24);
    });
  } catch { /* audio unavailable */ }
}

/** Persisted sound on/off preference. */
export function useSoundPref(key: string): [boolean, () => void] {
  const [on, setOn] = useState(() => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } });
  const toggle = useCallback(() => setOn((v) => {
    try { localStorage.setItem(key, v ? '0' : '1'); } catch { /* ignore */ }
    if (!v) playChime(); // audible confirmation + unlocks audio after a user gesture
    return !v;
  }), [key]);
  return [on, toggle];
}

/** True when the keyboard event target is a text field (skip single-key shortcuts). */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.getAttribute('role') === 'spinbutton';
}

/** A modal dialog (Modal / Drawer / ConfirmDialog) is currently open. */
export const modalOpen = () => typeof document !== 'undefined' && !!document.querySelector('[role="dialog"][aria-modal="true"]');
