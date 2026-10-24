import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';

const patched: [string, unknown][] = [];
const FLEET = {
  hospital_id: 4,
  stations: [{
    id: 9, name: 'Adyar bay', is_active: true, ambulances: [
      { id: 21, registration_number: 'TN09AB0001', kind: 'ALS', status: 'available', staffed: true, station_id: 9, location_age_s: 12 },
      { id: 22, registration_number: 'TN09AB0002', kind: 'BLS', status: 'en_route', staffed: true, station_id: 9, location_age_s: 3 },
    ],
  }],
};
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  get: async () => FLEET,
  patch: async (path: string, body: unknown) => {
    patched.push([`PATCH ${path}`, body]);
    return { ...FLEET.stations[0].ambulances[0], status: 'maintenance' };
  },
}));

import { FleetPanel } from '../pages/hospital/FleetPanel';

describe('<FleetPanel> (FR2: hospital staff manage their own fleet)', () => {
  it('lists each station with its ambulances and live status', async () => {
    render(<ToastProvider><FleetPanel hid={4} /></ToastProvider>);
    const row = (await screen.findByText('TN09AB0001')).closest('li')!;
    expect(within(row).getByText(/available/i)).toBeTruthy();
    expect(screen.getByText('Adyar bay')).toBeTruthy();
  });

  it('puts an idle unit into maintenance; a unit on a trip cannot be taken out', async () => {
    render(<ToastProvider><FleetPanel hid={4} /></ToastProvider>);
    const idle = (await screen.findByText('TN09AB0001')).closest('li')!;
    fireEvent.click(within(idle).getByRole('button', { name: /maintenance/i }));
    await waitFor(() => expect(patched).toContainEqual(['PATCH /hospitals/4/ambulances/21', { maintenance: true }]));
    const busy = screen.getByText('TN09AB0002').closest('li')!;
    expect((within(busy).getByRole('button', { name: /maintenance/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(busy).getByRole('switch').getAttribute('aria-disabled') === 'true'
      || (within(busy).getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  });
});
