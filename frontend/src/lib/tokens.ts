/**
 * Resolve design tokens to concrete colour strings for places that cannot use CSS variables directly
 * (Leaflet SVG path attributes, <canvas>, Recharts props). Reads the live values from :root (src/index.css);
 * the fallback table mirrors index.css for non-DOM environments (tests/SSR).
 */
export type TokenName =
  | 'brand-50' | 'brand-100' | 'brand-200' | 'brand-400' | 'brand-500' | 'brand-600' | 'brand-700'
  | 'ink-900' | 'ink-700' | 'ink-500' | 'ink-400' | 'line' | 'line-strong' | 'line-soft' | 'canvas' | 'surface'
  | 'success' | 'info' | 'warning' | 'violet' | 'orange' | 'teal' | 'chart-grid';

const FALLBACK: Record<TokenName, string> = {
  'brand-50': '254 242 243', 'brand-100': '253 227 229', 'brand-200': '251 201 205', 'brand-400': '240 100 111',
  'brand-500': '220 45 58', 'brand-600': '200 36 58', 'brand-700': '165 28 48',
  'ink-900': '17 24 39', 'ink-700': '55 65 81', 'ink-500': '103 110 124', 'ink-400': '156 163 175',
  line: '229 231 235', 'line-strong': '209 213 219', 'line-soft': '238 240 243', canvas: '244 245 247', surface: '255 255 255',
  success: '22 163 74', info: '37 99 235', warning: '217 119 6', violet: '124 58 237', orange: '234 88 12', teal: '13 148 136',
  'chart-grid': '238 240 243',
};

const cache = new Map<TokenName, [number, number, number]>();

/** [r, g, b] for a token. */
export function tokenRgbTuple(name: TokenName): [number, number, number] {
  const hit = cache.get(name);
  if (hit) return hit;
  let raw = '';
  try {
    raw = typeof document !== 'undefined' ? getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() : '';
  } catch { /* no DOM */ }
  const parts = (raw || FALLBACK[name]).split(/[\s,]+/).map(Number);
  const tuple: [number, number, number] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  if (raw) cache.set(name, tuple);
  return tuple;
}

/** CSS colour string, e.g. token('brand-500') -> "rgb(220 45 58)", token('ink-900', .5) -> "rgb(17 24 39 / 0.5)". */
export function token(name: TokenName, alpha = 1): string {
  const [r, g, b] = tokenRgbTuple(name);
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}

/** Recharts palette (DESIGN_SYSTEM: brand, info, teal, violet, orange, amber, ink-400). */
export const chartPalette = () => [token('brand-500'), token('info'), token('teal'), token('violet'), token('orange'), token('warning'), token('ink-400')];
