import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { busiestHour } from '../pages/hospital/AreaDemandPanel';

const AREA = {
  hospital_id: 4, hour: 9, radius_km: 5, model_version: 'v3', demographics_source: 'synthetic',
  zones: [
    { zone_id: '1_1', zone_label: 'Adyar', distance_km: 1.2, expected_demand: 0.42, risk: 0.9, households: 12000, senior_share: 0.14 },
    { zone_id: '1_2', zone_label: 'Besant Nagar', distance_km: 3.4, expected_demand: 0.2, risk: 0.5, households: 8000, senior_share: 0.18 },
  ],
  by_hour: Array.from({ length: 24 }, (_, h) => ({ hour: h, expected_demand: h === 19 ? 3.1 : 1 })),
};
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), get: async () => AREA }));

import { AreaDemandPanel } from '../pages/hospital/AreaDemandPanel';

describe('busiestHour', () => {
  it('finds the peak hour', () => {
    expect(busiestHour(AREA.by_hour)).toEqual({ hour: 19, expected_demand: 3.1 });
    expect(busiestHour([])).toBeNull();
  });
});

describe('<AreaDemandPanel>', () => {
  it('shows the busiest zones nearby, the peak hour, and says the population data is an estimate', async () => {
    render(<AreaDemandPanel hid={4} />);
    expect(await screen.findByText('Adyar')).toBeTruthy();
    expect(screen.getByText(/1\.2 km/)).toBeTruthy();
    expect(screen.getByText(/14% aged 60\+/)).toBeTruthy();
    expect(screen.getByText(/busiest around 19:00/i)).toBeTruthy();
    expect(screen.getByText(/synthetic estimate/i)).toBeTruthy();
  });
});
