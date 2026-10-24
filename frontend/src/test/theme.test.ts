import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cn } from '../lib/cn';

/**
 * One theme across every screen: colours come from the design tokens (tailwind.config.js -> CSS variables in
 * index.css) and type sizes from the named scale. These guards fail on anything that bypasses them.
 */
const SRC = resolve(__dirname, '..');
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  if (statSync(p).isDirectory()) return n === 'test' ? [] : files(p);
  return /\.(tsx?|css)$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
});
const SOURCES = files(SRC).map((p) => ({ path: relative(SRC, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));

const offenders = (re: RegExp, skip: (path: string) => boolean = () => false) => SOURCES
  .filter((f) => !skip(f.path))
  .flatMap((f) => f.text.split('\n').flatMap((line, i) => [...line.matchAll(re)].map((m) => `${f.path}:${i + 1} ${m[0]}`)));

describe('theme consistency', () => {
  it('uses no raw hex colours outside the token definitions', () => {
    // index.css defines the tokens; a hex inside an SVG data URI or comment there is the source of truth.
    expect(offenders(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b(?![-\w])/g, (p) => p === 'index.css')).toEqual([]);
  });

  it('uses no Tailwind default-palette colours (only design tokens)', () => {
    const palette = 'slate|gray|zinc|neutral|stone|red|amber|yellow|lime|green|emerald|cyan|sky|blue|indigo|purple|fuchsia|pink|rose';
    const re = new RegExp(`\\b(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|placeholder|accent|caret|decoration)-(?:${palette})-\\d{2,3}\\b`, 'g');
    expect(offenders(re)).toEqual([]);
  });

  it('uses only the named type scale (no ad-hoc pixel font sizes)', () => {
    expect(offenders(/\btext-\[\d+(?:\.\d+)?(?:px|rem)\]/g)).toEqual([]);
  });

  it('keeps no legacy aliases or pre-design-system utility classes', () => {
    expect(offenders(/\b(?:bg|text|border|ring)-sos\b/g)).toEqual([]);
    const css = SOURCES.find((f) => f.path === 'index.css')!.text;
    expect(css).not.toMatch(/\.btn-primary|\.btn-secondary|\.input\s*\{|\.chip\s*\{/);
  });

  it('cn() treats every named size as a font size, never as a colour', () => {
    for (const size of ['3xs', '2xs', 'xs', 'sm', 'md', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', 'display', 'display-lg']) {
      expect(cn(`text-${size}`, 'text-ink-500').split(' ')).toEqual([`text-${size}`, 'text-ink-500']);
    }
    expect(cn('text-2xs', 'text-sm')).toBe('text-sm');   // two sizes still resolve to the last
  });
});
