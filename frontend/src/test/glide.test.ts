import { describe, expect, it } from 'vitest';
import { bearingDeg, distanceM, planGlide, pointAlong, projectOnPolyline, splitRoute } from '../lib/geo';
import { glideFrame } from '../components/map/useGlide';
import type { LatLng } from '../lib/types';

const close = (a: LatLng, b: LatLng, m = 1) => expect(distanceM(a, b)).toBeLessThan(m);

// L-shaped route: east 1 km-ish, then north.
const A: LatLng = [13.0, 80.2];
const CORNER: LatLng = [13.0, 80.21];
const B: LatLng = [13.01, 80.21];
const ROUTE: LatLng[] = [A, CORNER, B];

describe('glide math', () => {
  it('bearing: north 0, east 90', () => {
    expect(bearingDeg([13, 80], [13.01, 80])).toBeCloseTo(0, 1);
    expect(bearingDeg([13, 80], [13, 80.01])).toBeCloseTo(90, 0);
  });

  it('linear interpolation midpoint when no route', () => {
    const f = glideFrame(A, CORNER, 0.5);
    close(f.position!, [13.0, 80.205]);
    expect(f.heading!).toBeCloseTo(90, 0);
    close(glideFrame(A, CORNER, 0).position!, A);
    close(glideFrame(A, CORNER, 1).position!, CORNER);
  });

  it('projects onto a polyline', () => {
    const p = projectOnPolyline([13.0005, 80.205], ROUTE)!;
    expect(p.index).toBe(0);
    expect(p.distM).toBeGreaterThan(40);
    expect(p.distM).toBeLessThan(70);
    close(p.point, [13.0, 80.205]);
  });

  it('follows the route around the corner instead of cutting it', () => {
    const from: LatLng = [13.0, 80.205];
    const to: LatLng = [13.005, 80.21];
    const path = planGlide(from, to, ROUTE);
    expect(path).toHaveLength(3);
    close(path[1], CORNER);
    // At t = leg1 / (leg1 + leg2) the marker is exactly at the corner.
    const leg1 = distanceM(from, CORNER), leg2 = distanceM(CORNER, to);
    const atCorner = glideFrame(from, to, leg1 / (leg1 + leg2), ROUTE);
    close(atCorner.position!, CORNER, 1);
    // Second half heads north.
    expect(glideFrame(from, to, 0.75, ROUTE).heading!).toBeCloseTo(0, 0);
  });

  it('falls back to a straight line when off-route or moving backwards', () => {
    expect(planGlide([13.003, 80.205], B, ROUTE)).toHaveLength(2); // ~330 m off route
    expect(planGlide([13.005, 80.21], [13.0, 80.205], ROUTE)).toHaveLength(2); // backwards
  });

  it('pointAlong clamps t and handles degenerate paths', () => {
    close(pointAlong(ROUTE, -1).position, A);
    close(pointAlong(ROUTE, 2).position, B);
    expect(pointAlong([A], 0.5).heading).toBeNull();
    expect(pointAlong([A, A], 0.5).heading).toBeNull();
  });

  it('splits a route into travelled / remaining at the vehicle', () => {
    const [done, rest] = splitRoute(ROUTE, [13.002, 80.21]);
    close(done[0], A);
    close(done[done.length - 1], [13.002, 80.21], 2);
    close(rest[rest.length - 1], B);
    expect(splitRoute(ROUTE, null)).toEqual([[], ROUTE]);
  });
});
