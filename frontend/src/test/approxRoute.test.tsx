import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NavBanner } from '../pages/crew/NavBanner';
import { approximateRoute } from '../lib/geo';

const step = { instruction: 'Continue straight', lat: 13.07, lng: 80.26, distance_m: 830, name: '', maneuver: { type: 'continue', modifier: 'straight' } };

describe('straight-line routes are never presented as directions (demo walk-through)', () => {
  it('recognises a fallback route', () => {
    expect(approximateRoute({ provider: 'haversine' })).toBe(true);
    expect(approximateRoute({ provider: 'osrm' })).toBe(false);
    expect(approximateRoute(null)).toBe(false);
  });

  it('the crew banner says road directions are unavailable instead of "Continue straight"', () => {
    render(<NavBanner next={{ index: 0, step, distanceM: 830 }} approximate={{ distanceKm: 9.4 }} />);
    expect(screen.getByText(/road directions unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/9\.4 km/)).toBeInTheDocument();
    expect(screen.queryByText(/continue straight/i)).not.toBeInTheDocument();
  });
});
