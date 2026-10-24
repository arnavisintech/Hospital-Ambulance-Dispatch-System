import { describe, expect, it } from 'vitest';
import { AGE_OPTIONS, applyLiveEvent, buildSosBody, isCancellable, pickEta, reachedAt, receiptMessage, tripHeadline, tripStage, tripTimes } from '../pages/requester/trip';

describe('tripStage', () => {
  it('maps statuses to screens', () => {
    expect(tripStage('received')).toBe('searching');
    expect(tripStage('matching')).toBe('searching');
    expect(tripStage('offered')).toBe('searching');
    expect(tripStage('awaiting_manual')).toBe('searching');
    expect(tripStage('accepted')).toBe('live');
    expect(tripStage('transporting')).toBe('live');
    expect(tripStage('arrived')).toBe('live');
    expect(tripStage('completed')).toBe('completed');
    expect(tripStage('cancelled')).toBe('cancelled');
    expect(tripStage('failed')).toBe('cancelled');
    expect(tripStage('teleporting')).toBe('live');
  });
});

describe('isCancellable', () => {
  it('allows cancel until the patient is on board', () => {
    for (const s of ['received', 'matching', 'offered', 'awaiting_manual', 'accepted', 'en_route', 'on_scene']) expect(isCancellable(s)).toBe(true);
    for (const s of ['transporting', 'arrived', 'completed', 'cancelled', 'failed']) expect(isCancellable(s)).toBe(false);
  });
});

describe('tripHeadline', () => {
  it('shows arrival ETA while the ambulance is coming', () => {
    expect(tripHeadline('en_route', 240).title).toBe('Arriving in 4 min');
    expect(tripHeadline('accepted', 30).title).toBe('Arriving now');
    expect(tripHeadline('en_route', null).title).toBe('Arriving soon');
  });
  it('names the hospital after pickup', () => {
    const h = tripHeadline('transporting', 600, 'Apollo Greams Road');
    expect(h.title).toBe('On the way to Apollo Greams Road');
    expect(h.subtitle).toBe('Reaching in 10 min');
    expect(h.tone).toBe('orange');
    expect(tripHeadline('transporting', null).title).toBe('On the way to the hospital');
    expect(tripHeadline('arrived', null, 'MIOT').title).toBe('Reached MIOT');
  });
  it('covers the remaining states', () => {
    expect(tripHeadline('on_scene', 0).title).toBe('Reached you');
    expect(tripHeadline('matching', null).title).toMatch(/Finding the nearest ambulance/);
    expect(tripHeadline('completed', null, 'MIOT').subtitle).toContain('MIOT');
    expect(tripHeadline('mystery', null).title).toBe('Mystery');
  });
});

describe('pickEta', () => {
  it('returns the first usable value', () => {
    expect(pickEta(undefined, null, NaN, -1, 120, 60)).toBe(120);
    expect(pickEta(0, 30)).toBe(0);
    expect(pickEta(null, undefined)).toBeNull();
  });
});

describe('applyLiveEvent', () => {
  it('moves the ambulance and updates ETA without a refetch', () => {
    const r = applyLiveEvent({ route: { phase: 'to_patient', polyline: [[0, 0], [1, 1]], distance_km: 2, eta_seconds: 300 } },
      { type: 'ambulance.location', data: { lat: 13.1, lng: 80.2, heading_deg: 90, eta_seconds: 200 } });
    expect(r.refetch).toBe(false);
    expect(r.overlay.ambulance).toEqual({ lat: 13.1, lng: 80.2, heading: 90 });
    expect(r.overlay.eta).toBe(200);
    expect(r.overlay.route?.eta_seconds).toBe(200);
  });
  it('keeps the last heading when a ping has none and ignores malformed pings', () => {
    const a = applyLiveEvent({ ambulance: { lat: 1, lng: 1, heading: 45 } }, { type: 'ambulance.location', data: { lat: 2, lng: 2 } });
    expect(a.overlay.ambulance?.heading).toBe(45);
    const b = applyLiveEvent({}, { type: 'ambulance.location', data: { lat: 'x' } });
    expect(b.overlay).toEqual({});
  });
  it('replaces the route on request.route', () => {
    const r = applyLiveEvent({}, { type: 'request.route', data: { phase: 'to_hospital', polyline: [[1, 2], [3, 4]], eta_seconds: 500, distance_km: 4.2 } });
    expect(r.overlay.route).toEqual({ phase: 'to_hospital', polyline: [[1, 2], [3, 4]], eta_seconds: 500, distance_km: 4.2 });
    expect(r.overlay.eta).toBe(500);
    expect(r.refetch).toBe(false);
  });
  it('refetches on status and unknown events, not on control frames', () => {
    const s = applyLiveEvent({}, { type: 'request.status', data: { status: 'on_scene' } });
    expect(s.refetch).toBe(true);
    expect(s.overlay.status).toBe('on_scene');
    expect(applyLiveEvent({}, { type: 'trip.closed', data: {} }).refetch).toBe(true);
    expect(applyLiveEvent({}, { type: 'subscribed', data: {} }).refetch).toBe(false);
  });
});

describe('tripTimes', () => {
  const timeline = [
    { status: 'received', at: '2026-10-14T10:00:00Z' },
    { status: 'accepted', at: '2026-10-14T10:00:20Z' },
    { status: 'on_scene', at: '2026-10-14T10:08:30Z' },
    { status: 'transporting', at: '2026-10-14T10:15:00Z' },
    { status: 'arrived', at: '2026-10-14T10:30:00Z' },
    { status: 'completed', at: '2026-10-14T10:35:00Z' },
  ];
  it('derives response and total time from the timeline', () => {
    const t = tripTimes({ created_at: '2026-10-14T10:00:00Z' }, timeline);
    expect(t.responseS).toBe(510);
    expect(t.totalS).toBe(2100);
    expect(t.pickedUpAt).toBe('2026-10-14T10:15:00Z');
    expect(t.assignedAt).toBe('2026-10-14T10:00:20Z');
  });
  it('degrades when the timeline is missing', () => {
    const t = tripTimes({ created_at: '2026-10-14T10:00:00Z', completed_at: '2026-10-14T10:20:00Z' });
    expect(t.responseS).toBeNull();
    expect(t.totalS).toBe(1200);
    expect(reachedAt(undefined, 'on_scene')).toBeNull();
  });
});

describe('buildSosBody', () => {
  const base = { uuid: 'u-1', center: [13.08, 80.27] as [number, number], type: 'cardiac', severity: 4, notes: '  ' };
  it('defaults the optional age group to unknown and trims empty notes', () => {
    expect(buildSosBody(base)).toEqual({
      client_uuid: 'u-1', lat: 13.08, lng: 80.27, address: undefined, incident_type: 'cardiac', severity: 4,
      notes: undefined, channel: 'app', patient_age_group: 'unknown',
    });
  });
  it('passes the chosen age group through', () => {
    expect(buildSosBody({ ...base, age: 'elderly', notes: 'gate 2', address: 'Adyar' })).toMatchObject({
      patient_age_group: 'elderly', notes: 'gate 2', address: 'Adyar',
    });
  });
  it('offers four age choices ending with "Not sure"', () => {
    expect(AGE_OPTIONS.map((o) => o.value)).toEqual(['child', 'adult', 'senior', 'unknown']);
  });
});

describe('receiptMessage (UC-1 step 6)', () => {
  it('states the estimated wait in whole minutes, at least one', () => {
    expect(receiptMessage(7, 420)).toBe('Request #7 received · nearest ambulance about 7 min away');
    expect(receiptMessage(7, 20)).toBe('Request #7 received · nearest ambulance about 1 min away');
  });
  it('promises no number when no ambulance is free', () => {
    expect(receiptMessage(9, null)).toBe('Request #9 received · finding you an ambulance now');
    expect(receiptMessage(9, undefined)).toBe('Request #9 received · finding you an ambulance now');
  });
});
