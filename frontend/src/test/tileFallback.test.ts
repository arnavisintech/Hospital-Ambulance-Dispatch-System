import { describe, expect, it } from 'vitest';
import { shouldFallBack, TILE_STALL_MS } from '../lib/mapTiles';

describe('base-map fallback (browser walk-through finding)', () => {
  it('falls back when errors dominate', () => {
    expect(shouldFallBack({ ok: 0, err: 4 }, 0)).toBe(true);
    expect(shouldFallBack({ ok: 10, err: 4 }, 0)).toBe(false);
  });

  it('falls back when the provider hangs: no tile loaded and no error after the stall window', () => {
    expect(shouldFallBack({ ok: 0, err: 0 }, TILE_STALL_MS - 1)).toBe(false);
    expect(shouldFallBack({ ok: 0, err: 0 }, TILE_STALL_MS)).toBe(true);
    expect(shouldFallBack({ ok: 1, err: 0 }, TILE_STALL_MS * 10)).toBe(false);
  });
});
