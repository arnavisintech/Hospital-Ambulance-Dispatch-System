import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toneClasses, type Tone } from '../lib/status';
import { tokenRgbTuple, type TokenName } from '../lib/tokens';

/**
 * WCAG 2.1 contrast of the design tokens (src/index.css) for every text/background pairing the design system uses.
 * axe cannot compute colours in jsdom, so the palette itself is checked here: 4.5:1 for text, 3:1 for icons and
 * other non-text marks. ink-400 is for placeholders, disabled controls and decoration only, so it is not checked.
 */
const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
const TOKENS = Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(\d+) (\d+) (\d+);/g)]
  .map((m) => [m[1], [Number(m[2]), Number(m[3]), Number(m[4])] as const]));

const lum = ([r, g, b]: readonly number[]) => {
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(TOKENS[a]), lum(TOKENS[b])].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const failing = (pairs: [string, string][], min: number) =>
  pairs.filter(([f, b]) => contrast(f, b) < min).map(([f, b]) => `${f} on ${b}: ${contrast(f, b).toFixed(2)}`);

const TONES = ['success', 'info', 'warning', 'violet', 'orange', 'teal'];

describe('token contrast (WCAG AA)', () => {
  it('body, secondary and heading text on every page surface', () => {
    const pairs: [string, string][] = ['ink-900', 'ink-700', 'ink-500'].flatMap((f) => [[f, 'surface'], [f, 'canvas']] as [string, string][]);
    expect(failing(pairs, 4.5)).toEqual([]);
  });

  it('tone text (-fg) on its tint and on white', () => {
    const pairs = TONES.flatMap((t) => [[`${t}-fg`, `${t}-bg`], [`${t}-fg`, 'surface']] as [string, string][]);
    expect(failing([...pairs, ['brand-600', 'brand-50'], ['brand-600', 'surface']], 4.5)).toEqual([]);
  });

  it('white text on filled brand and info controls (primary buttons, badges, SOS)', () => {
    expect(failing([['surface', 'brand-500'], ['surface', 'brand-600'], ['surface', 'brand-700'], ['surface', 'info'], ['surface', 'ink-900']], 4.5)).toEqual([]);
  });

  it('brand-coloured text on white', () => {
    expect(failing([['brand-500', 'surface']], 4.5)).toEqual([]);
  });

  it('icons and other non-text marks in tone colours', () => {
    expect(failing([...TONES, 'brand-500'].map((t) => [t, 'surface'] as [string, string]), 3)).toEqual([]);
  });
});

describe('token sources agree', () => {
  it('the TypeScript fallback table mirrors index.css exactly', () => {
    const names = ['brand-50', 'brand-100', 'brand-200', 'brand-400', 'brand-500', 'brand-600', 'brand-700', 'ink-900', 'ink-700',
      'ink-500', 'ink-400', 'line', 'line-strong', 'line-soft', 'canvas', 'surface', 'success', 'info', 'warning', 'violet', 'orange',
      'teal', 'chart-grid'] as TokenName[];
    // jsdom has no stylesheet loaded, so tokenRgbTuple falls back to the table in lib/tokens.ts
    expect(Object.fromEntries(names.map((n) => [n, tokenRgbTuple(n)]))).toEqual(Object.fromEntries(names.map((n) => [n, [...TOKENS[n]]])));
  });
});

describe('component colour pairings', () => {
  // Tailwind colour names that are aliases of another token (tailwind.config.js).
  const ALIAS: Record<string, string> = { danger: 'brand-500', 'danger-fg': 'brand-600', 'danger-bg': 'brand-50' };
  const bgToken = (cls: string) => {
    const m = /\bbg-([a-z0-9-]+)\b/.exec(cls);
    return m ? (ALIAS[m[1]] ?? m[1]) : '';
  };

  it('every solid status style (badges, severity pickers, timeline) has readable white text', () => {
    const tones: Tone[] = ['neutral', 'muted', 'brand', 'danger', 'critical', 'success', 'info', 'warning', 'violet', 'orange', 'teal'];
    const bad = tones
      .map((t) => [t, bgToken(toneClasses(t).solid)] as const)
      .filter(([, bg]) => !TOKENS[bg] || contrast('surface', bg) < 4.5)
      .map(([t, bg]) => (TOKENS[bg] ? `${t}: white on ${bg} = ${contrast('surface', bg).toFixed(2)}` : `${t}: unknown fill '${bg}'`));
    expect(bad).toEqual([]);
  });
});
