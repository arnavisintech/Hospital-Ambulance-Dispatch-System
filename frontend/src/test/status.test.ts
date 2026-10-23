import { describe, expect, it } from 'vitest';
import {
  ambulanceStatusMeta, genericStatusMeta, incidentMeta, INCIDENT_KEYS, isLiveTrip, PROGRESS_STEPS, progressIndex,
  REQUEST_STATUSES, requestStatusMeta, severityMeta, toneClasses,
} from '../lib/status';

describe('request status', () => {
  it('maps every contract status to label, tone and icon', () => {
    for (const s of REQUEST_STATUSES) {
      const m = requestStatusMeta(s);
      expect(m.label).toBeTruthy();
      expect(m.headline).toBeTruthy();
      expect(m.icon).toBeTruthy();
      expect(toneClasses(m.tone).soft).toMatch(/bg-/);
    }
  });
  it('uses the design-system colours', () => {
    expect(requestStatusMeta('en_route').tone).toBe('info');
    expect(requestStatusMeta('on_scene').tone).toBe('violet');
    expect(requestStatusMeta('transporting').tone).toBe('orange');
    expect(requestStatusMeta('arrived').tone).toBe('teal');
    expect(requestStatusMeta('completed').tone).toBe('success');
    expect(requestStatusMeta('awaiting_manual').tone).toBe('danger');
    expect(requestStatusMeta('offered').tone).toBe('warning');
  });
  it('degrades gracefully for unknown values', () => {
    const m = requestStatusMeta('teleporting');
    expect(m.label).toBe('Teleporting');
    expect(m.tone).toBe('neutral');
    expect(requestStatusMeta(undefined).label).toBe('Unknown');
  });
  it('computes ProgressSteps index', () => {
    expect(PROGRESS_STEPS).toHaveLength(4);
    expect(progressIndex('matching')).toBe(-1);
    expect(progressIndex('accepted')).toBe(0);
    expect(progressIndex('en_route')).toBe(1);
    expect(progressIndex('on_scene')).toBe(1);
    expect(progressIndex('transporting')).toBe(2);
    expect(progressIndex('arrived')).toBe(3);
    expect(progressIndex('completed')).toBe(4);
    expect(progressIndex('cancelled')).toBe(-1);
  });
  it('flags searching and live trips', () => {
    expect(requestStatusMeta('matching').searching).toBe(true);
    expect(isLiveTrip('en_route')).toBe(true);
    expect(isLiveTrip('completed')).toBe(false);
    expect(isLiveTrip('received')).toBe(false);
  });
});

describe('ambulance / generic status', () => {
  it('maps ambulance statuses incl. aliases', () => {
    expect(ambulanceStatusMeta('available').tone).toBe('success');
    expect(ambulanceStatusMeta('assigned').tone).toBe('warning');
    expect(ambulanceStatusMeta('offline').online).toBe(false);
    expect(ambulanceStatusMeta('busy').key).toBe('transporting');
    expect(ambulanceStatusMeta('???').key).toBe('offline');
  });
  it('maps generic statuses', () => {
    expect(genericStatusMeta('paid').tone).toBe('success');
    expect(genericStatusMeta('rejected').tone).toBe('danger');
    expect(genericStatusMeta('in_review').label).toBe('In review');
  });
});

describe('severity & incidents', () => {
  it('labels severity in words and clamps', () => {
    expect(severityMeta(1).label).toBe('Mild');
    expect(severityMeta(4).label).toBe('Critical');
    expect(severityMeta(5).label).toBe('Life-threatening');
    expect(severityMeta(9).level).toBe(5);
    expect(severityMeta(0).level).toBe(1);
    expect(severityMeta(null).level).toBe(1);
  });
  it('has a label + icon for every incident type', () => {
    for (const k of INCIDENT_KEYS) expect(incidentMeta(k).icon).toBeTruthy();
    expect(incidentMeta('cardiac').label).toBe('Heart / chest pain');
    expect(incidentMeta('snake_bite').label).toBe('Snake bite');
  });
});
