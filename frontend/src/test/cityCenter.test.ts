import { describe, expect, it } from 'vitest';
import { parseCityCenter } from '../lib/geo';

describe('parseCityCenter (STRQ5: the map centre is configuration, Chennai by default)', () => {
  it('defaults to Chennai when unset or malformed', () => {
    expect(parseCityCenter(undefined)).toEqual([13.0827, 80.2707]);
    expect(parseCityCenter('')).toEqual([13.0827, 80.2707]);
    expect(parseCityCenter('north,east')).toEqual([13.0827, 80.2707]);
    expect(parseCityCenter('95,80')).toEqual([13.0827, 80.2707]);
  });
  it('reads "lat,lng"', () => {
    expect(parseCityCenter('12.9716, 77.5946')).toEqual([12.9716, 77.5946]);
  });
});
