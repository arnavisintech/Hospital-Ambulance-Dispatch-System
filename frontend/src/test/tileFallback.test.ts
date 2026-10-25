import { describe, expect, it } from 'vitest';
import { shouldFallBack, TILE_STALL_MS } from '../lib/mapTiles';

describe('base-map fallback (browser walk-through finding)', () => {
  it('falls back when errors dominate', () => {
    expect(shouldFallBack({ started: 4, ok: 0, err: 4 }, 0)).toBe(true);
    expect(shouldFallBack({ started: 14, ok: 10, err: 4 }, 0)).toBe(false);
  });

  it('falls back when the provider hangs: no tile loaded and no error after the stall window', () => {
    expect(shouldFallBack({ started: 18, ok: 0, err: 0 }, TILE_STALL_MS - 1)).toBe(false);
    expect(shouldFallBack({ started: 18, ok: 0, err: 0 }, TILE_STALL_MS)).toBe(true);
    expect(shouldFallBack({ started: 18, ok: 18, err: 0 }, TILE_STALL_MS * 10)).toBe(false);
  });

  it('falls back when most tiles are still hanging after the stall window (a half-blank map)', () => {
    expect(shouldFallBack({ started: 18, ok: 5, err: 0 }, TILE_STALL_MS)).toBe(true);
    expect(shouldFallBack({ started: 18, ok: 12, err: 0 }, TILE_STALL_MS)).toBe(false);
  });
});
