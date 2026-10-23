import { describe, expect, it } from 'vitest';
import type { Board, RequestOut } from '../../lib/types';
import { ageSeconds, boardKpis, escalatedRequests, fleetBucket, reduceBoard, sortActive, sortEscalations, type LiveBoard } from './board';

const req = (id: number, over: Partial<RequestOut> = {}): RequestOut => ({
  id, status: 'en_route', incident_type: 'cardiac', severity: 3, lat: 13, lng: 80, created_at: '2026-10-14T10:00:00Z', ...over,
});

const mkBoard = (over: Partial<Board> = {}): Board => ({
  requests: [req(1, { ambulance: { id: 10, registration_number: 'TN-01' }, eta_seconds: 300, match_duration_ms: 100 }), req(2, { status: 'awaiting_manual', match_duration_ms: 300 })],
  ambulances: [
    { id: 10, registration_number: 'TN-01', status: 'en_route', lat: 13, lng: 80, request_id: 1 },
    { id: 11, registration_number: 'TN-02', status: 'available', lat: 13.1, lng: 80.1 },
    { id: 12, registration_number: 'TN-03', status: 'offline' },
  ],
  stations: [],
  hospitals: [{ id: 5, name: 'Apollo', lat: 13, lng: 80, available_beds: 4, available_icu: 1, stale: true, capacity_age_min: 90 }],
  escalations: [2],
  ...over,
});
const live = (b = mkBoard()): LiveBoard => ({ board: b, routes: {} });

describe('reduceBoard', () => {
  it('moves an ambulance and updates the request ETA on ambulance.location', () => {
    const r = reduceBoard(live(), { type: 'ambulance.location', data: { ambulance_id: 10, lat: 13.01, lng: 80.02, heading_deg: 90, request_id: 1, eta_seconds: 120 } });
    const a = r.state.board.ambulances.find((x) => x.id === 10)!;
    expect([a.lat, a.lng, a.heading_deg, a.location_age_s]).toEqual([13.01, 80.02, 90, 0]);
    expect(r.state.board.requests[0].eta_seconds).toBe(120);
    expect(r.reload).toBe(false);
  });

  it('asks for a reload when an unknown ambulance pings', () => {
    expect(reduceBoard(live(), { type: 'ambulance.location', data: { ambulance_id: 99, lat: 1, lng: 2 } }).reload).toBe(true);
  });

  it('updates status, appends to timeline and clears escalation on request.status', () => {
    const r = reduceBoard(live(), { type: 'request.status', data: { request_id: 2, status: 'offered' }, ts: '2026-10-14T10:01:00Z' });
    const q = r.state.board.requests.find((x) => x.id === 2)!;
    expect(q.status).toBe('offered');
    expect(q.timeline?.[q.timeline.length - 1]).toEqual({ status: 'offered', at: '2026-10-14T10:01:00Z' });
    expect(r.state.board.escalations).toEqual([]);
  });

  it('reloads when request.status assigns a new unit', () => {
    expect(reduceBoard(live(), { type: 'request.status', data: { request_id: 2, status: 'offered', ambulance_id: 11 } }).reload).toBe(true);
  });

  it('removes terminal requests and their routes', () => {
    const s = live();
    s.routes[1] = { phase: 'to_patient', polyline: [[1, 2], [3, 4]], distance_km: 1, eta_seconds: 60 };
    const r = reduceBoard(s, { type: 'request.status', data: { request_id: 1, status: 'completed' } });
    expect(r.state.board.requests.map((x) => x.id)).toEqual([2]);
    expect(r.state.routes[1]).toBeUndefined();
  });

  it('adds escalations and reports them on dispatch.escalated', () => {
    const b = mkBoard({ escalations: [] });
    const r = reduceBoard(live(b), { type: 'dispatch.escalated', data: { request_id: 1 } });
    expect(r.escalated).toBe(1);
    expect(r.state.board.escalations).toEqual([1]);
    expect(r.state.board.requests[0].status).toBe('awaiting_manual');
    expect(reduceBoard(live(b), { type: 'dispatch.escalated', data: { request_id: 77 } }).reload).toBe(true);
  });

  it('stores routes from request.route', () => {
    const r = reduceBoard(live(), { type: 'request.route', data: { request_id: 1, phase: 'to_hospital', polyline: [[1, 2], [3, 4]], eta_seconds: 90, distance_km: 2 } });
    expect(r.state.routes[1].phase).toBe('to_hospital');
    expect(r.state.board.requests[0].eta_seconds).toBe(90);
  });

  it('refreshes hospital capacity on capacity.updated', () => {
    const r = reduceBoard(live(), { type: 'capacity.updated', data: { id: 5, available_beds: 9, available_icu: 3, stale: false } });
    expect(r.state.board.hospitals[0]).toMatchObject({ available_beds: 9, available_icu: 3, stale: false, capacity_age_min: 0 });
  });

  it('ignores unknown events without changing state', () => {
    const s = live();
    expect(reduceBoard(s, { type: 'something.else', data: {} }).state).toBe(s);
  });
});

describe('sorting & KPIs', () => {
  it('sorts escalations by severity desc then oldest first', () => {
    const list = [
      req(1, { severity: 3, created_at: '2026-10-14T10:00:00Z' }),
      req(2, { severity: 5, created_at: '2026-10-14T10:05:00Z' }),
      req(3, { severity: 3, created_at: '2026-10-14T09:00:00Z' }),
    ];
    expect(sortEscalations(list).map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it('pins escalations, then matching, then live trips', () => {
    const list = [req(1, { severity: 5 }), req(2, { status: 'matching', severity: 1 }), req(3, { severity: 1 })];
    expect(sortActive(list, [3]).map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it('computes KPIs', () => {
    expect(boardKpis(mkBoard())).toEqual({ active: 2, available: 1, fleet: 2, avgMatchMs: 200, escalations: 1 });
    expect(escalatedRequests(mkBoard({ escalations: [] })).map((r) => r.id)).toEqual([2]); // falls back to status
  });

  it('computes ages and fleet buckets', () => {
    expect(ageSeconds(req(1), Date.parse('2026-10-14T10:01:30Z'))).toBe(90);
    expect([fleetBucket('available'), fleetBucket('en_route'), fleetBucket('maintenance')]).toEqual(['available', 'busy', 'offline']);
  });
});
