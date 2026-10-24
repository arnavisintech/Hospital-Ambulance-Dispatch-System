import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';

const calls: [string, unknown][] = [];
const downloads: [string, unknown][] = [];
const ROW = {
  request_id: 501, trip_id: 9, created_at: '2026-10-20T09:00:00+00:00', completed_at: '2026-10-20T09:40:00+00:00',
  status: 'completed', incident_type: 'cardiac', severity: 4, ambulance: 'TN09AB0001', station_id: 3, station_name: 'Adyar bay',
  destination_hospital: 'Apollo Adyar', delivered_here: true, own_fleet: true, response_time_seconds: 480,
  handover_time: '2026-10-20T09:35:00+00:00', distance_km: 6.5, closed_manually: false, amount: 900, payment_status: 'paid',
  insurance_claim_status: null,
};
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 7, name: 'Staff', role: 'hospital_staff', email: 's@x.in', hospital_id: 4 }, loading: false }),
}));
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async (path: string, query?: unknown) => {
    calls.push([path, query]);
    if (path.endsWith('/fleet')) return { hospital_id: 4, stations: [{ id: 3, name: 'Adyar bay', is_active: true, ambulances: [] }] };
    return { total: 1, limit: 50, offset: 0, items: [ROW] };
  },
  fetchFile: async (path: string, query: unknown) => { downloads.push([path, query]); return { blob: new Blob(['%PDF-']), filename: 'x.pdf' }; },
  saveBlob: () => undefined,
}));

import Records from '../pages/hospital/Records';

const renderPage = () => render(<ToastProvider><MemoryRouter><Records /></MemoryRouter></ToastProvider>);

describe('<Records> (UR2 search, UR4 PDF)', () => {
  it('lists past trips with request number, station and outcome', async () => {
    renderPage();
    const row = (await screen.findByText('#501')).closest('tr')!;
    expect(within(row).getByText('Adyar bay')).toBeTruthy();
    expect(within(row).getByText(/cardiac/i)).toBeTruthy();
  });

  it('searches by date range, station and request number', async () => {
    renderPage();
    await screen.findByText('#501');
    fireEvent.change(screen.getByLabelText(/^from/i), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText(/^to/i), { target: { value: '2026-10-31' } });
    fireEvent.change(screen.getByLabelText(/^station/i), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/request number/i), { target: { value: '501' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
    await waitFor(() => expect(calls).toContainEqual(['/hospitals/4/records',
      { date_from: '2026-10-01', date_to: '2026-10-31', station_id: '3', request_id: '501', limit: 50, offset: 0 }]));
  });

  it('downloads the selected station history as a PDF for the chosen period', async () => {
    renderPage();
    await screen.findByText('#501');
    fireEvent.change(screen.getByLabelText(/^station/i), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText(/^from/i), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: /^search$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /station history \(pdf\)/i }));
    await waitFor(() => expect(downloads).toContainEqual(['/hospitals/4/stations/3/history.pdf', { date_from: '2026-10-01', date_to: '' }]));
  });
});
