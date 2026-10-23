import { describe, expect, it } from 'vitest';
import {
  ArrowUp, ArrowUpLeft, ArrowUpRight, CornerUpLeft, CornerUpRight, Flag, Merge, Navigation2, RotateCw, Split, Undo2,
} from 'lucide-react';
import { crewAction, crewPhase, maneuverIcon, maneuverText, nextManeuver, offerWindowS } from '../pages/crew/nav';
import type { LatLng, RouteStep } from '../lib/types';

describe('maneuverIcon', () => {
  it('maps OSRM type/modifier to lucide arrows', () => {
    expect(maneuverIcon({ type: 'turn', modifier: 'left' })).toBe(CornerUpLeft);
    expect(maneuverIcon({ type: 'turn', modifier: 'sharp right' })).toBe(CornerUpRight);
    expect(maneuverIcon({ type: 'continue', modifier: 'slight left' })).toBe(ArrowUpLeft);
    expect(maneuverIcon({ type: 'new name', modifier: 'slight right' })).toBe(ArrowUpRight);
    expect(maneuverIcon({ type: 'continue', modifier: 'uturn' })).toBe(Undo2);
    expect(maneuverIcon({ type: 'arrive' })).toBe(Flag);
    expect(maneuverIcon({ type: 'depart', modifier: 'left' })).toBe(Navigation2);
    expect(maneuverIcon({ type: 'roundabout', modifier: 'right' })).toBe(RotateCw);
    expect(maneuverIcon({ type: 'exit roundabout' })).toBe(RotateCw);
    expect(maneuverIcon({ type: 'merge', modifier: 'left' })).toBe(Merge);
    expect(maneuverIcon({ type: 'fork' })).toBe(Split);
    expect(maneuverIcon({ type: 'fork', modifier: 'slight left' })).toBe(ArrowUpLeft);
    expect(maneuverIcon({ type: 'continue', modifier: 'straight' })).toBe(ArrowUp);
    expect(maneuverIcon(null)).toBe(ArrowUp);
  });
  it('describes the maneuver in words', () => {
    expect(maneuverText({ type: 'turn', modifier: 'left' })).toBe('Turn left');
    expect(maneuverText({ type: 'turn', modifier: 'slight right' })).toBe('Bear right');
    expect(maneuverText({ type: 'turn', modifier: 'sharp left' })).toBe('Sharp left');
    expect(maneuverText({ type: 'continue', modifier: 'uturn' })).toBe('Make a U-turn');
    expect(maneuverText({ type: 'fork', modifier: 'slight left' })).toBe('Keep left');
    expect(maneuverText({ type: 'arrive' })).toBe('Arrive');
    expect(maneuverText(undefined)).toBe('Continue straight');
  });
});

describe('nextManeuver', () => {
  // Straight line north along a meridian: ~111 m per 0.001 deg.
  const line: LatLng[] = [[13.0, 80.0], [13.001, 80.0], [13.002, 80.0], [13.003, 80.0]];
  const steps: RouteStep[] = [
    { instruction: 'Head north', lat: 13.0, lng: 80.0, distance_m: 111, maneuver: { type: 'depart' } },
    { instruction: 'Turn left', lat: 13.001, lng: 80.0, distance_m: 111, maneuver: { type: 'turn', modifier: 'left' }, name: 'Anna Salai' },
    { instruction: 'Turn right', lat: 13.002, lng: 80.0, distance_m: 111, maneuver: { type: 'turn', modifier: 'right' } },
    { instruction: 'Arrive', lat: 13.003, lng: 80.0, distance_m: 0, maneuver: { type: 'arrive' } },
  ];
  it('skips depart and measures distance along the route', () => {
    const n = nextManeuver(steps, line, [13.0, 80.0])!;
    expect(n.index).toBe(1);
    expect(n.step.name).toBe('Anna Salai');
    expect(n.distanceM).toBeGreaterThan(105);
    expect(n.distanceM).toBeLessThan(117);
  });
  it('advances as the vehicle passes maneuver points', () => {
    expect(nextManeuver(steps, line, [13.0015, 80.0])!.index).toBe(2);
    expect(nextManeuver(steps, line, [13.0029, 80.0])!.index).toBe(3);
    // Past the end: still the arrival step, 0 m.
    const end = nextManeuver(steps, line, [13.004, 80.0])!;
    expect(end.index).toBe(3);
    expect(end.distanceM).toBe(0);
  });
  it('degrades without a polyline or steps', () => {
    expect(nextManeuver([], line, null)).toBeNull();
    expect(nextManeuver(steps, [], null)!.index).toBe(1);
  });
});

describe('crew status flow', () => {
  it('is forward-only and stops at hospital', () => {
    expect(crewAction('accepted')?.next).toBe('en_route');
    expect(crewAction('en_route')?.next).toBe('on_scene');
    expect(crewAction('on_scene')?.next).toBe('transporting');
    expect(crewAction('transporting')?.next).toBe('arrived');
    expect(crewAction('arrived')).toBeNull();
    expect(crewAction('completed')).toBeNull();
  });
  it('knows the leg', () => {
    expect(crewPhase('en_route')).toBe('to_patient');
    expect(crewPhase('transporting')).toBe('to_hospital');
  });
  it('computes the offer window', () => {
    expect(offerWindowS('2026-10-14T10:00:00Z', '2026-10-14T10:00:45Z')).toBe(45);
    expect(offerWindowS(null, '2026-10-14T10:00:45Z')).toBe(30);
    expect(offerWindowS('bad', 'worse', 20)).toBe(20);
  });
});
